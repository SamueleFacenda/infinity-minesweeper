import { Board } from "./game/board.js";
import type { SearchReply, SearchRequest } from "./game/board.js";

// One slot of the search pool. It reconstructs the board from the
// transferred state, searches its own slice of the attempt space, and
// answers with the accepted candidate's state. Only the slot that owns
// attempt zero can end the game, exactly like the single-threaded search.
// The same file also runs under node worker_threads, which is how the
// pooled protocol is verified outside a browser.

// why: the node entry is reached through a computed specifier, so the
// browser never tries to fetch a module it cannot have
const threadsSpecifier = "node:worker_threads";
const host = globalThis as {
  process?: { versions?: { node?: string } };
};

interface ThreadsModule {
  readonly parentPort: {
    postMessage(message: SearchReply): void;
    on(message: "message", listener: (request: SearchRequest) => void): void;
  } | null;
}

const parentPort =
  host.process?.versions?.node === undefined
    ? null
    : await import(threadsSpecifier)
        .then((module: ThreadsModule) => module.parentPort)
        .catch(() => null);

interface WorkerScope {
  onmessage: ((event: MessageEvent<SearchRequest>) => void) | null;
  postMessage: (message: SearchReply) => void;
}

// why: the worker global is not typed by the DOM lib under every
// compilation setup, so the two members this file needs are declared here
const scope = globalThis as unknown as WorkerScope;

function answer(request: SearchRequest): void {
  const board = Board.fromSearchState(request.state);
  const outcome = board.runPooledSearch(
    request.cells,
    request.deep,
    request.budgetMs,
    request.attemptOffset,
    request.stride,
  );
  // why: a search that found no candidate still leaves the board in its
  // honest layout, which is exactly the reveal the single-threaded search
  // would have produced, so the state goes back either way and the caller
  // never searches twice
  const reply: SearchReply =
    outcome === "lost"
      ? { id: request.id, outcome, explodedAt: board.explodedAt }
      : { id: request.id, outcome, state: board.searchState() };
  if (parentPort === null) {
    scope.postMessage(reply);
  } else {
    parentPort.postMessage(reply);
  }
}

if (parentPort === null) {
  scope.onmessage = (event: MessageEvent<SearchRequest>): void => {
    answer(event.data);
  };
} else {
  parentPort.on("message", (request: SearchRequest) => {
    answer(request);
  });
}
