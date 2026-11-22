import { Board } from "../../src/game/board.js";
import type { SearchReply, SearchRequest } from "../../src/game/board.js";
import type { PooledSearchWorker } from "../../src/searchPool.js";

// A pool slot that really runs the production search in-process, so tests
// exercise the pooled protocol — state transfer, stride offsets, winner
// adoption — without spawning threads.
export class InProcessSearchWorker implements PooledSearchWorker {
  terminated = false;
  onmessage: ((event: { readonly data: SearchReply }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  postMessage(message: SearchRequest): void {
    const board = Board.fromSearchState(message.state);
    const outcome = board.runPooledSearch(
      message.cells,
      message.deep,
      message.budgetMs,
      message.attemptOffset,
      message.stride,
    );
    const reply: SearchReply =
      outcome === "accepted"
        ? { id: message.id, outcome, state: board.searchState() }
        : { id: message.id, outcome, explodedAt: board.explodedAt };
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: reply });
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }
}
