import { describe, expect, it } from "vitest";
import {
  cornerCollapseRegistrations,
  freeCellRingPoint,
  freeCellRingRadius,
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

describe("freeCellRingPoint", () => {
  const view = {
    cameraX: 0,
    cameraY: 0,
    cellSize: 30,
    width: 800,
    height: 600,
  };

  it("marks a visible cell at its screen center", () => {
    const anchor = freeCellRingPoint({ x: 9, y: 9 }, view);

    expect(anchor.x).toBe(685);
    expect(anchor.y).toBe(585);
    expect(anchor.inside).toBe(true);
    expect(anchor.reach).toBe(30 * 3.5);
    expect(anchor.dirX).toBeCloseTo(0.707, 3);
    expect(anchor.dirY).toBeCloseTo(0.707, 3);
  });

  it("starts an off-screen cell's ring outside the viewport", () => {
    const anchor = freeCellRingPoint({ x: 100, y: 0 }, view);

    // why: the ring must keep the cell's true position, not collapse onto the
    // edge, so the arc the player sees grew all the way from the cell
    expect(anchor.x).toBe(3415);
    expect(anchor.y).toBe(315);
    expect(anchor.inside).toBe(false);
    // 2615 px to the viewport plus a full diagonal sweep plus one cell
    expect(anchor.arrival).toBe(2615);
    expect(anchor.reach).toBe(2615 + 1000 + 30);
    expect(anchor.dirX).toBeCloseTo(1, 3);
    expect(anchor.dirY).toBeCloseTo(0.005, 3);
    // the chevron stays inside the viewport
    expect(anchor.edgeX).toBe(755);
    expect(anchor.edgeY).toBe(315);
  });

  it("keeps the edge anchor on an axis shorter than the inset", () => {
    const anchor = freeCellRingPoint(
      { x: 100, y: 100 },
      { ...view, width: 30, height: 30 },
    );

    expect(anchor.inside).toBe(false);
    expect(anchor.edgeX).toBe(15);
    expect(anchor.edgeY).toBe(15);
  });

  it("grows an off-screen ring from the cell across the viewport", () => {
    const anchor = freeCellRingPoint({ x: 100, y: 0 }, view);
    const cellSize = view.cellSize;

    const start = freeCellRingRadius(0, anchor, cellSize);
    const nearViewport = freeCellRingRadius(0.1, anchor, cellSize);
    const arrival = freeCellRingRadius(0.15, anchor, cellSize);
    const midSweep = freeCellRingRadius(0.5, anchor, cellSize);
    const end = freeCellRingRadius(1, anchor, cellSize);

    expect(start).toBe(cellSize * 0.4);
    expect(nearViewport).toBeLessThan(arrival);
    expect(arrival).toBeCloseTo(2615, 0);
    expect(midSweep).toBeGreaterThan(arrival);
    expect(end).toBeCloseTo(anchor.reach, 0);
  });

  it("grows a visible cell's ring to a few cells wide", () => {
    const anchor = freeCellRingPoint({ x: 9, y: 9 }, view);

    expect(freeCellRingRadius(0, anchor, view.cellSize)).toBe(12);
    expect(freeCellRingRadius(1, anchor, view.cellSize)).toBeCloseTo(105, 0);
  });
});

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
