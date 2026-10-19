import { describe, expect, it } from "vitest";
import { Board } from "../../src/game/board.js";
import { parseKey } from "../../src/game/coords.js";
import { solve } from "../../src/game/solver.js";

describe("solve", () => {
  it("returns nothing on an empty board", () => {
    const result = solve(new Map());
    expect(result.safe.size).toBe(0);
    expect(result.mines.size).toBe(0);
  });

  it("forces nothing from a lone number with many unknowns", () => {
    const revealed = new Map([["0,0", 1]]);
    const result = solve(revealed);
    expect(result.safe.size).toBe(0);
    expect(result.mines.size).toBe(0);
  });

  it("is sound against real generated board states", () => {
    const board = new Board(0x5eed01, 0.22);
    board.reveal(0, 0);
    for (let step = 0; step < 40; step++) {
      const result = solve(board.revealedView);
      for (const key of result.safe) {
        const { x, y } = parseKey(key);
        expect(board.isMine(x, y)).toBe(false);
      }
      for (const key of result.mines) {
        const { x, y } = parseKey(key);
        expect(board.isMine(x, y)).toBe(true);
      }
      const hint = board.findHint();
      if (hint === null) break;
      board.reveal(hint.x, hint.y);
    }
  });

  it("is deterministic for identical states", () => {
    const board = new Board(0x5eed02, 0.17);
    board.reveal(3, -2);
    const first = solve(board.revealedView);
    const second = solve(board.revealedView);
    expect([...first.safe]).toEqual([...second.safe]);
    expect([...first.mines]).toEqual([...second.mines]);
  });
});
