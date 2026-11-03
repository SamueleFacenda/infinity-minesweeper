import { describe, expect, it } from "vitest";
import { cornerCollapseRegistrations } from "../../src/render.js";

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
