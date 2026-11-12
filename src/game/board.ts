import type { Cell } from "./coords.js";
import {
  CHUNK_SIZE,
  chunkKeyOf,
  keyOf,
  neighborCoords,
  parseKey,
} from "./coords.js";
import { enclosedRegions } from "./regions.js";
import { blockQuota, cellHash } from "./rng.js";
import { findSafeCell, solve } from "./solver.js";

export type GameStatus = "playing" | "lost";
export type ClickResult = "lost" | "ok";

export interface DeductionState {
  readonly certainMove: boolean;
  readonly guessCells: readonly Cell[];
  readonly hint: Cell | null;
}

// A reveal the board already searched for while it was idle: the accepted
// candidate's whole state, ready to be adopted on the matching click.
interface PreparedReveal {
  readonly x: number;
  readonly y: number;
  // why: every mutation of the persisted state bumps the version, so a
  // prepared state from before a change can never be adopted
  readonly version: number;
  readonly board: Board;
}

type RevealOutcome = "accepted" | "committed" | "lost";

interface BestCandidate {
  readonly snap: Snapshot;
  readonly revealed: [number, number][];
  readonly score: number;
}

// A candidate whose deterministic playout is half done: the board holds
// the playout's own state, so a slice can stop between its steps and the
// next slice continues from where it stopped.
interface JudgeState {
  readonly revealed: [number, number][];
  readonly before: Snapshot;
  reached: number;
}

interface AttemptSearch {
  readonly cells: readonly [number, number][];
  readonly deep: boolean;
  readonly profile: GenerationProfile;
  readonly snap: Snapshot;
  // why: wall-clock bound of the whole search, so a job driven in slices
  // can never linger past the budget it was given
  readonly deadline: number;
  // why: the point after which judging a candidate stops instead of
  // spending the slice on it; null for the interactive search, which runs
  // to completion with no frame to protect
  limit: number | null;
  attempt: number;
  best: BestCandidate | null;
  fastPathTried: boolean;
  pocketChecks: number;
  judge: JudgeState | null;
}

// A precompute in flight: the clone the search mutates, the search state,
// and the cell the prepared reveal belongs to.
interface PendingPrepare {
  readonly cell: Cell;
  readonly board: Board;
  readonly search: AttemptSearch;
}

// Generation effort per tier. Every reveal re-rolls fresh chunks until
// the checks pass, and the search keeps the candidate whose deterministic
// chain runs deepest instead of the first acceptable one, so harder tiers
// buy longer runs with the generation budget.
interface GenerationProfile {
  // why: an opening must survive a deep deterministic playout, because
  // there the whole chain is still unconstrained and re-rolls can enforce
  // it
  readonly opening: number;
  // why: a candidate that merely reaches one certain move can still walk
  // into a wall; the best-of search prefers the deepest chain it can find
  readonly select: number;
  // why: zero cells open ground by a trivial rule, which is what makes a
  // tier read as easy; the cap tightens as the difficulty rises
  readonly zeroCap: number;
  readonly candidates: number;
  readonly budgetMs: number;
}

const GENERATION_PROFILES: readonly {
  readonly maxDensity: number;
  readonly profile: GenerationProfile;
}[] = [
  {
    maxDensity: 0.15,
    profile: {
      opening: 25,
      select: 15,
      zeroCap: 1,
      candidates: 24,
      budgetMs: 50,
    },
  },
  {
    maxDensity: 0.19,
    profile: {
      opening: 25,
      select: 0,
      zeroCap: 1,
      candidates: 12,
      budgetMs: 40,
    },
  },
  {
    maxDensity: 0.27,
    profile: {
      opening: 30,
      select: 0,
      zeroCap: 1,
      candidates: 16,
      budgetMs: 60,
    },
  },
  {
    maxDensity: 0.32,
    profile: {
      opening: 50,
      select: 25,
      zeroCap: 1,
      candidates: 48,
      budgetMs: 250,
    },
  },
  {
    maxDensity: 0.37,
    profile: {
      opening: 55,
      select: 25,
      zeroCap: 1,
      candidates: 64,
      budgetMs: 400,
    },
  },
  {
    maxDensity: Number.POSITIVE_INFINITY,
    profile: {
      opening: 60,
      select: 30,
      zeroCap: 1,
      candidates: 96,
      budgetMs: 900,
    },
  },
];

