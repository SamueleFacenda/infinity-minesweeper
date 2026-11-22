import { Board } from "./game/board.js";
import { keyOf, neighborCoords } from "./game/coords.js";
import type { Cell } from "./game/coords.js";
import type { EngineSnapshot } from "./game/snapshot.js";
import type { SearchPool } from "./searchPool.js";

// why: a slice of the precompute is bounded so a request that arrives while
// the search runs is answered at once instead of waiting for the whole
// search; off-thread there is no frame to protect, only input latency
const PREPARE_SLICE_MS = 12;

// why: the first candidate of a reveal usually accepts on the deep tiers,
// so one short single-threaded search on the engine thread answers most
// reveals without paying for the pool; a board whose frozen mass leaves no
// candidate reaching the floor instead exhausts the attempt budget, which
// the pool splits across its slots, so the fast path stays short enough
// that such a state hands over early
const FAST_SEARCH_MS = 80;

// The engine runs single-owner inside a worker: it answers requests with
// snapshots. Every soundness invariant (frozen quotas, nonce-coupled
// re-rolls) lives inside Board and never crosses the thread boundary —
// only the read-only view does. The handler is a plain function so the
// same code drives the worker and the in-process fallback client.

export type EngineRequest =
  | { readonly kind: "new"; readonly seed: number; readonly density: number }
  | { readonly kind: "reveal"; readonly x: number; readonly y: number }
  | { readonly kind: "chord"; readonly x: number; readonly y: number }
  | { readonly kind: "flag"; readonly x: number; readonly y: number }
  | { readonly kind: "free" }
  | { readonly kind: "hint" };

// the requests a player action produces; "new" is a lifecycle call and
// "hint" reads without mutating
export type EngineAction = Extract<
  EngineRequest,
  { readonly kind: "reveal" | "chord" | "flag" | "free" }
>;

export interface FlagPlacement {
  readonly x: number;
  readonly y: number;
  readonly placed: boolean;
}

export type EngineReply =
  | {
      readonly kind: "state";
      readonly gameId: number;
      readonly snapshot: EngineSnapshot;
      readonly flag?: FlagPlacement;
      readonly freeCell?: Cell | null;
    }
  | {
      readonly kind: "hint";
      readonly gameId: number;
      readonly hint: Cell | null;
    }
  | {
      readonly kind: "prepared";
      readonly gameId: number;
      readonly x: number;
      readonly y: number;
    };

// why: gameId separates games across restarts, so a reply of a superseded
// game is dropped instead of applied over the fresh one
export interface EngineMessage {
  readonly requestId: number;
  readonly gameId: number;
  readonly request: EngineRequest;
}

export interface EngineSession {
  board: Board | null;
  // why: the cell the in-flight precompute searches, kept so the slice that
  // finishes it can report the prepared cell
  prepareCell?: Cell | null;
  // why: the parallel search pool the owning worker runs; absent without
  // worker support, where the single-threaded search runs instead
  pool?: SearchPool | null;
}

// The answer to one request. Deliberately free of the precompute: the
// caller posts this reply before it starts the next prepare search, so the
// reveal the player just made reaches the screen while the precompute of
// the next one is still running.
// why: a reveal searches for its candidate, and the pool searches in
// worker threads, so the handler is async only for that wait; every other
// request answers exactly as before
export async function handleEngineMessage(
  session: EngineSession,
  message: EngineMessage,
): Promise<readonly EngineReply[]> {
  const { gameId, request } = message;
  switch (request.kind) {
    case "new": {
      session.board = new Board(request.seed, request.density);
      return [stateReply(requireBoard(session), gameId)];
    }
    case "reveal": {
      const board = requireBoard(session);
      await revealOne(board, session, request.x, request.y);
      return [stateReply(board, gameId)];
    }
    case "chord": {
      const board = requireBoard(session);
      // why: a chord opens its unknowns as one reveal, and the pooled
      // search searches them together; a chord whose flags do not satisfy
      // the count still lets the board auto-fill its flags
      const cells = chordCells(board, request.x, request.y);
      if (cells === null) {
        board.clickNumber(request.x, request.y);
        return [stateReply(board, gameId)];
      }
      board.lastRevealed = [];
      board.lastFlagged = [];
      await revealCells(board, session, cells);
      return [stateReply(board, gameId)];
    }
    case "flag": {
      const board = requireBoard(session);
      const wasFlagged = board.isFlagged(request.x, request.y);
      board.toggleFlag(request.x, request.y);
      const placed = board.isFlagged(request.x, request.y);
      // why: the board keeps the previous reveal's animation batches until
      // the next reveal resets them, and a flag toggle reveals nothing, so
      // an answer that carried them would replay a ripple that already
      // played
      board.lastRevealed = [];
      board.lastFlagged = [];
      return placed === wasFlagged
        ? [stateReply(board, gameId)]
        : [
            stateReply(board, gameId, {
              flag: { x: request.x, y: request.y, placed },
            }),
          ];
    }
    case "free": {
      const board = requireBoard(session);
      const cell = board.freeCell();
      if (cell === null) return [stateReply(board, gameId)];
      board.lastRevealed = [];
      board.lastFlagged = [];
      await revealCells(board, session, [[cell.x, cell.y]]);
      return [stateReply(board, gameId, { freeCell: cell })];
    }
    case "hint": {
      const board = requireBoard(session);
      return [{ kind: "hint", gameId, hint: board.findHint() }];
    }
  }
}

