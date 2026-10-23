import { describe, expect, it } from "vitest";
import { revealCrunchParams } from "../../src/sound.js";

describe("revealCrunchParams", () => {
  it("keeps a single-cell reveal light and dry", () => {
    const crunch = revealCrunchParams(1);
    expect(crunch.frequencyHz).toBeGreaterThan(1000);
    expect(crunch.durationMs).toBeLessThan(100);
    expect(crunch.rumble).toBe(false);
  });

  it("deepens frequency and stretches duration as the flood grows", () => {
    const small = revealCrunchParams(1);
    const medium = revealCrunchParams(10);
    const large = revealCrunchParams(40);
    expect(medium.frequencyHz).toBeLessThan(small.frequencyHz);
    expect(large.frequencyHz).toBeLessThan(medium.frequencyHz);
    expect(medium.durationMs).toBeGreaterThan(small.durationMs);
    expect(large.durationMs).toBeGreaterThan(medium.durationMs);
  });

  it("adds rumble only on big floods", () => {
    expect(revealCrunchParams(9).rumble).toBe(false);
    expect(revealCrunchParams(10).rumble).toBe(true);
  });

  it("clamps at the deep end", () => {
    expect(revealCrunchParams(4000)).toEqual(revealCrunchParams(40));
  });
});
