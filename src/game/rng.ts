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
// chain grew ~15x with the mine fraction still at the target level
const QUOTA_AMPLITUDE = 1;
// why: easy tiers never stalled and their cascades grow the frontier fast,
// so modulating them only costs per-step time; the deep tiers are where a
// uniform frontier turns ambiguous within a few moves
const QUOTA_FLOOR_DENSITY = 0.26;

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
): number {
  const noise = fmix32(
    Math.imul(chunkX, 0x9e3779b1) ^
      Math.imul(chunkY, 0x85ebca6b) ^
      Math.imul(seed, 0xc2b2ae35) ^
      (searchable ? Math.imul(nonce + 1, 0x27d4eb2f) : 0),
  );
  if (density < QUOTA_FLOOR_DENSITY) return density;
  const spread = (noise / 4294967296) * 2 - 1;
  const quota = density * (1 + QUOTA_AMPLITUDE * spread);
  return Math.min(0.9, Math.max(0.02, quota));
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