// Reveals one cell through the pool when the engine owns one: the search
// runs in worker threads and the accepted candidate is adopted wholesale,
// with the same outcome the single-threaded search would have produced.
// Reveals a set of cells through the search: a short single-threaded
// attempt on the engine thread that is adopted only when it certified the
// tier floor, then the pool for the full budget. One path serves a plain
// reveal, a chord's unknowns and a guess zone's free cell, so no reveal
// runs a long serial search on the engine thread.
async function revealCells(
  board: Board,
  session: EngineSession,
  cells: readonly (readonly [number, number])[],
): Promise<void> {
  const pool = session.pool;
  if (pool === null || pool === undefined) {
    board.revealCells(cells);
    return;
  }
  // why: the search runs on a clone first, so a fast path that fails
  // leaves the live board exactly as it was for the pooled attempts
  const deep = board.revealedCount === 0;
  const probe = board.searchClone();
  if (deep) {
    const first = cells[0];
    probe.pinOpening(
      first === undefined ? { x: 0, y: 0 } : { x: first[0], y: first[1] },
    );
  }
  const fast = probe.runPooledSearch(cells, deep, FAST_SEARCH_MS, 0, 1);
  if (fast === "lost") {
    // why: the honest first click can still hit a mine, and a first click
    // is never re-rolled away, so the game ends as it always did
    board.status = "lost";
    board.explodedAt = probe.explodedAt;
    return;
  }
  // why: an exhausted fast search falls back to its best-so-far, which is
  // only the honest outcome of a search that could spend more, so it is
  // adopted only when the candidate actually certified the tier floor and
  // the pooled attempts otherwise take over with the full budget
  if (
    fast === "accepted" &&
    probe.acceptedClosureDepth >= board.closureFloor(deep)
  ) {
    board.adoptSearchResult(probe.searchState());
    return;
  }
  const result = await pool.search(board.pooledSearchRequest(cells, false));
  if (result.outcome === "lost") {
    board.status = "lost";
    board.explodedAt = result.explodedAt;
    return;
  }
  // why: an exhausted pool answers with the honest layout it reached,
  // which is the reveal the single-threaded search would have produced,
  // so a reveal never pays two searches
  if (
    (result.outcome === "accepted" || result.outcome === "committed") &&
    result.state !== undefined
  ) {
    board.adoptSearchResult(result.state);
    return;
  }
  board.revealCells(cells);
}

async function revealOne(
  board: Board,
  session: EngineSession,
  x: number,
  y: number,
): Promise<void> {
  board.lastRevealed = [];
  board.lastFlagged = [];
  if (board.status !== "playing") return;
  if (board.isRevealed(x, y) || board.isFlagged(x, y)) return;
  // why: an idle precompute of exactly this click is adopted as-is, no
  // search at all
  if (board.hasPrepared(x, y)) {
    board.reveal(x, y);
    return;
  }
  await revealCells(board, session, [[x, y]]);
}

