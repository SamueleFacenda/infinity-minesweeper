import { Board } from "../../src/game/board.js";
import type {
  BoardSearchState,
  SearchReply,
  SearchRequest,
} from "../../src/game/board.js";
import type { PooledSearchWorker } from "../../src/searchPool.js";

// A pool slot that really runs the production search in-process, so tests
// exercise the pooled protocol — state transfer, stride offsets, per-cell
// precomputes, winner adoption — without spawning threads.
export class InProcessSearchWorker implements PooledSearchWorker {
  terminated = false;
  onmessage: ((event: { readonly data: SearchReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  postMessage(message: SearchRequest): void {
    let reply: SearchReply;
    if (message.perCell === true) {
      const states: Record<string, BoardSearchState> = {};
      for (const [cx, cy] of message.cells) {
        const board = Board.fromSearchState(message.state);
        const outcome = board.runPooledSearch(
          [[cx, cy]],
          message.deep,
          message.budgetMs,
          0,
          1,
        );
        if (outcome === "accepted") {
          states[`${String(cx)},${String(cy)}`] = board.searchState();
        }
      }
      reply = { id: message.id, outcome: "accepted", states };
    } else {
      const board = Board.fromSearchState(message.state);
      const outcome = board.runPooledSearch(
        message.cells,
        message.deep,
        message.budgetMs,
        message.attemptOffset,
        message.stride,
      );
      reply =
        outcome === "lost"
          ? { id: message.id, outcome, explodedAt: board.explodedAt }
          : { id: message.id, outcome, state: board.searchState() };
    }
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: reply });
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}
