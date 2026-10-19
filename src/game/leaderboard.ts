import { FASTEST_TARGET_TILES } from "./difficulty.js";

export interface RunRecord {
  readonly tiles: number;
  readonly seconds: number;
  readonly date: string;
  readonly seed: number;
}

export interface CategoryBoards {
  biggest: RunRecord[];
  fastest: RunRecord[];
}

export type LeaderboardData = Record<string, CategoryBoards>;

const MAX_ENTRIES = 5;

// Local leaderboard persisted through an injected Storage so it works in
// the browser (localStorage) and in tests (fake storage).
export class Leaderboard {
  constructor(
    private readonly storage: Storage,
    private readonly storageKey = "infinite-minesweeper.scores.v1",
  ) {}

  load(): LeaderboardData {
    const raw = this.storage.getItem(this.storageKey);
    if (raw === null) return {};
    // why: corrupt local data should never brick the UI, scores are
    // expendable local state
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as LeaderboardData;
  }

  recordBiggest(difficultyId: string, record: RunRecord): void {
    const data = this.load();
    const boards = this.boardsFor(data, difficultyId);
    boards.biggest.push(record);
    boards.biggest.sort((a, b) => b.tiles - a.tiles || a.seconds - b.seconds);
    boards.biggest = boards.biggest.slice(0, MAX_ENTRIES);
    this.save(data);
  }

  // why: fastest measures the time to clear the target area, so anything
  // below it is not comparable across runs
  recordFastest(difficultyId: string, record: RunRecord): void {
    if (record.tiles < FASTEST_TARGET_TILES) return;
    const data = this.load();
    const boards = this.boardsFor(data, difficultyId);
    boards.fastest.push(record);
    boards.fastest.sort((a, b) => a.seconds - b.seconds || b.tiles - a.tiles);
    boards.fastest = boards.fastest.slice(0, MAX_ENTRIES);
    this.save(data);
  }

  private boardsFor(
    data: LeaderboardData,
    difficultyId: string,
  ): CategoryBoards {
    const existing = data[difficultyId];
    if (existing === undefined) {
      const fresh: CategoryBoards = { biggest: [], fastest: [] };
      data[difficultyId] = fresh;
      return fresh;
    }
    return existing;
  }

  private save(data: LeaderboardData): void {
    this.storage.setItem(this.storageKey, JSON.stringify(data));
  }
}
