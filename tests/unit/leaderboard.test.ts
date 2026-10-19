import { describe, expect, it } from "vitest";
import { FASTEST_TARGET_TILES } from "../../src/game/difficulty.js";
import type { RunRecord } from "../../src/game/leaderboard.js";
import { Leaderboard } from "../../src/game/leaderboard.js";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  // why: satisfies the DOM Storage index signature requirement
  [name: string]: unknown;

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function record(tiles: number, seconds: number): RunRecord {
  return { tiles, seconds, date: "2026-10-18T00:00:00.000Z", seed: 1 };
}

describe("leaderboard", () => {
  it("starts empty", () => {
    const board = new Leaderboard(new MemoryStorage());
    expect(board.load()).toEqual({});
  });

  it("stores and reloads biggest runs sorted by tiles", () => {
    const storage = new MemoryStorage();
    const board = new Leaderboard(storage);
    board.recordBiggest("easy", record(100, 30));
    board.recordBiggest("easy", record(300, 90));
    board.recordBiggest("easy", record(200, 60));
    const boards = new Leaderboard(storage).load();
    const biggest = boards.easy?.biggest.map((entry) => entry.tiles);
    expect(biggest).toEqual([300, 200, 100]);
  });

  it("caps the biggest board at five entries", () => {
    const storage = new MemoryStorage();
    const board = new Leaderboard(storage);
    for (let tiles = 1; tiles <= 8; tiles++) {
      board.recordBiggest("hard", record(tiles * 10, tiles));
    }
    const boards = new Leaderboard(storage).load();
    expect(boards.hard?.biggest).toHaveLength(5);
    expect(boards.hard?.biggest[0]?.tiles).toBe(80);
  });

  it("rejects fastest entries below the target area", () => {
    const storage = new MemoryStorage();
    const board = new Leaderboard(storage);
    board.recordFastest("easy", record(FASTEST_TARGET_TILES - 1, 10));
    const boards = new Leaderboard(storage).load();
    expect(boards.easy?.fastest ?? []).toHaveLength(0);
  });

  it("sorts fastest runs by ascending seconds", () => {
    const storage = new MemoryStorage();
    const board = new Leaderboard(storage);
    board.recordFastest("easy", record(FASTEST_TARGET_TILES, 120));
    board.recordFastest("easy", record(FASTEST_TARGET_TILES + 5, 80));
    board.recordFastest("easy", record(FASTEST_TARGET_TILES, 100));
    const boards = new Leaderboard(storage).load();
    const seconds = boards.easy?.fastest.map((entry) => entry.seconds);
    expect(seconds).toEqual([80, 100, 120]);
  });

  it("keeps difficulties independent", () => {
    const storage = new MemoryStorage();
    const board = new Leaderboard(storage);
    board.recordBiggest("easy", record(50, 10));
    board.recordBiggest("hard", record(500, 10));
    const boards = new Leaderboard(storage).load();
    expect(boards.easy?.biggest[0]?.tiles).toBe(50);
    expect(boards.hard?.biggest[0]?.tiles).toBe(500);
  });

  it("resets to empty on corrupt data", () => {
    const storage = new MemoryStorage();
    storage.setItem("infinite-minesweeper.scores.v1", "{not json");
    const board = new Leaderboard(storage);
    expect(board.load()).toEqual({});
  });

  it("survives null-like payloads", () => {
    const storage = new MemoryStorage();
    storage.setItem("infinite-minesweeper.scores.v1", "null");
    const board = new Leaderboard(storage);
    expect(board.load()).toEqual({});
  });
});