function generationProfile(density: number): GenerationProfile {
  const tier = GENERATION_PROFILES.find(
    (candidate) => density <= candidate.maxDensity,
  );
  return tier?.profile ?? EASIEST_PROFILE;
}

const EASIEST_PROFILE: GenerationProfile = {
  opening: 25,
  select: 15,
  zeroCap: 1,
  candidates: 24,
  budgetMs: 50,
};

// why: the pocket closure floods and solves the whole board, so a reveal
// only pays for a bounded number of them; a candidate is never accepted
// without passing the check
const MAX_POCKET_CHECKS = 3;

// why: an idle precompute has no player waiting on it, so it can afford a
// longer search than the interactive one and find a deeper chain
const PREPARE_BUDGET_FACTOR = 2;

function copyInto(
  target: Map<string, number>,
  source: ReadonlyMap<string, number>,
): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function copySetInto(target: Set<string>, source: ReadonlySet<string>): void {
  target.clear();
  for (const value of source) target.add(value);
}

const AREA_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

// Infinite minesweeper board. Mine placement is a pure hash over
// (seed, chunk nonce, coords); chunks are "committed" (nonce frozen) once
// visible to the player. After every reveal the solver verifies that a
// certain move exists and that every enclosed pocket of hidden cells is
// fully deducible; failures re-roll the freshly committed chunks. A board
// that still fails keeps its honest layout and reports the ambiguous
// cells through deductionState instead of hiding them.
export class Board {
  readonly seed: number;
  readonly density: number;
  status: GameStatus = "playing";
  explodedAt: Cell | null = null;
  // cells changed by the most recent reveal / chord auto-fill, for animation
  lastRevealed: readonly (readonly [number, number])[] = [];
  lastFlagged: readonly (readonly [number, number])[] = [];

  private readonly revealedMap = new Map<string, number>();
  private readonly flagSet = new Set<string>();
  private committed = new Set<string>();
  private nonces = new Map<string, number>();
  private pinnedSafe = new Set<string>();
  // why: true only while the opening reveal searches over chunk quotas,
  // so a cramped first click can still find an openable game
  private quotaSearchable = false;
  // why: the quota each chunk settled on, frozen the moment its numbers
  // were shown; a searchable quota that stayed live would silently move
  // mines under numbers the player had already read
  private readonly chunkQuotas = new Map<string, number>();
  private analysis: DeductionState | null = null;
  // why: bumped by every change of the persisted state, so a prepared
  // reveal older than the current version is discarded instead of adopted
  private stateVersion = 0;
  private prepared: PreparedReveal | null = null;
  private pendingPrepare: PendingPrepare | null = null;

  constructor(seed: number, density: number) {
    this.seed = seed;
    this.density = density;
  }

  get revealedCount(): number {
    return this.revealedMap.size;
  }

  get revealedView(): ReadonlyMap<string, number> {
    return this.revealedMap;
  }

  get flaggedCount(): number {
    return this.flagSet.size;
  }

  isRevealed(x: number, y: number): boolean {
    return this.revealedMap.has(keyOf(x, y));
  }

  countAt(x: number, y: number): number | undefined {
    return this.revealedMap.get(keyOf(x, y));
  }

  isFlagged(x: number, y: number): boolean {
    return this.flagSet.has(keyOf(x, y));
  }

  // why: only meaningful after loss, for rendering the surrounding mines
  isMine(x: number, y: number): boolean {
    return this.mineAt(x, y);
  }

  toggleFlag(x: number, y: number): void {
    const key = keyOf(x, y);
    if (this.status !== "playing" || this.revealedMap.has(key)) return;
    this.invalidatePrepared();
    if (this.flagSet.has(key)) {
      this.flagSet.delete(key);
    } else {
      this.flagSet.add(key);
    }
    this.stateVersion++;
  }

