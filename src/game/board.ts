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
    if (this.flagSet.has(key)) {
      this.flagSet.delete(key);
    } else {
      this.flagSet.add(key);
    }
  }

  reveal(x: number, y: number): ClickResult {
    if (this.status !== "playing") return "ok";
    this.lastRevealed = [];
    this.lastFlagged = [];
    const key = keyOf(x, y);
    if (this.revealedMap.has(key) || this.flagSet.has(key)) return "ok";
    if (this.revealedMap.size === 0) this.pinArea(x, y);
    return this.revealGroup([[x, y]], this.revealedMap.size === 0);
  }

  // Clicking a revealed number: auto-disclose when the flags satisfy the
  // count (classic chord), auto-fill flags when the remaining unknowns are
  // all mines by simple counting.
  clickNumber(x: number, y: number): ClickResult {
    if (this.status !== "playing") return "ok";
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
    }
    return "ok";
  }

  findHint(): Cell | null {
    const first = findSafeCell(this.revealedMap);
    return first === null ? null : parseKey(first);
  }

  // Deliberate escape from a marked guess zone: the layout is fixed, so a
  // cell the board knows is not a mine is a real cell, not fabricated
  // terrain. Only a state without a certain move may open one, and only
  // unflagged cells of that zone qualify.
  freeCell(): Cell | null {
    if (this.status !== "playing") return null;
    const state = this.deductionState();
    if (state.certainMove) return null;
    for (const cell of state.guessCells) {
      const key = keyOf(cell.x, cell.y);
      if (this.flagSet.has(key) || this.revealedMap.has(key)) continue;
      if (this.mineAt(cell.x, cell.y)) continue;
      return this.revealGroup([[cell.x, cell.y]], false) === "lost"
        ? null
        : cell;
    }
    return null;
  }

  // Cached per reveal: whether a certain move exists and which hidden
  // cells next to revealed ground stay ambiguous, for the HUD and for
  // marking the zone where the player has to guess.
  // why: with a certain move available the zone is empty, so the full
  // closure runs only in the stuck state that has to be marked
  deductionState(): DeductionState {
    if (this.analysis === null) {
      if (findSafeCell(this.revealedMap) !== null) {
        this.analysis = { certainMove: true, guessCells: [] };
      } else {
        const { safe, mines } = solve(this.revealedMap);
        this.analysis = {
          certainMove: false,
          guessCells: this.ambiguousCells(safe, mines),
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
    const opening = this.revealedMap.size === 0;
    const profile = generationProfile(this.density);
    this.quotaSearchable = opening;
    const snap = this.snapshot();
    const deadline = Date.now() + profile.budgetMs;
    let fastPathTried = false;
    let pocketChecks = 0;
    let best: {
      readonly snap: Snapshot;
      readonly revealed: [number, number][];
      readonly score: number;
    } | null = null;
    for (let attempt = 0; attempt < profile.candidates; attempt++) {
      const result = this.attemptReveal(cells);
      if (result.exploded && attempt === 0) {
        this.status = "lost";
        this.quotaSearchable = false;
        return "lost";
      }
      if (
        !result.exploded &&
        this.hasProgress() &&
        this.withinZeroCap(profile, result.revealed)
      ) {
        const depth = this.playoutDepth(
          deep ? profile.opening : profile.select,
        );
        const required = deep ? profile.opening : profile.select;
        const reaches = depth >= required;
        const improves = best === null || depth > best.score;
        // why: the pocket closure floods and solves the whole board, so it
        // runs at most once for the fast path and then only for a
        // candidate that beats the best depth, not for every candidate
        const worthChecking = (reaches && !fastPathTried) || improves;
        if (worthChecking && this.pocketsResolved()) {
          if (reaches) {
            this.lastRevealed = result.revealed;
            this.analysis = null;
            this.lockFreshQuotas(snap);
            this.quotaSearchable = false;
            return "ok";
          }
          best = {
            snap: this.snapshot(true),
            revealed: result.revealed,
            score: depth,
          };
        }
        // why: only a checked candidate can be accepted, so capping the
        // checks per reveal bounds the cost without weakening the
        // guarantee; the search simply stops finding better candidates
        if ((reaches && !fastPathTried) || improves) {
          if (reaches) fastPathTried = true;
          if (++pocketChecks >= MAX_POCKET_CHECKS) break;
        }
      }
      this.rollbackAndReroll(snap);
      if (Date.now() > deadline) break;
    }
    if (best !== null) {
      this.restore(best.snap, true);
      this.lastRevealed = best.revealed;
      this.analysis = null;
      // why: the candidate's counts were computed while the quotas were
      // still searchable, so they freeze under the same value before the
      // flag clears
      this.lockFreshQuotas(snap);
      this.quotaSearchable = false;
      return "ok";
    }
    // why: re-rolling cannot repair an ambiguity that old committed
    // chunks created, so the honest layout stands and the ambiguous cells
    // are reported for marking
    this.analysis = null;
    this.quotaSearchable = false;
    const result = this.attemptReveal(cells);
    this.lockFreshQuotas(snap);
    return result.exploded ? this.lose() : "ok";
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
  // no later re-roll can move a mine under a revealed count; only cells
  // around the new reveal can change, so the walk stays local
  // why: freeze the quotas the accepted numbers were computed against, so
  // no later re-roll can move a mine under a revealed count; a chunk is
  // keyed as a whole because its cells were all evaluated against one
  // quota
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

  // why: the playout runs on the real board (cascade counts included), so
  // its mutated state is discarded by restoring the snapshot it started
  // from, and lastRevealed is restored by the caller
  // why: the playout runs on the real board (cascade counts included), so
  // its mutated state is discarded by restoring the snapshot it started
  // from; the reached depth is the fitness the search ranks candidates by
  private playoutDepth(depth: number): number {
    const before = this.snapshot(true);
    let reached = 0;
    for (; reached < depth; reached++) {
      const hint = findSafeCell(this.revealedMap);
      if (hint === null) break;
      const { x, y } = parseKey(hint);
      if (this.attemptReveal([[x, y]]).exploded) break;
    }
    this.restore(before, true);
    return reached;
  }

  private playoutSolvable(depth: number): boolean {
    for (let step = 0; step < depth; step++) {
      const hint = findSafeCell(this.revealedMap);
      if (hint === null) return false;
      const { x, y } = parseKey(hint);
      if (this.attemptReveal([[x, y]]).exploded) return false;
    }
    return true;
  }

  private lose(): ClickResult {
    this.status = "lost";
    return "lost";
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

  // why: a pocket whose ambiguous cells all sit in chunks the re-roll
  // cannot touch is permanently ambiguous; re-rolling only the fresh
  // chunks repairs what this reveal's own terrain created

  // why: a pocket's constraints come only from the revealed cells touching
  // it, so solving that local view decides the pocket without running the
  // whole-board solver

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
