import { describe, expect, it } from "vitest";
import { Board } from "../../src/game/board.js";
import {
  DIFFICULTIES,
  FASTEST_TARGET_TILES,
} from "../../src/game/difficulty.js";

function guidedSteps(density: number): number {
  if (density > 0.32) return 60;
  if (density > 0.27) return 90;
  return 150;
}

function playGuided(board: Board, steps: number): void {
  for (let step = 0; step < steps; step++) {
    const hint = board.findHint();
    // why: the no-guess guarantee means a certain move always exists
    expect(hint, "board stuck without a certain move").not.toBeNull();
    if (hint === null) return;
    expect(board.reveal(hint.x, hint.y)).toBe("ok");
    expect(board.status).toBe("playing");
  }
}

describe("board", () => {
  it("opens a safe area on the first click", () => {
    const board = new Board(42, 0.22);
    expect(board.reveal(0, 0)).toBe("ok");
    expect(board.revealedCount).toBeGreaterThanOrEqual(9);
    expect(board.countAt(0, 0)).toBe(0);
  });

  it("never requires a guess across guided play on every difficulty", () => {
    DIFFICULTIES.forEach((difficulty, index) => {
      const board = new Board(0xfeed000 + index, difficulty.density);
      board.reveal(-3, 7);
      playGuided(board, guidedSteps(difficulty.density));
      expect(board.revealedCount).toBeGreaterThan(40);
    });
  });

  it("keeps the no-guess guarantee for many seeds", () => {
    for (let seed = 1; seed <= 5; seed++) {
      const board = new Board(seed * 7919, 0.22);
      board.reveal(11, -5);
      playGuided(board, 100);
      expect(board.status).toBe("playing");
    }
  });

  it("keeps the no-guess guarantee on hard tiers across seeds", () => {
    for (const density of [0.26, 0.3, 0.35]) {
      for (let seed = 1; seed <= 2; seed++) {
        const board = new Board(
          seed * 104729 + Math.round(density * 1000),
          density,
        );
        board.reveal(4, -9);
        playGuided(board, 40);
        expect(board.status).toBe("playing");
      }
    }
  });

  it("toggles flags on hidden cells only", () => {
    const board = new Board(1, 0.17);
    board.reveal(0, 0);
    board.toggleFlag(0, 0);
    expect(board.isFlagged(0, 0)).toBe(false);
    board.toggleFlag(50, 50);
    expect(board.isFlagged(50, 50)).toBe(true);
    board.toggleFlag(50, 50);
    expect(board.isFlagged(50, 50)).toBe(false);
  });

  it("ignores reveals on flagged cells", () => {
    const board = new Board(2, 0.17);
    board.toggleFlag(60, 60);
    const before = board.revealedCount;
    board.reveal(60, 60);
    expect(board.revealedCount).toBe(before);
  });

  it("chords safely when flags match the real mines", () => {
    const board = new Board(3, 0.22);
    board.reveal(0, 0);
    const target = findChordTarget(board);
    if (target === null) return;
    const [x, y, unknownBefore] = target;
    expect(board.clickNumber(x, y)).toBe("ok");
    expect(board.status).toBe("playing");
    expect(board.revealedCount).toBeGreaterThan(unknownBefore);
  });

  it("treats number clicks on fully revealed neighborhoods as no-ops", () => {
    const board = new Board(4, 0.12);
    board.reveal(0, 0);
    const zero = findZeroCell(board);
    if (zero === null) return;
    const before = board.revealedCount;
    expect(board.clickNumber(zero.x, zero.y)).toBe("ok");
    expect(board.revealedCount).toBe(before);
  });

  it("clears the last changed-cell batches on no-op clicks", () => {
    const board = new Board(42, 0.12);
    board.reveal(0, 0);
    expect(board.lastRevealed.length).toBeGreaterThan(0);
    board.reveal(0, 0);
    expect(board.lastRevealed).toEqual([]);
    expect(board.lastFlagged).toEqual([]);
    board.clickNumber(900, -900);
    expect(board.lastRevealed).toEqual([]);
    expect(board.lastFlagged).toEqual([]);
  });
});

function findChordTarget(board: Board): [number, number, number] | null {
  for (const [key, count] of board.revealedView) {
    if (count === 0) continue;
    const [x, y] = key.split(",").map(Number) as [number, number];
    const flagged: [number, number][] = [];
    let unknown = 0;
    let mines = 0;
    for (const [nx, ny] of neighbors(x, y)) {
      if (board.isRevealed(nx, ny)) continue;
      if (board.isMine(nx, ny)) {
        board.toggleFlag(nx, ny);
        flagged.push([nx, ny]);
        mines++;
      } else {
        unknown++;
      }
    }
    if (mines === count && unknown > 0) return [x, y, board.revealedCount];
    for (const [nx, ny] of flagged) board.toggleFlag(nx, ny);
  }
  return null;
}

function findZeroCell(board: Board): { x: number; y: number } | null {
  for (const [key, count] of board.revealedView) {
    if (count !== 0) continue;
    const [x, y] = key.split(",").map(Number) as [number, number];
    return { x, y };
  }
  return null;
}

function neighbors(x: number, y: number): [number, number][] {
  return [
    [x - 1, y - 1],
    [x, y - 1],
    [x + 1, y - 1],
    [x - 1, y],
    [x + 1, y],
    [x - 1, y + 1],
    [x, y + 1],
    [x + 1, y + 1],
  ];
}

describe("run metrics", () => {
  // shortcut: whole board plays in ~10s; raise the timeout before the board gets slower
  it("fastest target is reachable within guided play on easy", () => {
    const board = new Board(0xbeef, 0.12);
    board.reveal(0, 0);
    playGuided(board, 400);
    expect(board.revealedCount).toBeGreaterThanOrEqual(FASTEST_TARGET_TILES);
  }, 60_000);
});