  reveal(x: number, y: number): ClickResult {
    if (this.status !== "playing") return "ok";
    const prepared = this.prepared;
    this.invalidatePrepared();
    this.lastRevealed = [];
    this.lastFlagged = [];
    const key = keyOf(x, y);
    if (this.revealedMap.has(key) || this.flagSet.has(key)) return "ok";
    if (this.adoptsPrepared(prepared, x, y)) {
      this.adoptFrom(prepared.board);
      return "ok";
    }
    if (this.revealedMap.size === 0) this.pinArea(x, y);
    return this.revealGroup([[x, y]], this.revealedMap.size === 0);
  }

  // Clicking a revealed number: auto-disclose when the flags satisfy the
  // count (classic chord), auto-fill flags when the remaining unknowns are
  // all mines by simple counting.
  clickNumber(x: number, y: number): ClickResult {
    if (this.status !== "playing") return "ok";
    this.invalidatePrepared();
    this.lastRevealed = [];
    this.lastFlagged = [];
    const count = this.revealedMap.get(keyOf(x, y));
    if (count === undefined) return "ok";
    const { flagged, unknown } = this.inspectNeighbors(x, y);
    if (flagged === count && unknown.length > 0) {
      return this.revealGroup(unknown, false);
    }
    if (count - flagged === unknown.length && unknown.length > 0) {
      const autoFlagged: [number, number][] = [];
      for (const [nx, ny] of unknown) {
        this.flagSet.add(keyOf(nx, ny));
        autoFlagged.push([nx, ny]);
      }
      this.lastFlagged = autoFlagged;
      this.stateVersion++;
    }
    return "ok";
  }

  findHint(): Cell | null {
    const first = findSafeCell(this.revealedMap);
    return first === null ? null : parseKey(first);
  }

  // The cell the next reveal should open: a certain move when deduction
  // found one, otherwise the free cell that escapes the marked zone.
  nextRevealTarget(): Cell | null {
    if (this.status !== "playing") return null;
    const state = this.deductionState();
    return state.certainMove ? state.hint : this.zoneFreeTarget();
  }

  // Deliberate escape from a marked guess zone: the layout is fixed, so a
  // cell the board knows is not a mine is a real cell, not fabricated
  // terrain. Only a state without a certain move may open one, and only
  // unflagged cells of that zone qualify.
  zoneFreeTarget(): Cell | null {
    if (this.status !== "playing") return null;
    const state = this.deductionState();
    if (state.certainMove) return null;
    for (const cell of state.guessCells) {
      const key = keyOf(cell.x, cell.y);
      if (this.flagSet.has(key) || this.revealedMap.has(key)) continue;
      if (this.mineAt(cell.x, cell.y)) continue;
      return cell;
    }
    return null;
  }

  freeCell(): Cell | null {
    if (this.status !== "playing") return null;
    const target = this.zoneFreeTarget();
    if (target === null) return null;
    const prepared = this.prepared;
    this.invalidatePrepared();
    if (this.adoptsPrepared(prepared, target.x, target.y)) {
      this.adoptFrom(prepared.board);
      return target;
    }
    return this.revealGroup([[target.x, target.y]], false) === "lost"
      ? null
      : target;
  }

  hasPrepared(x: number, y: number): boolean {
    const prepared = this.prepared;
    return (
      prepared !== null &&
      prepared.x === x &&
      prepared.y === y &&
      prepared.version === this.stateVersion
    );
  }

  // why: the search runs in idle slices, so the caller keeps rescheduling
  // while a job is in flight; the variant with a cell answers whether the
  // cell already has a job, without coordinates any job counts
  hasPendingPrepare(x?: number, y?: number): boolean {
    const job = this.pendingPrepare;
    if (job === null) return false;
    if (x === undefined || y === undefined) return true;
    return job.cell.x === x && job.cell.y === y;
  }

  // Searches the reveal of a cell ahead of the click. The interactive
  // reveal then adopts the state as-is instead of searching again.
  prepareNext(cell: Cell | null): void {
    if (cell === null) {
      this.invalidatePrepared();
      return;
    }
    if (this.hasPrepared(cell.x, cell.y)) return;
    if (this.hasPendingPrepare(cell.x, cell.y)) return;
    this.invalidatePrepared();
    const board = this.clone();
    if (board.revealedMap.size === 0) board.pinArea(cell.x, cell.y);
    const budgetMs =
      generationProfile(this.density).budgetMs * PREPARE_BUDGET_FACTOR;
    this.pendingPrepare = {
      cell,
      board,
      search: board.beginSearch(
        [[cell.x, cell.y]],
        board.revealedMap.size === 0,
        budgetMs,
      ),
    };
  }

