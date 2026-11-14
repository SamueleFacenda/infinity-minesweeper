import { Board } from "./game/board.js";
import type { Cell } from "./game/coords.js";
import type { EngineSnapshot } from "./game/snapshot.js";

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
}

export function handleEngineMessage(
  session: EngineSession,
  message: EngineMessage,
): readonly EngineReply[] {
  const { gameId, request } = message;
  switch (request.kind) {
    case "new": {
      session.board = new Board(request.seed, request.density);
      const board = requireBoard(session);
      return [stateReply(board, gameId), ...withPrepare(board, gameId)];
    }
    case "reveal": {
      const board = requireBoard(session);
      board.reveal(request.x, request.y);
      return [stateReply(board, gameId), ...withPrepare(board, gameId)];
    }
    case "chord": {
      const board = requireBoard(session);
      board.clickNumber(request.x, request.y);
      return [stateReply(board, gameId), ...withPrepare(board, gameId)];
    }
    case "flag": {
      const board = requireBoard(session);
      const wasFlagged = board.isFlagged(request.x, request.y);
      board.toggleFlag(request.x, request.y);
      const placed = board.isFlagged(request.x, request.y);
      const reply =
        placed === wasFlagged
          ? stateReply(board, gameId)
          : stateReply(board, gameId, {
              flag: { x: request.x, y: request.y, placed },
            });
      return [reply, ...withPrepare(board, gameId)];
    }
    case "free": {
      const board = requireBoard(session);
      const cell = board.freeCell();
      return [
        stateReply(board, gameId, { freeCell: cell }),
        ...withPrepare(board, gameId),
      ];
    }
    case "hint": {
      const board = requireBoard(session);
      return [{ kind: "hint", gameId, hint: board.findHint() }];
    }
  }
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

// why: the search runs to completion in the worker — there is no frame to
// protect there — so the idle slicing the main thread needed is gone and
// the next click on the searched cell adopts the result instead of paying
// for a second search
function withPrepare(board: Board, gameId: number): readonly EngineReply[] {
  const target = board.nextRevealTarget();
  if (target === null) {
    board.prepareNext(null);
    return [];
  }
  board.prepareNext(target);
  if (!board.hasPendingPrepare()) return [];
  board.advancePrepare(Number.POSITIVE_INFINITY);
  if (board.hasPendingPrepare()) return [];
  return board.hasPrepared(target.x, target.y)
    ? [{ kind: "prepared", gameId, x: target.x, y: target.y }]
    : [];
}
