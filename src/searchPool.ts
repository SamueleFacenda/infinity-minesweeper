import type {
  BoardSearchState,
  SearchReply,
  SearchRequest,
} from "./game/board.js";
import type { Cell } from "./game/coords.js";

// The parallel search: poolSize workers each search their own slice of
// the attempt space of the same board, so the attempts of a reveal never
// duplicate. The first accepted candidate wins, a lost first click ends
// the game, and an exhausted or broken pool reports "committed" so the
// caller falls back to its own single-threaded search. Slots stay alive
// between searches, so a search pays for a worker only when the one it
// would reuse is still busy with stale work.

// why: a message can only ever arrive after its worker's own wall-clock
// budget, so the grace only covers post-message latency, never compute
const WORKER_GRACE_MS = 400;

export type SearchWorkerFactory = () => PooledSearchWorker;

// why: the worker surface is declared structurally so tests can run the
// protocol in-process and so this module holds no browser global
export interface PooledSearchWorker {
  postMessage(message: SearchRequest): void;
  terminate(): void;
  onmessage: ((event: { readonly data: SearchReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface PooledSearchRequest {
  readonly state: BoardSearchState;
  readonly cells: readonly (readonly [number, number])[];
  readonly deep: boolean;
  readonly budgetMs: number;
  // why: an idle precompute carries one search per cell, so a slot
  // searches each of its assigned cells on its own and the answers merge
  readonly perCell?: boolean;
}

export type PooledSearchResult =
  | { readonly outcome: "accepted"; readonly state: BoardSearchState }
  | {
      readonly outcome: "prepared";
      readonly states: Readonly<Record<string, BoardSearchState>>;
    }
  | {
      readonly outcome: "committed";
      readonly state?: BoardSearchState;
    }
  | { readonly outcome: "lost"; readonly explodedAt: Cell | null };

export class SearchPool {
  // why: slots stay alive between searches, so a search pays for a worker
  // only when the one it would reuse is still busy with stale work
  private slots: PooledSlot[] = [];
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly size: number,
    private readonly factory: SearchWorkerFactory,
  ) {
    this.spawn();
  }

  search(request: PooledSearchRequest): Promise<PooledSearchResult> {
    if (this.disposed || this.slots.length === 0) {
      return Promise.resolve({ outcome: "committed" });
    }
    // why: a slot still working on the previous search cannot take this
    // one, so it is replaced instead of queued behind stale work
    const active = this.slots.map((slot) =>
      slot.busy ? this.replace(slot) : slot,
    );
    const id = this.nextId++;
    return new Promise<PooledSearchResult>((resolve) => {
      let settled = false;
      let gaveUp = 0;
      // why: an exhausted search still leaves the board in its honest
      // layout, so the first exhausted slot's state is kept as the answer
      // for the case where no slot accepts, instead of searching again
      let exhausted: BoardSearchState | undefined;
      // why: a per-cell precompute waits for every slot and merges, so the
      // searched state of each certain move comes back with one request
      const merged: Record<string, BoardSearchState> = {};
      const perCell = request.perCell === true;
      const required = active.length;
      const finish = (result: PooledSearchResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(grace);
        // why: the winner's siblings keep their workers for the next
        // search; each frees itself when its own reply lands
        resolve(result);
      };
      const giveUp = (): void => {
        gaveUp += 1;
        if (gaveUp >= required) {
          finish(
            perCell
              ? { outcome: "prepared", states: merged }
              : exhausted === undefined
                ? { outcome: "committed" }
                : { outcome: "committed", state: exhausted },
          );
        }
      };
      const grace = setTimeout(() => {
        finish({ outcome: "committed" });
      }, request.budgetMs + WORKER_GRACE_MS);
      active.forEach((slot, index) => {
        // why: a per-cell precompute hands each slot its own share of the
        // cells, and every search of a cell runs the whole attempt space
        const assigned = perCell
          ? request.cells.filter((_, cell) => cell % active.length === index)
          : request.cells;
        slot.worker.onmessage = (event): void => {
          if (!slot.busy) return;
          const reply = event.data;
          // why: any reply means the slot finished its work, so the slot
          // is free again even when the reply belongs to an older search
          slot.busy = false;
          if (reply.id !== id) return;
          if (reply.states !== undefined) {
            Object.assign(merged, reply.states);
          }
          if (perCell) {
            giveUp();
            return;
          }
          if (reply.outcome === "accepted" && reply.state !== undefined) {
            finish({ outcome: "accepted", state: reply.state });
            return;
          }
          if (reply.outcome === "lost") {
            finish({
              outcome: "lost",
              explodedAt: reply.explodedAt ?? null,
            });
            return;
          }
          if (reply.state !== undefined && exhausted === undefined) {
            exhausted = reply.state;
          }
          giveUp();
        };
        slot.worker.onerror = (): void => {
          if (!slot.busy) return;
          slot.busy = false;
          giveUp();
        };
        slot.busy = true;
        const message: SearchRequest = {
          id,
          state: request.state,
          cells: assigned,
          deep: request.deep,
          budgetMs: request.budgetMs,
          attemptOffset: perCell ? 0 : index,
          stride: active.length,
          perCell: request.perCell,
        };
        slot.worker.postMessage(message);
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
  }

  private replace(slot: PooledSlot): PooledSlot {
    const index = this.slots.indexOf(slot);
    slot.worker.terminate();
    const fresh: PooledSlot = { worker: this.factory(), busy: false };
    if (index === -1) this.slots.push(fresh);
    else this.slots[index] = fresh;
    return fresh;
  }

  private spawn(): void {
    if (this.disposed) return;
    try {
      for (let slot = 0; slot < this.size; slot++) {
        this.slots.push({ worker: this.factory(), busy: false });
      }
    } catch {
      // why: a pool that cannot start leaves the caller on its
      // single-threaded path, exactly like a run without worker support
      this.dispose();
    }
  }
}

interface PooledSlot {
  readonly worker: PooledSearchWorker;
  busy: boolean;
}

export function createSearchPool(): SearchPool | null {
  if (typeof Worker === "undefined") return null;
  const cores =
    typeof navigator === "undefined" ? 4 : navigator.hardwareConcurrency;
  // why: one core stays free for the engine worker and the main thread,
  // and a wider pool only ever splits work that is rarely divisible
  const size = Math.max(1, Math.min(6, cores - 1));
  try {
    return new SearchPool(size, () => {
      const worker = new Worker(
        new URL("./search.worker.js", import.meta.url),
        {
          type: "module",
        },
      );
      return worker as unknown as PooledSearchWorker;
    });
  } catch {
    return null;
  }
}