  private pastLimit(limit: number | null): boolean {
    return limit !== null && performance.now() > limit;
  }

  // Drives the in-flight precompute until sliceEnd. Each slice is bounded
  // so a search can never spend a whole frame budget on the main thread.
  advancePrepare(sliceEnd: number): void {
    const job = this.pendingPrepare;
    if (job === null) return;
    job.search.limit = sliceEnd;
    while (performance.now() < sliceEnd) {
      const outcome = job.board.stepSearch(job.search);
      if (outcome !== null) {
        this.resolvePrepare(job, outcome);
        return;
      }
    }
    // why: the slice ended before the search noticed its own deadline, so a
    // job out of budget finishes at once instead of lingering forever
    if (Date.now() > job.search.deadline) {
      this.resolvePrepare(job, job.board.finishSearch(job.search));
    }
  }

  private resolvePrepare(job: PendingPrepare, outcome: RevealOutcome): void {
    this.pendingPrepare = null;
    // why: a candidate the search had to fall back on is not worth
    // adopting, the click then pays the interactive search as before
    this.prepared =
      outcome === "accepted"
        ? {
            x: job.cell.x,
            y: job.cell.y,
            version: this.stateVersion,
            board: job.board,
          }
        : null;
  }

  private adoptsPrepared(
    prepared: PreparedReveal | null,
    x: number,
    y: number,
  ): prepared is PreparedReveal {
    return (
      prepared !== null &&
      prepared.x === x &&
      prepared.y === y &&
      prepared.version === this.stateVersion
    );
  }

  private clone(): Board {
    const copy = new Board(this.seed, this.density);
    copyInto(copy.revealedMap, this.revealedMap);
    copyInto(copy.chunkQuotas, this.chunkQuotas);
    copyInto(copy.nonces, this.nonces);
    copySetInto(copy.committed, this.committed);
    copySetInto(copy.pinnedSafe, this.pinnedSafe);
    copySetInto(copy.flagSet, this.flagSet);
    copy.status = this.status;
    copy.stateVersion = this.stateVersion;
    return copy;
  }

  private adoptFrom(source: Board): void {
    this.invalidatePrepared();
    copyInto(this.revealedMap, source.revealedMap);
    copyInto(this.chunkQuotas, source.chunkQuotas);
    copyInto(this.nonces, source.nonces);
    copySetInto(this.committed, source.committed);
    copySetInto(this.pinnedSafe, source.pinnedSafe);
    this.lastRevealed = source.lastRevealed;
    this.lastFlagged = source.lastFlagged;
    this.explodedAt = null;
    this.quotaSearchable = false;
    this.analysis = null;
    this.stateVersion++;
  }

  // why: every change of the persisted state drops both the finished
  // precompute and the in-flight one, so a prepared reveal is either for
  // the current state or it does not exist
  private invalidatePrepared(): void {
    this.prepared = null;
    this.pendingPrepare = null;
  }

  // Cached per reveal: whether a certain move exists and which hidden
  // cells next to revealed ground stay ambiguous, for the HUD and for
  // marking the zone where the player has to guess.
  // why: with a certain move available the zone is empty, so the full
  // closure runs only in the stuck state that has to be marked
  deductionState(): DeductionState {
    if (this.analysis === null) {
      const hint = findSafeCell(this.revealedMap);
      if (hint !== null) {
        this.analysis = {
          certainMove: true,
          guessCells: [],
          hint: parseKey(hint),
        };
      } else {
        const { safe, mines } = solve(this.revealedMap);
        this.analysis = {
          certainMove: false,
          guessCells: this.ambiguousCells(safe, mines),
          hint: null,
        };
      }
    }
    return this.analysis;
  }

