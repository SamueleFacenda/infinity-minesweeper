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
