import type { Cell } from "./coords.js";
import { chunkKeyOf, keyOf, neighborCoords, parseKey } from "./coords.js";
import { cellHash } from "./rng.js";
import { findSafeCell } from "./solver.js";

export type GameStatus = "playing" | "lost";
export type ClickResult = "lost" | "ok";

const MAX_ROLLS = 32;
const MAX_FALLBACK_PINS = 12;
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
// visible to the player. After every reveal the visible state is verified
// by the solver; if the player would need to guess, the freshly committed
// chunks are re-rolled, so no-guess play is guaranteed except in
// astronomically rare fallback-exhausted states.
export class Board {
  readonly seed: number;
  readonly density: number;
  status: GameStatus = "playing";
  explodedAt: Cell | null = null;

  private readonly revealedMap = new Map<string, number>();
  private readonly flagSet = new Set<string>();
  private committed = new Set<string>();
  private nonces = new Map<string, number>();
  private pinnedSafe = new Set<string>();

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
    const key = keyOf(x, y);
    if (this.revealedMap.has(key) || this.flagSet.has(key)) return "ok";
    if (this.revealedMap.size === 0) this.pinArea(x, y);
    return this.revealGroup([[x, y]]);
  }

  // Clicking a revealed number: auto-disclose when the flags satisfy the
  // count (classic chord), auto-fill flags when the remaining unknowns are
  // all mines by simple counting.
  clickNumber(x: number, y: number): ClickResult {
    if (this.status !== "playing") return "ok";
    const count = this.revealedMap.get(keyOf(x, y));
    if (count === undefined) return "ok";
    const { flagged, unknown } = this.inspectNeighbors(x, y);
    if (flagged === count && unknown.length > 0) {
      return this.revealGroup(unknown);
    }
    if (count - flagged === unknown.length && unknown.length > 0) {
      for (const [nx, ny] of unknown) this.flagSet.add(keyOf(nx, ny));
    }
    return "ok";
  }

  findHint(): Cell | null {
    const first = findSafeCell(this.revealedMap);
    return first === null ? null : parseKey(first);
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
    const nonce = this.nonces.get(chunkKeyOf(x, y)) ?? 0;
    return cellHash(this.seed, nonce, x, y) < this.density;
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
  // re-rolls of freshly committed chunks hunting for a solvable state.
  private revealGroup(cells: readonly [number, number][]): ClickResult {
    const snap = this.snapshot();
    let lastRevealed: [number, number][] = [];
    for (let attempt = 0; attempt < MAX_ROLLS; attempt++) {
      const result = this.attemptReveal(cells);
      if (result.exploded && attempt === 0) {
        this.status = "lost";
        return "lost";
      }
      if (!result.exploded) {
        if (this.hasProgress()) return "ok";
        lastRevealed = result.revealed;
      }
      this.rollbackAndReroll(snap);
    }
    if (this.tryFallbackOpenings(snap, cells, lastRevealed)) return "ok";
    // ponytail: last resort keeps the honest board even if a guess could
    // be needed; the solver guarantees above make this vanishingly rare
    return this.attemptReveal(cells).exploded ? this.lose() : "ok";
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
    return { exploded: false, revealed };
  }

  private hasProgress(): boolean {
    return findSafeCell(this.revealedMap) !== null;
  }

  // Forced-opening fallback: pin a safe 3x3 around any cell whose mines
  // were never visible and include that cell in the reveal. Candidates
  // start at the click and expand outward to radius five, so a reveal
  // that would dead-end inside a dense mine wall still opens fresh
  // ground instead of leaving the board stuck.
  private tryFallbackOpenings(
    snap: Snapshot,
    cells: readonly [number, number][],
    revealedCandidates: readonly [number, number][],
  ): boolean {
    const candidates = [
      ...cells,
      ...[...revealedCandidates].reverse().slice(0, 16),
      ...rescueRings(cells, 1, 5),
    ];
    let pins = 0;
    for (const [cx, cy] of candidates) {
      if (pins >= MAX_FALLBACK_PINS) break;
      if (!this.areaPinnable(snap, cx, cy)) continue;
      pins++;
      for (let attempt = 0; attempt < 2; attempt++) {
        this.restore(snap);
        this.pinArea(cx, cy);
        const result = this.attemptReveal([...cells, [cx, cy]]);
        if (!result.exploded && this.hasProgress()) return true;
        this.rollbackAndReroll(snap);
      }
    }
    this.restore(snap);
    return false;
  }

  private areaPinnable(snap: Snapshot, x: number, y: number): boolean {
    for (const [dx, dy] of AREA_OFFSETS) {
      const key = keyOf(x + dx, y + dy);
      if (snap.revealed.has(key)) return false;
      for (const [nx, ny] of neighborCoords(x + dx, y + dy)) {
        if (snap.revealed.has(keyOf(nx, ny))) return false;
      }
    }
    return true;
  }

  private rollbackAndReroll(snap: Snapshot): void {
    const fresh = new Set<string>();
    for (const chunkKey of this.committed) {
      if (!snap.committed.has(chunkKey)) fresh.add(chunkKey);
    }
    this.restore(snap);
    for (const chunkKey of fresh) {
      this.nonces.set(chunkKey, (this.nonces.get(chunkKey) ?? 0) + 1);
    }
  }

  private snapshot(): Snapshot {
    return {
      revealed: new Map(this.revealedMap),
      committed: new Set(this.committed),
      nonces: new Map(this.nonces),
      pinnedSafe: new Set(this.pinnedSafe),
    };
  }

  private restore(snap: Snapshot): void {
    this.revealedMap.clear();
    for (const [key, count] of snap.revealed) this.revealedMap.set(key, count);
    this.committed = new Set(snap.committed);
    this.nonces = new Map(snap.nonces);
    this.pinnedSafe = new Set(snap.pinnedSafe);
  }
}

interface Snapshot {
  revealed: Map<string, number>;
  committed: Set<string>;
  nonces: Map<string, number>;
  pinnedSafe: Set<string>;
}

// Cells at Chebyshev distance one to five from the click targets,
// nearest first: ground a frontier click cannot have made visible, so
// pinning there is always invisible to the player.
function rescueRings(
  cells: readonly [number, number][],
  minRadius: number,
  maxRadius: number,
): [number, number][] {
  const ring: [number, number][] = [];
  for (let radius = minRadius; radius <= maxRadius; radius++) {
    for (const [x, y] of cells) {
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          ring.push([x + dx, y + dy]);
        }
      }
    }
  }
  return ring;
}