  private inspectNeighbors(
    x: number,
    y: number,
  ): { flagged: number; unknown: [number, number][] } {
    let flagged = 0;
    const unknown: [number, number][] = [];
    for (const [nx, ny] of neighborCoords(x, y)) {
      const nkey = keyOf(nx, ny);
      if (this.flagSet.has(nkey)) flagged++;
      else if (!this.revealedMap.has(nkey)) unknown.push([nx, ny]);
    }
    return { flagged, unknown };
  }

  private mineAt(x: number, y: number): boolean {
    const key = keyOf(x, y);
    if (this.pinnedSafe.has(key)) return false;
    const chunkKey = chunkKeyOf(x, y);
    const nonce = this.nonces.get(chunkKey) ?? 0;
    const frozen = this.chunkQuotas.get(chunkKey);
    const quota =
      frozen ??
      blockQuota(
        this.seed,
        Math.floor(x / CHUNK_SIZE),
        Math.floor(y / CHUNK_SIZE),
        this.density,
        nonce,
        this.quotaSearchable,
      );
    return cellHash(this.seed, nonce, x, y) < quota;
  }

  private adjacentMines(x: number, y: number): number {
    let count = 0;
    for (const [nx, ny] of neighborCoords(x, y)) {
      if (this.mineAt(nx, ny)) count++;
    }
    return count;
  }

  private commitAround(x: number, y: number): void {
    for (const [dx, dy] of AREA_OFFSETS) {
      const chunkKey = chunkKeyOf(x + dx, y + dy);
      this.committed.add(chunkKey);
      if (!this.nonces.has(chunkKey)) this.nonces.set(chunkKey, 0);
    }
  }

  private pinArea(x: number, y: number): void {
    for (const [dx, dy] of AREA_OFFSETS) {
      this.pinnedSafe.add(keyOf(x + dx, y + dy));
    }
  }

  // Reveals the group plus zero-cascades. The first attempt is the honest
  // outcome: an explosion there ends the run. Later attempts are invisible
  // re-rolls of the freshly committed chunks hunting for a state where a
  // certain move exists and every enclosed pocket stays deducible.
  private revealGroup(
    cells: readonly [number, number][],
    deep: boolean,
  ): ClickResult {
    const outcome = this.searchReveal(
      cells,
      deep,
      generationProfile(this.density).budgetMs,
    );
    if (outcome === "lost") {
      this.status = "lost";
      return "lost";
    }
    return "ok";
  }

  private searchReveal(
    cells: readonly [number, number][],
    deep: boolean,
    budgetMs: number,
  ): RevealOutcome {
    const search = this.beginSearch(cells, deep, budgetMs);
    for (;;) {
      const outcome = this.stepSearch(search);
      if (outcome !== null) return outcome;
    }
  }

  private beginSearch(
    cells: readonly [number, number][],
    deep: boolean,
    budgetMs: number,
    limit: number | null = null,
  ): AttemptSearch {
    const profile = generationProfile(this.density);
    this.quotaSearchable = this.revealedMap.size === 0;
    return {
      cells,
      deep,
      profile,
      snap: this.snapshot(),
      deadline: Date.now() + budgetMs,
      limit,
      attempt: 0,
      best: null,
      fastPathTried: false,
      pocketChecks: 0,
      judge: null,
    };
  }

  // One unit of the search. Returns null while the search continues, so an
  // idle caller can spend a bounded slice of time on it; the interactive
  // path just loops until a terminal outcome. A dropped slice can land in
  // the middle of a candidate's playout, which is why the playout is part
  // of the search state rather than a nested call.
  private stepSearch(search: AttemptSearch): RevealOutcome | null {
    const judging = search.judge;
    if (judging !== null) return this.continueJudge(search, judging);
    const result = this.attemptReveal(search.cells);
    if (result.exploded && search.attempt === 0) {
      this.quotaSearchable = false;
      return "lost";
    }
    if (
      !result.exploded &&
      this.hasProgress() &&
      this.withinZeroCap(search.profile, result.revealed)
    ) {
      search.judge = {
        revealed: result.revealed,
        before: this.snapshot(true),
        reached: 0,
      };
      return this.continueJudge(search, search.judge);
    }
    return this.afterAttempt(search);
  }

