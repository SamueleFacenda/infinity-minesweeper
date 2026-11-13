import { describe, expect, it } from "vitest";
import {
  cornerCollapseRegistrations,
  glideStep,
  pauseAnimations,
} from "../../src/render.js";

const START_TIME = 1000;

function revealedCells(
  cells: readonly (readonly [number, number])[],
): (x: number, y: number) => boolean {
  const keys = new Set(cells.map(([x, y]) => `${String(x)},${String(y)}`));
  return (x: number, y: number) => keys.has(`${String(x)},${String(y)}`);
}

describe("cornerCollapseRegistrations", () => {
  it("registers the collapse of a revealed neighbor's island corner", () => {
    const registrations = cornerCollapseRegistrations(
      [[0, 0]],
      new Map([["0,0", { startTime: START_TIME, delay: 0 }]]),
      revealedCells([
        [0, 0],
        [1, 0],
      ]),
    );

    expect([...registrations.keys()].sort()).toEqual(["1,0|0", "1,0|3"]);
    expect(registrations.get("1,0|0")).toEqual({
      startTime: START_TIME,
      delay: 0,
    });
  });

  it("skips a corner whose other side is already revealed", () => {
    const registrations = cornerCollapseRegistrations(
      [[0, 0]],
      new Map([["0,0", { startTime: START_TIME, delay: 0 }]]),
      revealedCells([
        [0, 0],
        [1, 0],
        [1, -1],
      ]),
    );

    expect([...registrations.keys()]).toEqual(["1,0|3"]);
  });

  it("skips corners of a tile uncovered in the same batch", () => {
    const registrations = cornerCollapseRegistrations(
      [
        [0, 0],
        [1, 0],
      ],
      new Map([
        ["0,0", { startTime: START_TIME, delay: 0 }],
        ["1,0", { startTime: START_TIME, delay: 50 }],
      ]),
      revealedCells([
        [0, 0],
        [1, 0],
      ]),
    );

    expect(registrations.size).toBe(0);
  });

  it("skips a corner whose both sides are uncovered together", () => {
    const registrations = cornerCollapseRegistrations(
      [
        [0, 0],
        [1, -1],
      ],
      new Map([
        ["0,0", { startTime: START_TIME, delay: 0 }],
        ["1,-1", { startTime: START_TIME, delay: 50 }],
      ]),
      revealedCells([
        [0, 0],
        [1, -1],
        [1, 0],
      ]),
    );

    expect([...registrations.keys()].sort()).toEqual(["1,0|1", "1,0|3"]);
  });

  it("registers nothing for a neighbor that stays hidden", () => {
    const registrations = cornerCollapseRegistrations(
      [[0, 0]],
      new Map([["0,0", { startTime: START_TIME, delay: 0 }]]),
      revealedCells([[0, 0]]),
    );

    expect(registrations.size).toBe(0);
  });

  it("registers nothing for a cell without a reveal animation", () => {
    const registrations = cornerCollapseRegistrations(
      [[0, 0]],
      new Map(),
      revealedCells([
        [0, 0],
        [1, 0],
      ]),
    );

    expect(registrations.size).toBe(0);
  });
});

describe("glideStep", () => {
  const step = 1 / 60;

  it("starts the glide from rest instead of jumping a third of the gap", () => {
    const [value, velocity] = glideStep(0, 0, 60, step);

    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(6);
    expect(velocity).toBeGreaterThan(0);
  });

  it("settles onto the target from rest without overshooting", () => {
    let value = 0;
    let velocity = 0;
    for (let frame = 0; frame < 60; frame++) {
      [value, velocity] = glideStep(value, velocity, 60, step);
      expect(value).toBeLessThanOrEqual(60);
    }

    expect(value).toBe(60);
    expect(velocity).toBe(0);
  });

  it("keeps its velocity when a new target retargets it mid-glide", () => {
    let value = 0;
    let velocity = 0;
    [value, velocity] = glideStep(value, velocity, 60, step);
    const first = velocity;
    [value, velocity] = glideStep(value, velocity, 60, step);

    expect(velocity).toBeGreaterThan(first);
  });
});

describe("pauseAnimations", () => {
  const REVEAL_DURATION_MS = 300;

  it("shifts every pending start time by the missed time", () => {
    const anims = new Map([
      ["0,0", { startTime: 1000, delay: 0 }],
      ["0,1", { startTime: 1000, delay: 50 }],
    ]);

    pauseAnimations(400, anims);

    expect([...anims.values()]).toEqual([
      { startTime: 1400, delay: 0 },
      { startTime: 1400, delay: 50 },
    ]);
  });

  it("keeps the progress the last painted frame showed", () => {
    const anims = new Map([["0,0", { startTime: 0, delay: 0 }]]);
    const revealedAt = 250;
    const missedMs = 400;

    pauseAnimations(missedMs, anims);

    const now = revealedAt + missedMs;
    const startTime = anims.get("0,0")?.startTime ?? -1;
    const progress = (now - startTime) / REVEAL_DURATION_MS;

    expect(progress).toBeCloseTo(revealedAt / REVEAL_DURATION_MS);
    expect(progress).toBeLessThan(1);
  });

  it("leaves no animation pending when nothing animates", () => {
    const anims = new Map<string, { startTime: number; delay: number }>();

    pauseAnimations(400, anims);

    expect(anims.size).toBe(0);
  });
});
