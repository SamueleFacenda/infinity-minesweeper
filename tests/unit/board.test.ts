import { describe, expect, it } from "vitest";
import { Board } from "../../src/game/board.js";
import { keyOf } from "../../src/game/coords.js";
import {
  DIFFICULTIES,
  FASTEST_TARGET_TILES,
  difficultyById,
} from "../../src/game/difficulty.js";

function guidedSteps(density: number): number {
  if (density > 0.32) return 60;
  if (density > 0.27) return 90;
  return 150;
}

function playGuided(board: Board, steps: number): void {
  for (let step = 0; step < steps; step++) {
    const hint = board.findHint();
    if (hint === null) {
      // why: the generator either keeps a certain move available or the
      // board marks the ambiguous zone; a stuck board without a marking
      // is the failure this guards against
      expect(board.deductionState().guessCells.length).toBeGreaterThan(0);
      return;
    }
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
    // why: the generator searches several candidates per reveal on the
    // deep tiers, so the whole ladder costs more than a frame budget
  }, 60_000);

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

  it("opens every difficulty with terrain that survives the playout", () => {
    // why: the opening playout depth of the hardest tier, enforced by the
    // generator for every difficulty
    const guaranteed = 50;
    DIFFICULTIES.forEach((difficulty, index) => {
      const board = new Board(0xfeed100 + index, difficulty.density);
      board.reveal(0, 0);
      for (let step = 0; step < guaranteed; step++) {
        const hint = board.findHint();
        expect(
          hint,
          `${difficulty.id} stalled at step ${String(step)}`,
        ).not.toBeNull();
        if (hint === null) return;
        expect(board.reveal(hint.x, hint.y)).toBe("ok");
      }
      expect(board.revealedCount).toBeGreaterThan(guaranteed);
    });
  }, 30_000);

  it("keeps a long deterministic chain on every tier", () => {
    // why: the compensated ladder plus quota modulation keeps natural
    // chains long on the easier tiers and the deep tiers deliberately
    // shorter; the median moves before a marked zone are the contract
    const floors: readonly (readonly [string, number, number])[] = [
      ["expert", difficultyById("expert").density, 300],
      ["evil", difficultyById("evil").density, 200],
      ["insane", difficultyById("insane").density, 100],
    ];
    for (const [name, density, floor] of floors) {
      const chains: number[] = [];
      for (let seed = 1; seed <= 6; seed++) {
        const board = new Board(seed * 7919 + 13, density);
        board.reveal(0, 0);
        let steps = 0;
        for (; steps < 400; steps++) {
          const hint = board.findHint();
          if (hint === null) break;
          expect(board.reveal(hint.x, hint.y)).toBe("ok");
        }
        chains.push(steps);
        expect(board.status).toBe("playing");
      }
      chains.sort((a, b) => a - b);
      const median = chains[3];
      expect(
        median,
        `${name} median chain ${String(median)} below ${String(floor)}`,
      ).toBeGreaterThanOrEqual(floor);
    }
  }, 300_000);

  it("frees a safe cell from a guess zone and keeps the run going", () => {
    // why: a player who refuses to guess must never be forced to end a
    // run; the free cell is a real cell of the fixed layout, so opening
    // it never explodes
    let freed = 0;
    for (let seed = 1; seed <= 2; seed++) {
      const board = new Board(seed * 104729 + 600, 0.6);
      board.reveal(0, 0);
      for (let step = 0; step < 120; step++) {
        const hint = board.findHint();
        if (hint !== null) {
          expect(board.reveal(hint.x, hint.y)).toBe("ok");
          continue;
        }
        const cell = board.freeCell();
        if (cell === null) break;
        freed++;
        expect(board.isMine(cell.x, cell.y)).toBe(false);
        expect(board.status).toBe("playing");
      }
      expect(board.status).toBe("playing");
    }
    expect(freed).toBeGreaterThan(0);
  }, 300_000);

  it("refuses the free cell while a certain move exists", () => {
    const board = new Board(42, 0.35);
    board.reveal(0, 0);
    expect(board.findHint()).not.toBeNull();
    expect(board.freeCell()).toBeNull();
    expect(board.revealedCount).toBeGreaterThan(0);
  });

  it("never opens cells the click did not reach", () => {
    // why: the removed rescue-pin fallback revealed a disconnected
    // mine-free patch as part of an unrelated click
    for (const density of [0.22, 0.3, 0.35]) {
      for (let seed = 1; seed <= 3; seed++) {
        const board = new Board(seed * 104729 + density * 1000, density);
        board.reveal(0, 0);
        for (let step = 0; step < 40; step++) {
          const hint = board.findHint();
          if (hint === null) break;
          board.reveal(hint.x, hint.y);
          if (board.lastRevealed.length === 0) continue;
          const reached = connectedCells(board, hint);
          for (const [x, y] of board.lastRevealed) {
            expect(reached.has(keyOf(x, y))).toBe(true);
          }
        }
      }
    }
  }, 30_000);

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

function connectedCells(
  board: Board,
  from: { x: number; y: number },
): Set<string> {
  const reached = new Set<string>([keyOf(from.x, from.y)]);
  const queue: [number, number][] = [[from.x, from.y]];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) break;
    for (const [nx, ny] of neighbors(current[0], current[1])) {
      const key = keyOf(nx, ny);
      if (reached.has(key) || !board.isRevealed(nx, ny)) continue;
      reached.add(key);
      queue.push([nx, ny]);
    }
  }
  return reached;
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