  // The deterministic playout of a candidate, one step per turn. Returns
  // null when the slice ran out so the caller can pick the job up later.
  private continueJudge(
    search: AttemptSearch,
    judge: JudgeState,
  ): RevealOutcome | null {
    const required = search.deep
      ? search.profile.opening
      : search.profile.select;
    while (judge.reached < required) {
      if (this.pastLimit(search.limit)) return null;
      const hint = findSafeCell(this.revealedMap);
      if (hint === null) break;
      const { x, y } = parseKey(hint);
      if (this.attemptReveal([[x, y]]).exploded) break;
      judge.reached++;
    }
    this.restore(judge.before, true);
    search.judge = null;
    return this.judgeAttempt(search, judge.revealed, judge.reached);
  }

  private judgeAttempt(
    search: AttemptSearch,
    revealed: readonly [number, number][],
    depth: number,
  ): RevealOutcome | null {
    const { deep, profile } = search;
    const required = deep ? profile.opening : profile.select;
    const reaches = depth >= required;
    const improves = search.best === null || depth > search.best.score;
    const worthChecking = (reaches && !search.fastPathTried) || improves;
    if (!worthChecking) return this.afterAttempt(search);
    if (this.pastLimit(search.limit)) return null;
    // why: the pocket closure floods and solves the whole board, so it
    // runs at most once for the fast path and then only for a candidate
    // that beats the best depth, not for every candidate
    if (this.pocketsResolved()) {
      if (reaches) {
        this.lastRevealed = [...revealed] as [number, number][];
        this.commitCandidate(search.snap);
        return "accepted";
      }
      search.best = {
        snap: this.snapshot(true),
        revealed: [...revealed] as [number, number][],
        score: depth,
      };
    }
    if (reaches) search.fastPathTried = true;
    // why: only a checked candidate can be accepted, so capping the
    // checks per reveal bounds the cost without weakening the guarantee;
    // the search simply stops finding better candidates
    if (++search.pocketChecks >= MAX_POCKET_CHECKS) {
      return this.finishSearch(search);
    }
    return this.afterAttempt(search);
  }

  // Between two attempts of the same reveal: re-roll the fresh chunks and
  // report whether the search still has attempts or budget left.
  private afterAttempt(search: AttemptSearch): RevealOutcome | null {
    this.rollbackAndReroll(search.snap);
    search.attempt++;
    if (Date.now() > search.deadline) return this.finishSearch(search);
    if (search.attempt >= search.profile.candidates) {
      return this.finishSearch(search);
    }
    return null;
  }

  private commitCandidate(snap: Snapshot): void {
    this.analysis = null;
    // why: the candidate's counts were computed while the quotas were
    // still searchable, so they freeze under the same value before the
    // flag clears
    this.lockFreshQuotas(snap);
    this.quotaSearchable = false;
    this.stateVersion++;
  }

  private finishSearch(search: AttemptSearch): RevealOutcome {
    const { best, cells, snap } = search;
    if (best !== null) {
      this.restore(best.snap, true);
      this.lastRevealed = best.revealed;
      this.commitCandidate(snap);
      return "accepted";
    }
    // why: re-rolling cannot repair an ambiguity that already-committed
    // chunks created, so the honest layout stands and the ambiguous cells
    // are reported for marking
    this.analysis = null;
    this.quotaSearchable = false;
    const result = this.attemptReveal(cells);
    this.lockFreshQuotas(snap);
    if (result.exploded) return "lost";
    this.stateVersion++;
    return "committed";
  }

  // why: one solve answers every pocket at once, because a pocket's
  // constraint set is exactly the revealed cells touching it
  private pocketsResolved(): boolean {
    const pockets = enclosedRegions(this.revealedMap);
    if (pockets.length === 0) return true;
    const { safe, mines } = solve(this.revealedMap);
    return pockets.every((pocket) =>
      pocket.bordered.every((cell) => safe.has(cell) || mines.has(cell)),
    );
  }

  // why: a batch dense with zero cells opens ground by the trivial rule,
  // which is what makes a tier read as easy; the cap tightens with
  // difficulty so the harder tiers force deduction from the first move
  private withinZeroCap(
    profile: GenerationProfile,
    revealed: readonly [number, number][],
  ): boolean {
    if (profile.zeroCap >= 1 || revealed.length === 0) return true;
    let zeros = 0;
    for (const [x, y] of revealed) {
      if ((this.revealedMap.get(keyOf(x, y)) ?? -1) === 0) zeros++;
    }
    return zeros / revealed.length <= profile.zeroCap;
  }

