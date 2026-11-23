import { describe, expect, it } from "vitest";
import {
  Board,
  type BoardSearchState,
  type SearchReply,
  type SearchRequest,
} from "../../src/game/board.js";
import { neighborCoords, parseKey } from "../../src/game/coords.js";
import { SearchPool, type PooledSearchWorker } from "../../src/searchPool.js";
import { InProcessSearchWorker as WorkingWorker } from "../helpers/pooledSearchWorker.js";

type Behavior = "accept" | "commit" | "lost" | "silent" | "error";

function stateOf(): BoardSearchState {
  return new Board(1, 0.2).searchState();
}

class FakeWorker implements PooledSearchWorker {
  readonly requests: SearchRequest[] = [];
  terminated = false;
  onmessage: ((event: { readonly data: SearchReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private readonly behavior: Behavior) {}

  postMessage(message: SearchRequest): void {
    this.requests.push(message);
    setTimeout(() => {
      if (this.terminated) return;
      if (this.behavior === "error") {
        this.onerror?.(new Error("boom"));
        return;
      }
      if (this.behavior === "silent") return;
      const reply: SearchReply =
        this.behavior === "accept"
          ? { id: message.id, outcome: "accepted", state: stateOf() }
          : this.behavior === "lost"
            ? { id: message.id, outcome: "lost", explodedAt: { x: 1, y: 1 } }
            : { id: message.id, outcome: "committed" };
      this.onmessage?.({ data: reply });
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}

function makePool(behaviors: readonly Behavior[]): {
  pool: SearchPool;
  workers: FakeWorker[];
} {
  const workers: FakeWorker[] = [];
  const pool = new SearchPool(behaviors.length, () => {
    const worker = new FakeWorker(behaviors[workers.length] ?? "commit");
    workers.push(worker);
    return worker;
  });
  return { pool, workers };
}

const request = {
  state: stateOf(),
  cells: [[1, 1]] as readonly (readonly [number, number])[],
  deep: false,
  budgetMs: 1,
};

describe("search pool", () => {
  it("gives every slot its own slice of the attempt space", async () => {
    const { pool, workers } = makePool(["accept", "accept", "accept"]);
    const result = await pool.search(request);
    expect(result.outcome).toBe("accepted");
    const ids = new Set(workers.map((worker) => worker.requests[0]?.id));
    expect(ids.size).toBe(1);
    workers.forEach((worker, index) => {
      expect(worker.requests[0]?.attemptOffset).toBe(index);
      expect(worker.requests[0]?.stride).toBe(3);
    });
    pool.dispose();
  });

  it("adopts the first accepted candidate and keeps its slots", async () => {
    const { pool, workers } = makePool(["accept", "accept"]);
    const result = await pool.search(request);
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    expect(result.state.revealed.size).toBe(0);
    // why: slots stay alive between searches, so a search pays for a
    // worker only when the one it would reuse is still busy
    expect(workers.every((worker) => worker.terminated)).toBe(false);
    // why: every slot frees itself when its own reply lands, so after the
    // in-flight replies have arrived the next search reuses both slots
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await pool.search(request);
    expect(second.outcome).toBe("accepted");
    expect(workers.length).toBe(2);
    pool.dispose();
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("ends the game on a lost first click", async () => {
    const { pool } = makePool(["lost", "accept"]);
    const result = await pool.search(request);
    expect(result).toEqual({
      outcome: "lost",
      explodedAt: { x: 1, y: 1 },
    });
    pool.dispose();
  });

  it("gives up once every slot reports committed", async () => {
    const { pool } = makePool(["commit", "commit"]);
    expect((await pool.search(request)).outcome).toBe("committed");
    pool.dispose();
  });

  it("gives up when a slot errors", async () => {
    const { pool } = makePool(["error", "commit"]);
    expect((await pool.search(request)).outcome).toBe("committed");
    pool.dispose();
  });

  it("replaces the busy slots when a new search starts", async () => {
    const { pool, workers } = makePool(["silent", "silent"]);
    const first = pool.search(request);
    const second = pool.search(request);
    // why: a slot still working on the previous search is replaced instead
    // of queued behind it, and the superseded search gives up
    expect((await first).outcome).toBe("committed");
    expect(workers.slice(0, 2).every((worker) => worker.terminated)).toBe(true);
    expect(workers.length).toBe(4);
    pool.dispose();
    expect((await second).outcome).toBe("committed");
    expect(workers.every((worker) => worker.terminated)).toBe(true);
  });

  it("adopts a pooled candidate into a consistent board", async () => {
    // why: the search of one cell pays a full deterministic playout on
    // the hard tiers, which is seconds of honest work per reveal
    const workers: WorkingWorker[] = [];
    const pool = new SearchPool(2, () => {
      const worker = new WorkingWorker();
      workers.push(worker);
      return worker;
    });
    const board = new Board(7, 0.12);
    board.reveal(0, 0);
    const target = board.findHint();
    expect(target).not.toBeNull();
    if (target === null) return;
    const result = await pool.search(
      board.pooledSearchRequest([[target.x, target.y]], false),
    );
    expect(result.outcome).toBe("accepted");
    if (result.outcome !== "accepted") return;
    const before = board.revealedCount;
    board.adoptSearchResult(result.state);
    expect(board.revealedCount).toBeGreaterThan(before);
    // why: the number-consistency walk is the soundness gate of any
    // layout-mutating generation path, pooled adoption included
    for (const [key, count] of board.revealedView) {
      const { x, y } = parseKey(key);
      let mines = 0;
      for (const [nx, ny] of neighborCoords(x, y)) {
        if (board.isMine(nx, ny)) mines += 1;
      }
      expect(mines).toBe(count);
    }
    expect(board.findHint()).not.toBeNull();
    pool.dispose();
  }, 60_000);
});

// A slot that really runs the search in-process, so the transfer and the
// adoption path are exercised with the production search.
