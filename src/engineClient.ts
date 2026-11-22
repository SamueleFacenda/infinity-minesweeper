import { advancePrepare, handleEngineMessage, startPrepare } from "./engine.js";
import type {
  EngineMessage,
  EngineReply,
  EngineRequest,
  EngineSession,
  FlagPlacement,
} from "./engine.js";
import type { Cell } from "./game/coords.js";
import { SnapshotView } from "./game/snapshot.js";
import type { EngineSnapshot } from "./game/snapshot.js";

// Two transports, one protocol. The worker keeps the main thread free
// while the generation search runs; the local client drives the same
// handler in-process for environments without module workers, where the
// game falls back to the behavior it had before precompute existed.

export type EngineOutcome =
  | {
      readonly kind: "state";
      readonly snapshot: EngineSnapshot;
      readonly flag?: FlagPlacement;
      readonly freeCell?: Cell | null;
    }
  | { readonly kind: "hint"; readonly hint: Cell | null };

export interface EngineClient {
  readonly view: SnapshotView;
  request(request: EngineRequest): Promise<EngineOutcome | null>;
  newGame(seed: number, density: number): Promise<EngineOutcome | null>;
  // why: a worker that fails to load or dies mid-run is reported so the
  // app can swap in the in-process engine and keep playing
  onFailure(listener: () => void): void;
  onPrepared(listener: (cell: Cell) => void): void;
}

type WireReply = { readonly requestId: number } & EngineReply;

interface WireFailure {
  readonly requestId: number;
  readonly error: string;
}

type WireMessage = WireReply | WireFailure;

export function createEngineClient(onFailure: () => void): EngineClient {
  if (typeof Worker === "undefined") return new LocalEngineClient();
  try {
    return new WorkerEngineClient(onFailure);
  } catch {
    return new LocalEngineClient();
  }
}

export class WorkerEngineClient implements EngineClient {
  readonly view = new SnapshotView();
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    (outcome: EngineOutcome | null) => void
  >();
  private nextRequestId = 1;
  private gameId = 0;
  private failureListener: (() => void) | null = null;
  private preparedListener: ((cell: Cell) => void) | null = null;

  constructor(onFailure: () => void) {
    this.failureListener = onFailure;
    this.worker = new Worker(new URL("./engine.worker.js", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WireMessage>): void => {
      this.receive(event.data);
    };
    this.worker.onerror = (): void => {
      this.fail();
    };
  }

  request(request: EngineRequest): Promise<EngineOutcome | null> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      const message: EngineMessage = {
        requestId,
        gameId: this.gameId,
        request,
      };
      this.worker.postMessage(message);
    });
  }

  newGame(seed: number, density: number): Promise<EngineOutcome | null> {
    this.gameId += 1;
    // why: every answer of the old game is dropped instead of applied over
    // the fresh board the player just asked for
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    this.view.reset();
    return this.request({ kind: "new", seed, density });
  }

  onFailure(listener: () => void): void {
    this.failureListener = listener;
  }

  onPrepared(listener: (cell: Cell) => void): void {
    this.preparedListener = listener;
  }

  private receive(message: WireMessage): void {
    if ("error" in message) {
      const stale = this.pending.get(message.requestId);
      if (stale !== undefined) {
        this.pending.delete(message.requestId);
        stale(null);
      }
      this.fail();
      return;
    }
    if (message.kind === "prepared") {
      if (message.gameId === this.gameId) {
        this.preparedListener?.({ x: message.x, y: message.y });
      }
      return;
    }
    const resolve = this.pending.get(message.requestId);
    if (resolve === undefined) return;
    this.pending.delete(message.requestId);
    if (message.gameId !== this.gameId) {
      resolve(null);
      return;
    }
    if (message.kind === "state") this.view.update(message.snapshot);
    resolve(outcomeOf(message));
  }

  private fail(): void {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
    const listener = this.failureListener;
    this.failureListener = null;
    this.worker.terminate();
    listener?.();
  }
}

export class LocalEngineClient implements EngineClient {
  readonly view = new SnapshotView();
  private readonly session: EngineSession = { board: null };
  private gameId = 0;
  private prepareTimer: ReturnType<typeof setTimeout> | null = null;
  private failureListener: (() => void) | null = null;
  private preparedListener: ((cell: Cell) => void) | null = null;

  request(request: EngineRequest): Promise<EngineOutcome | null> {
    const message: EngineMessage = {
      requestId: 1,
      gameId: this.gameId,
      request,
    };
    return handleEngineMessage(this.session, message).then((replies) => {
      let outcome: EngineOutcome | null = null;
      for (const reply of replies) {
        outcome = this.dispatch(reply);
      }
      // why: the precompute is sliced on a timer here too, so a fallback
      // run never blocks the main thread on a deep-tier search
      startPrepare(this.session, this.gameId);
      this.schedulePrepareSlice();
      return outcome;
    });
  }

  newGame(seed: number, density: number): Promise<EngineOutcome | null> {
    this.gameId += 1;
    this.view.reset();
    return this.request({ kind: "new", seed, density });
  }

  onFailure(listener: () => void): void {
    this.failureListener = listener;
  }

  onPrepared(listener: (cell: Cell) => void): void {
    this.preparedListener = listener;
  }

  private dispatch(reply: EngineReply): EngineOutcome | null {
    if (reply.gameId !== this.gameId) return null;
    if (reply.kind === "prepared") {
      this.preparedListener?.({ x: reply.x, y: reply.y });
      return null;
    }
    if (reply.kind === "state") this.view.update(reply.snapshot);
    return outcomeOf(reply);
  }

  private schedulePrepareSlice(): void {
    if (this.prepareTimer !== null) return;
    this.prepareTimer = setTimeout(() => {
      this.prepareTimer = null;
      for (const reply of advancePrepare(this.session, this.gameId)) {
        this.dispatch(reply);
      }
      if (this.session.board?.hasPendingPrepare() === true) {
        this.schedulePrepareSlice();
      }
    }, 0);
  }
}

function outcomeOf(
  reply: Exclude<EngineReply, { kind: "prepared" }>,
): EngineOutcome {
  return reply.kind === "hint"
    ? { kind: "hint", hint: reply.hint }
    : {
        kind: "state",
        snapshot: reply.snapshot,
        flag: reply.flag,
        freeCell: reply.freeCell,
      };
}
