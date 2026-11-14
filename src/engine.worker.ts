import { advancePrepare, handleEngineMessage, startPrepare } from "./engine.js";
import type { EngineMessage, EngineReply, EngineSession } from "./engine.js";

// Dedicated engine thread: one Board owner and no frames to protect, so
// the generation search runs at full speed while the main thread stays
// free to animate. Plain tsc emits this file next to the entry, and the
// client loads it as a module worker.

const session: EngineSession = { board: null };
let prepareGameId = 1;
let prepareTimer: ReturnType<typeof setTimeout> | null = null;

// why: the worker global is not typed by the DOM lib under every
// compilation setup, so the two members this file needs are declared here
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<EngineMessage>) => void) | null;
  postMessage: (message: EngineReply | EngineFailure) => void;
};

interface EngineFailure {
  readonly requestId: number;
  readonly error: string;
}

scope.onmessage = (event: MessageEvent<EngineMessage>): void => {
  try {
    const { gameId, requestId } = event.data;
    prepareGameId = gameId;
    const replies = handleEngineMessage(session, event.data);
    for (const reply of replies) scope.postMessage({ requestId, ...reply });
    // why: the precompute of the next reveal starts only once the answer is
    // on the wire, so the reveal the player just made reaches the screen
    // while the next search is still running
    startPrepare(session);
    schedulePrepareSlice();
  } catch (error) {
    scope.postMessage({
      requestId: event.data.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

function schedulePrepareSlice(): void {
  if (prepareTimer !== null) return;
  prepareTimer = setTimeout(() => {
    prepareTimer = null;
    for (const reply of advancePrepare(session, prepareGameId)) {
      scope.postMessage(reply);
    }
    if (session.board?.hasPendingPrepare() === true) schedulePrepareSlice();
  }, 0);
}
