import { describe, expect, it } from "vitest";
import { cellHash } from "../../src/game/rng.js";

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