// The cells a chord would open, so the pooled search can search them as
// one reveal instead of a serial search on the engine thread.
function chordCells(
  board: Board,
  x: number,
  y: number,
): readonly (readonly [number, number])[] | null {
  const key = keyOf(x, y);
  const count = board.revealedView.get(key);
  if (count === undefined) return null;
  let flagged = 0;
  const unknowns: [number, number][] = [];
  for (const [nx, ny] of neighborCoords(x, y)) {
    if (board.isFlagged(nx, ny)) flagged += 1;
    else if (!board.isRevealed(nx, ny)) unknowns.push([nx, ny]);
  }
  if (flagged !== count || unknowns.length === 0) return null;
  return unknowns;
}

// Starts the precompute of the next reveal target. Costs only a clone and
// a search setup, so it runs on the reply path itself. With a pool the
// search runs in the background and the prepared notification arrives
// through the callback; without one the slice machinery drives it.
export function startPrepare(
  session: EngineSession,
  gameId: number,
  onPrepared?: (reply: EngineReply) => void,
): void {
  const board = session.board;
  if (board === null) return;
  if (board.hasPendingPrepare()) return;
  const pool = session.pool;
  if (pool === null || pool === undefined) {
    const target = board.nextRevealTarget();
    if (target === null) {
      board.prepareNext(null);
      return;
    }
    board.prepareNext(target);
    session.prepareCell = target;
    return;
  }
  // why: every certain move is searched ahead of the click, not just the
  // one perfect play would take, so any of them adopts instantly; the
  // zone's free cell is searched the same way when no move is certain
  const targets = board.preparedTargets();
  if (targets.length === 0) return;
  const version = board.version;
  session.prepareCell = targets[0] ?? null;
  void pool
    .search({
      ...board.pooledSearchRequest(
        targets.map((target) => [target.x, target.y] as const),
        true,
      ),
      perCell: true,
    })
    .then((result) => {
      session.prepareCell = null;
      // why: an exhausted precompute answers with the honest layout, which
      // is what the click's own search would have produced, so it is
      // adopted the same way an accepted candidate is
      if (result.outcome === "lost") return;
      if (result.outcome !== "prepared") return;
      board.storePrepared(
        Object.entries(result.states).map(([key, state]) => ({
          cell: {
            x: Number(key.split(",")[0]),
            y: Number(key.split(",")[1]),
          },
          state,
        })),
        version,
      );
      onPrepared?.({
        kind: "prepared",
        gameId,
        x: targets[0]?.x ?? 0,
        y: targets[0]?.y ?? 0,
      });
      board.storePrepared(
        Object.entries(result.states).map(([key, state]) => ({
          cell: { x: Number(key.split(",")[0]), y: Number(key.split(",")[1]) },
          state,
        })),
        version,
      );
      onPrepared?.({
        kind: "prepared",
        gameId,
        x: targets[0]?.x ?? 0,
        y: targets[0]?.y ?? 0,
      });
    });
}

// One bounded slice of the in-flight precompute, plus the prepared-cell
// notification when the search just finished. The caller keeps calling
// while a job is pending.
export function advancePrepare(
  session: EngineSession,
  gameId: number,
): readonly EngineReply[] {
  if (session.board?.hasPendingPrepare() !== true) return [];
  const board = session.board;
  board.advancePrepare(performance.now() + PREPARE_SLICE_MS);
  if (board.hasPendingPrepare()) return [];
  const cell = session.prepareCell;
  session.prepareCell = null;
  if (cell === undefined || cell === null) return [];
  return board.hasPrepared(cell.x, cell.y)
    ? [{ kind: "prepared", gameId, x: cell.x, y: cell.y }]
    : [];
}

function requireBoard(session: EngineSession): Board {
  const board = session.board;
  if (board === null) throw new Error("engine session has no board");
  return board;
}

function stateReply(
  board: Board,
  gameId: number,
  extra?: {
    readonly flag?: FlagPlacement;
    readonly freeCell?: Cell | null;
  },
): EngineReply {
  return {
    kind: "state",
    gameId,
    snapshot: snapshotOf(board),
    ...extra,
  };
}

function snapshotOf(board: Board): EngineSnapshot {
  const state = board.deductionState();
  return {
    status: board.status,
    explodedAt: board.explodedAt,
    revealed: new Map(board.revealedView),
    flags: new Set(board.flagView),
    lastRevealed: board.lastRevealed,
    lastFlagged: board.lastFlagged,
    certainMove: state.certainMove,
    guessCells: state.guessCells,
    terrain: board.terrainTable(),
  };
}
