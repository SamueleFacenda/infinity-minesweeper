import { describe, expect, it } from "vitest";
import { LOSS_TAUNTS, randomTaunt } from "../../src/game/taunts.js";

describe("LOSS_TAUNTS", () => {
  it("is a long list", () => {
    expect(LOSS_TAUNTS.length).toBeGreaterThanOrEqual(40);
  });

  it("contains only non-empty trimmed strings", () => {
    for (const taunt of LOSS_TAUNTS) {
      expect(taunt.length).toBeGreaterThan(0);
      expect(taunt).toBe(taunt.trim());
    }
  });

  it("contains no duplicates", () => {
    expect(new Set(LOSS_TAUNTS).size).toBe(LOSS_TAUNTS.length);
  });
});

describe("randomTaunt", () => {
  it("returns a member of the list", () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      expect(LOSS_TAUNTS).toContain(randomTaunt());
    }
  });
});
