// Deterministic hash-based board RNG: a cell's mine status is a pure
// function of (seed, chunk nonce, coordinates), so the infinite board
// needs no stored mine layout.
// ponytail: statistical mixing only, not cryptographic.

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// why: every chunk draws its own quota around the difficulty density, so
// the board alternates ground that deduction can chew through and ground
// that stays dense. A uniform frontier at Insane density is ambiguous
// within a handful of moves, which is what used to stall runs; the
// modulation keeps the average density at the difficulty level while
// making most chunks tractable. Measured at 35%: the median deterministic
// chain grew ~7x with the mine fraction still at the target level
const QUOTA_AMPLITUDE = 1;
// why: the spread is peaked, so most chunks stay at the nominal density
// and the difficulty reads uniform, while only rare chunks swing far
// enough to anchor a long chain; a flat spread made half the board empty
// islands and half walls, which read as a grid and tripled the cascades.
// The floor keeps every chunk above this fraction of the nominal density,
// so no empty islands remain to walk through
// why: the floor tightens with difficulty, so the hardest tiers keep no
// sparse stretches at all while the easy ones keep their cascades; a floor
// of one leaves the quota uniform for tiers that never stalled
const QUOTA_FLOORS: readonly {
  readonly maxDensity: number;
  readonly floor: number;
}[] = [
  { maxDensity: 0.15, floor: 1 },
  { maxDensity: 0.19, floor: 1 },
  { maxDensity: 0.27, floor: 1 },
  { maxDensity: 0.32, floor: 0.8 },
  { maxDensity: 0.37, floor: 0.85 },
  { maxDensity: Number.POSITIVE_INFINITY, floor: 0.9 },
];

export function quotaFloorFor(density: number): number {
  const tier = QUOTA_FLOORS.find(
    (candidate) => density <= candidate.maxDensity,
  );
  return tier?.floor ?? 1;
}

// A chunk's quota is a pure function of (seed, chunk), so the mine
// fraction of a settled region always matches the difficulty. Only the
// opening reveal searches over quotas (see Board): a first click whose
// surrounding chunks are all hot has no other way to open a tractable
// game, and no committed number can change while it searches.
export function blockQuota(
  seed: number,
  chunkX: number,
  chunkY: number,
  density: number,
  nonce: number,
  searchable: boolean,
  floorRatio: number = quotaFloorFor(density),
): number {
  const noise = fmix32(
    Math.imul(chunkX, 0x9e3779b1) ^
      Math.imul(chunkY, 0x85ebca6b) ^
      Math.imul(seed, 0xc2b2ae35) ^
      (searchable ? Math.imul(nonce + 1, 0x27d4eb2f) : 0),
  );
  if (floorRatio >= 1) return density;
  const flat = (noise / 4294967296) * 2 - 1;
  const spread = Math.sign(flat) * flat * flat;
  const quota = density * (1 + QUOTA_AMPLITUDE * spread);
  const low = density * floorRatio;
  return Math.min(0.9, Math.max(low, quota));
}

export function cellHash(
  seed: number,
  nonce: number,
  x: number,
  y: number,
): number {
  const spatial = fmix32(
    Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x2545f491) ^ seed,
  );
  return fmix32(spatial ^ Math.imul(nonce + 1, 0x9e3779b1)) / 4294967296;
}
