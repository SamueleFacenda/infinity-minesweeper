import { describe, expect, it } from "vitest";
import { blockQuota, cellHash, quotaFloorFor } from "../../src/game/rng.js";

describe("blockQuota", () => {
  it("keeps sparse stretches on the deep tiers", () => {
    // why: a frontier where every chunk sits at the nominal density is
    // uniformly ambiguous, so the floor must leave chunks well below it
    for (const density of [0.2733, 0.3147, 0.3545]) {
      const floor = quotaFloorFor(density);
      expect(floor).toBeLessThan(1);
      let sparse = 0;
      for (let x = -60; x < 60; x++) {
        for (let y = -60; y < 60; y++) {
          if (
            blockQuota(11, x, y, density, 0, false) <
            density * (floor + 0.05)
          ) {
            sparse++;
          }
        }
      }
      expect(sparse).toBeGreaterThan(0);
    }
  });

  it("holds the settled mine fraction near the nominal density", () => {
    for (const density of [0.2733, 0.3545]) {
      let mines = 0;
      const side = 200;
      for (let x = 0; x < side; x++) {
        for (let y = 0; y < side; y++) {
          if (
            blockQuota(
              11,
              Math.floor(x / 16),
              Math.floor(y / 16),
              density,
              0,
              false,
            ) > cellHash(7, 0, x, y)
          ) {
            mines++;
          }
        }
      }
      const settled = mines / (side * side);
      expect(settled).toBeGreaterThan(density * 0.85);
      expect(settled).toBeLessThan(density * 1.15);
    }
  });
});

describe("cellHash", () => {
  it("is deterministic for the same inputs", () => {
    expect(cellHash(1, 0, 5, -7)).toBe(cellHash(1, 0, 5, -7));
  });

  it("varies with seed, nonce and coordinates", () => {
    const base = cellHash(1, 0, 5, 5);
    expect(cellHash(2, 0, 5, 5)).not.toBe(base);
    expect(cellHash(1, 1, 5, 5)).not.toBe(base);
    expect(cellHash(1, 0, 6, 5)).not.toBe(base);
    expect(cellHash(1, 0, 5, 6)).not.toBe(base);
    expect(cellHash(1, 0, -5, 5)).not.toBe(base);
  });

  it("is transposed-coordinate asymmetric", () => {
    expect(cellHash(1, 0, 3, 8)).not.toBe(cellHash(1, 0, 8, 3));
  });

  it("hits the density within tolerance over a large area", () => {
    const density = 0.2;
    let hits = 0;
    const samples = 500_000;
    for (let x = 0; x < 1000; x++) {
      for (let y = 0; y < 500; y++) {
        if (cellHash(7, 0, x, y) < density) hits++;
      }
    }
    const ratio = hits / samples;
    expect(ratio).toBeGreaterThan(density * 0.99);
    expect(ratio).toBeLessThan(density * 1.01);
  });

  it("produces uncorrelated values for adjacent cells", () => {
    let matches = 0;
    for (let x = -250; x < 250; x++) {
      for (let y = -250; y < 250; y++) {
        const a = cellHash(9, 0, x, y) < 0.2;
        const b = cellHash(9, 0, x + 1, y) < 0.2;
        if (a === b) matches++;
      }
    }
    const independent = 0.2 * 0.2 + 0.8 * 0.8;
    expect(matches / 250_000).toBeGreaterThan(independent - 0.02);
    expect(matches / 250_000).toBeLessThan(independent + 0.02);
  });
});