  // why: freeze the quotas the accepted numbers were computed against, so
  // no later re-roll can move a mine under a revealed count; a chunk is
  // keyed as a whole because its cells were all evaluated against one
  // quota, and only cells around the new reveal can change
  private lockFreshQuotas(snap: Snapshot): void {
    for (const chunkKey of this.committed) {
      if (snap.committed.has(chunkKey) || this.chunkQuotas.has(chunkKey)) {
        continue;
      }
      const [chunkX = 0, chunkY = 0] = chunkKey.split(",").map(Number);
      this.chunkQuotas.set(
        chunkKey,
        blockQuota(
          this.seed,
          chunkX,
          chunkY,
          this.density,
          this.nonces.get(chunkKey) ?? 0,
          this.quotaSearchable,
        ),
      );
    }
  }

  private attemptReveal(cells: readonly [number, number][]): {
    exploded: boolean;
    revealed: [number, number][];
  } {
    const revealed: [number, number][] = [];
    const stack: [number, number][] = [...cells];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) continue;
      const [x, y] = current;
      const key = keyOf(x, y);
      if (this.revealedMap.has(key) || this.flagSet.has(key)) continue;
      if (this.mineAt(x, y)) {
        this.explodedAt = { x, y };
        return { exploded: true, revealed };
      }
      this.commitAround(x, y);
      const count = this.adjacentMines(x, y);
      this.revealedMap.set(key, count);
      revealed.push([x, y]);
      if (count === 0) {
        for (const neighbor of neighborCoords(x, y)) stack.push(neighbor);
      }
    }
    this.explodedAt = null;
    this.lastRevealed = revealed;
    return { exploded: false, revealed };
  }

  private hasProgress(): boolean {
    return findSafeCell(this.revealedMap) !== null;
  }

  private ambiguousCells(
    safe: ReadonlySet<string>,
    mines: ReadonlySet<string>,
  ): Cell[] {
    const ambiguous = new Set<string>();
    for (const [key] of this.revealedMap) {
      const { x, y } = parseKey(key);
      for (const [nx, ny] of neighborCoords(x, y)) {
        const neighborKey = keyOf(nx, ny);
        if (this.revealedMap.has(neighborKey)) continue;
        if (safe.has(neighborKey) || mines.has(neighborKey)) continue;
        ambiguous.add(neighborKey);
      }
    }
    return [...ambiguous].map(parseKey);
  }

  private rollbackAndReroll(snap: Snapshot): void {
    const fresh = new Set<string>();
    for (const chunkKey of this.committed) {
      if (!snap.committed.has(chunkKey)) fresh.add(chunkKey);
    }
    this.restore(snap);
    // why: nonces persist across the restore so each attempt re-rolls the
    // fresh chunks onto a new layout; restoring them would replay nonce one
    // every time and make every attempt identical
    for (const chunkKey of fresh) {
      this.nonces.set(chunkKey, (this.nonces.get(chunkKey) ?? 0) + 1);
    }
  }

  private snapshot(withNonces = false): Snapshot {
    return {
      revealed: new Map(this.revealedMap),
      committed: new Set(this.committed),
      pinnedSafe: new Set(this.pinnedSafe),
      nonces: withNonces ? new Map(this.nonces) : null,
    };
  }

  private restore(snap: Snapshot, restoreNonces = false): void {
    this.revealedMap.clear();
    for (const [key, count] of snap.revealed) this.revealedMap.set(key, count);
    this.committed = new Set(snap.committed);
    this.pinnedSafe = new Set(snap.pinnedSafe);
    // why: rollbacks keep the nonces so each re-roll explores a new
    // layout, but replaying a chosen candidate must restore them too or
    // its mines would move under the numbers it displayed
    if (restoreNonces && snap.nonces !== null) {
      this.nonces = new Map(snap.nonces);
    }
  }
}

interface Snapshot {
  revealed: Map<string, number>;
  committed: Set<string>;
  pinnedSafe: Set<string>;
  nonces: Map<string, number> | null;
}
