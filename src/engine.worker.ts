import { handleEngineMessage } from "./engine.js";
import type { EngineMessage, EngineReply, EngineSession } from "./engine.js";

// Dedicated engine thread: one Board owner and no frames to protect, so
// the generation search runs at full speed while the main thread stays
// free to animate. Plain tsc emits this file next to the entry, and the
// client loads it as a module worker.

const session: EngineSession = { board: null };

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
    const replies = handleEngineMessage(session, event.data);
    // why: the request id rides on every message so the client can match
    // replies and drop the ones a restarted game superseded
    for (const reply of replies) {
      scope.postMessage({ requestId: event.data.requestId, ...reply });
    }
  } catch (error) {
    scope.postMessage({
      requestId: event.data.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
