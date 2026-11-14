import type { Cell } from "./coords.js";
import { chunkKeyOf, keyOf, parseKey } from "./coords.js";
import type { GameStatus } from "./board.js";
import { blockQuota, cellHash } from "./rng.js";

// The read-only engine state the UI consumes: the renderer paints it, the
// HUD counts it, and a worker boundary transfers it. Mine placement is a
// pure hash, so the terrain table is all the presentation needs to answer
// isMine for hidden cells anywhere on the infinite board (the loss screen
// reveals every mine in view, including far from the played ground).

export interface BoardView {
  isRevealed(x: number, y: number): boolean;
  countAt(x: number, y: number): number | undefined;
  isFlagged(x: number, y: number): boolean;
  isMine(x: number, y: number): boolean;
  readonly status: GameStatus;
  readonly explodedAt: Cell | null;
  readonly revealedCount: number;
  readonly flaggedCount: number;
}

export interface ChunkTerrain {
  readonly nonce: number;
  // why: null when the chunk has no frozen quota yet, so the live hash
  // formula answers exactly like the engine does before commitment
  readonly quota: number | null;
}

export interface TerrainTable {
  readonly seed: number;
  readonly density: number;
  readonly pinnedSafe: ReadonlySet<string>;
  readonly chunks: ReadonlyMap<string, ChunkTerrain>;
}

export interface EngineSnapshot {
  readonly status: GameStatus;
  readonly explodedAt: Cell | null;
  readonly revealed: ReadonlyMap<string, number>;
  readonly flags: ReadonlySet<string>;
  readonly lastRevealed: readonly (readonly [number, number])[];
  readonly lastFlagged: readonly (readonly [number, number])[];
  readonly certainMove: boolean;
  readonly guessCells: readonly Cell[];
  readonly terrain: TerrainTable;
}

export class SnapshotView implements BoardView {
  private revealed: ReadonlyMap<string, number> = new Map();
  private flags: ReadonlySet<string> = new Set();
  private terrain: TerrainTable | null = null;

  status: GameStatus = "playing";
  explodedAt: Cell | null = null;

  get revealedCount(): number {
    return this.revealed.size;
  }

  get flaggedCount(): number {
    return this.flags.size;
  }

  update(snapshot: EngineSnapshot): void {
    this.revealed = snapshot.revealed;
    this.flags = snapshot.flags;
    this.terrain = snapshot.terrain;
    this.status = snapshot.status;
    this.explodedAt = snapshot.explodedAt;
  }

  reset(): void {
    this.revealed = new Map();
    this.flags = new Set();
    this.terrain = null;
    this.status = "playing";
    this.explodedAt = null;
  }

  isRevealed(x: number, y: number): boolean {
    return this.revealed.has(keyOf(x, y));
  }

  countAt(x: number, y: number): number | undefined {
    return this.revealed.get(keyOf(x, y));
  }

  isFlagged(x: number, y: number): boolean {
    return this.flags.has(keyOf(x, y));
  }

  // why: mirrors Board.mineAt exactly, so the loss screen reveals the same
  // mines the engine would; any drift shows as a wrong flag after a loss
  isMine(x: number, y: number): boolean {
    const terrain = this.terrain;
    if (terrain === null) return false;
    if (terrain.pinnedSafe.has(keyOf(x, y))) return false;
    const chunk = terrain.chunks.get(chunkKeyOf(x, y));
    const nonce = chunk?.nonce ?? 0;
    const quota = chunk?.quota ?? liveQuota(terrain, x, y);
    return cellHash(terrain.seed, nonce, x, y) < quota;
  }
}

function liveQuota(terrain: TerrainTable, x: number, y: number): number {
  const chunk = parseKey(chunkKeyOf(x, y));
  return blockQuota(terrain.seed, chunk.x, chunk.y, terrain.density, 0, false);
}
