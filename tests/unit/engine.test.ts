import { describe, expect, it } from "vitest";
import {
  advancePrepare,
  handleEngineMessage,
  startPrepare,
} from "../../src/engine.js";
import type {
  EngineReply,
  EngineRequest,
  EngineSession,
} from "../../src/engine.js";
import type { Board } from "../../src/game/board.js";
import { neighborCoords, parseKey } from "../../src/game/coords.js";
import { SnapshotView } from "../../src/game/snapshot.js";
import type { EngineSnapshot } from "../../src/game/snapshot.js";
import { SearchPool } from "../../src/searchPool.js";
import { InProcessSearchWorker as PooledSearchWorker } from "../helpers/pooledSearchWorker.js";

const EASY_DENSITY = 0.12;
const GAME_ID = 1;

let requestCounter = 0;

// why: a reveal searches for its candidate and the pool searches in
// worker threads, so the handler answers asynchronously now
async function send(
  session: EngineSession,
  request: EngineRequest,
): Promise<readonly EngineReply[]> {
  requestCounter += 1;
  return handleEngineMessage(session, {
    requestId: requestCounter,
    gameId: GAME_ID,
    request,
  });
}

function stateSnapshot(replies: readonly EngineReply[]): EngineSnapshot {
  const reply = replies.find((candidate) => candidate.kind === "state");
  if (reply === undefined) {
    throw new Error("no state reply");
  }
  return reply.snapshot;
}

function preparedReplies(replies: readonly EngineReply[]) {
  return replies.filter((reply) => reply.kind === "prepared");
}

// why: the transports slice the precompute, so a test that wants the whole
// search runs startPrepare and advances it the way the worker's timer does
function drivePrepare(session: EngineSession): readonly EngineReply[] {
  const replies: EngineReply[] = [];
  startPrepare(session, GAME_ID);
  let guard = 0;
  while (session.board?.hasPendingPrepare() === true && guard < 100_000) {
    replies.push(...advancePrepare(session, GAME_ID));
    guard += 1;
  }
  return replies;
}

// why: a moved mine under a shown number is the one failure the whole
// engine design guards against, so every replayed step asserts that each
// revealed count equals the actual adjacent mines the view reports
function assertCountsConsistent(snapshot: EngineSnapshot, view: SnapshotView) {
  for (const [key, count] of snapshot.revealed) {
    const { x, y } = parseKey(key);
    let mines = 0;
    for (const [nx, ny] of neighborCoords(x, y)) {
      if (view.isMine(nx, ny)) mines += 1;
    }
    expect(mines).toBe(count);
  }
}

// why: the view replicates the engine's mineAt from the terrain table, so
// the loss screen shows exactly the mines the engine would — compare the
// two over the whole neighborhood of every revealed cell
function assertViewParity(snapshot: EngineSnapshot, view: SnapshotView) {
  const board = viewBoard.get(view);
  if (board === undefined) throw new Error("view has no board");
  for (const [key] of snapshot.revealed) {
    const { x, y } = parseKey(key);
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dy = -2; dy <= 2; dy += 1) {
        const cx = x + dx;
        const cy = y + dy;
        expect(view.isMine(cx, cy)).toBe(board.isMine(cx, cy));
        expect(view.isRevealed(cx, cy)).toBe(board.isRevealed(cx, cy));
        expect(view.countAt(cx, cy)).toBe(board.countAt(cx, cy));
        expect(view.isFlagged(cx, cy)).toBe(board.isFlagged(cx, cy));
      }
    }
  }
}

const viewBoard = new WeakMap<SnapshotView, Board>();

// why: the parity check compares the view against the engine that owns
// the state, which the test can reach in-process
function wire(view: SnapshotView, session: EngineSession): SnapshotView {
  const board = session.board;
  if (board === null) throw new Error("session has no board");
  viewBoard.set(view, board);
  return view;
}

async function guidedReveals(
  session: EngineSession,
  view: SnapshotView,
  steps: number,
): Promise<void> {
  for (let step = 0; step < steps; step += 1) {
    const board = session.board;
    if (board?.status !== "playing") break;
    const hint = board.findHint();
    if (hint === null) break;
    const replies = [
      ...(await send(session, {
        kind: "reveal",
        x: hint.x,
        y: hint.y,
      })),
      ...drivePrepare(session),
    ];
    const snapshot = stateSnapshot(replies);
    view.update(snapshot);
    assertCountsConsistent(snapshot, view);
    assertViewParity(snapshot, view);
    for (const prepared of preparedReplies(replies)) {
      expect(board.hasPrepared(prepared.x, prepared.y)).toBe(true);
    }
  }
}

describe("engine handler", () => {
  it("answers a reveal without waiting for the precompute", async () => {
    const session: EngineSession = { board: null };
    await send(session, { kind: "new", seed: 7, density: EASY_DENSITY });
    const board = session.board;
    if (board === null) throw new Error("session has no board");
    const replies = await send(session, { kind: "reveal", x: 0, y: 0 });
    const snapshot = stateSnapshot(replies);
    expect(snapshot.revealed.size).toBeGreaterThan(0);
    expect(snapshot.lastRevealed.length).toBeGreaterThan(0);
    // why: the precompute is what used to sit between the reveal and its
    // answer, which left the player staring at a stale board for up to a
    // second on the deep tiers; the answer must not carry it
    expect(board.hasPendingPrepare()).toBe(false);
  });

  it("starts a new board empty and playing", async () => {
    const session: EngineSession = { board: null };
    const snapshot = stateSnapshot(
      await send(session, { kind: "new", seed: 42, density: EASY_DENSITY }),
    );
    expect(snapshot.revealed.size).toBe(0);
    expect(snapshot.status).toBe("playing");
    expect(snapshot.certainMove).toBe(false);
  });

  // why: a guided step also runs the prepare search to completion, and a
  // chain of them measures in seconds on the easy tier
  it("keeps counts, flags and the mine view consistent through a guided game", async () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    await send(session, { kind: "new", seed: 7, density: EASY_DENSITY });
    wire(view, session);
    view.update(
      stateSnapshot(await send(session, { kind: "reveal", x: 0, y: 0 })),
    );
    await guidedReveals(session, view, 15);
    expect(view.revealedCount).toBeGreaterThan(0);
  }, 60_000);

  it("reports no reveal batch for a flag toggle", async () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    await send(session, { kind: "new", seed: 3, density: EASY_DENSITY });
    wire(view, session);
    const opened = stateSnapshot(
      await send(session, { kind: "reveal", x: 0, y: 0 }),
    );
    expect(opened.lastRevealed.length).toBeGreaterThan(0);
    view.update(opened);
    const hidden = firstHiddenCell(view);
    const flagged = stateSnapshot(
      await send(session, { kind: "flag", x: hidden.x, y: hidden.y }),
    );
    expect(flagged.lastRevealed).toEqual([]);
    expect(flagged.lastFlagged).toEqual([]);
  });

  it("reports a flag placement only when the flag changed", async () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    await send(session, { kind: "new", seed: 3, density: EASY_DENSITY });
    wire(view, session);
    view.update(
      stateSnapshot(await send(session, { kind: "reveal", x: 0, y: 0 })),
    );
    const hidden = firstHiddenCell(view);
    const placed = await send(session, {
      kind: "flag",
      x: hidden.x,
      y: hidden.y,
    });
    const reply = placed.find((candidate) => candidate.kind === "state");
    if (reply === undefined) {
      throw new Error("no state reply");
    }
    expect(reply.flag).toEqual({ x: hidden.x, y: hidden.y, placed: true });
    view.update(reply.snapshot);
    expect(view.isFlagged(hidden.x, hidden.y)).toBe(true);
    const removed = stateSnapshot(
      await send(session, { kind: "flag", x: hidden.x, y: hidden.y }),
    );
    view.update(removed);
    expect(view.isFlagged(hidden.x, hidden.y)).toBe(false);
  });

  it("keeps the mine view exact after a loss", async () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    await send(session, { kind: "new", seed: 11, density: EASY_DENSITY });
    wire(view, session);
    view.update(
      stateSnapshot(await send(session, { kind: "reveal", x: 0, y: 0 })),
    );
    await guidedReveals(session, view, 15);
    const board = session.board;
    if (board === null) throw new Error("session has no board");
    const mine = findHiddenMine(board);
    expect(mine).not.toBeNull();
    if (mine === null) return;
    const lost = stateSnapshot(
      await send(session, { kind: "reveal", x: mine.x, y: mine.y }),
    );
    view.update(lost);
    expect(view.status).toBe("lost");
    expect(view.explodedAt).toEqual(mine);
    assertCountsConsistent(lost, view);
    assertViewParity(lost, view);
  }, 60_000);

  it("adopts a prepared reveal on the matching click", async () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    await send(session, { kind: "new", seed: 5, density: EASY_DENSITY });
    wire(view, session);
    view.update(
      stateSnapshot(await send(session, { kind: "reveal", x: 0, y: 0 })),
    );
    await guidedReveals(session, view, 5);
    const board = session.board;
    if (board === null) throw new Error("session has no board");
    const target = board.nextRevealTarget();
    if (target === null) return;
    board.prepareNext(target);
    board.advancePrepare(Number.POSITIVE_INFINITY);
    if (!board.hasPrepared(target.x, target.y)) return;
    const before = board.revealedCount;
    const adopted = stateSnapshot(
      await send(session, { kind: "reveal", x: target.x, y: target.y }),
    );
    view.update(adopted);
    expect(view.revealedCount).toBeGreaterThan(before);
    assertViewParity(adopted, view);
  });

  // why: with a pool the reveal is searched in worker slots and the winner
  // is adopted wholesale, so the engine path must produce the same
  // consistent board the single-threaded search produces
  it("answers a reveal through the search pool", async () => {
    const pool = new SearchPool(2, () => new PooledSearchWorker());
    const session: EngineSession = { board: null, pool };
    const view = new SnapshotView();
    try {
      await send(session, { kind: "new", seed: 7, density: 0.35 });
      wire(view, session);
      const replies = await send(session, { kind: "reveal", x: 0, y: 0 });
      const snapshot = stateSnapshot(replies);
      view.update(snapshot);
      expect(snapshot.revealed.size).toBeGreaterThan(0);
      expect(snapshot.lastRevealed.length).toBeGreaterThan(0);
      expect(snapshot.certainMove).toBe(true);
      assertCountsConsistent(snapshot, view);
      const hint = session.board?.findHint();
      expect(hint).not.toBeNull();
      if (hint === undefined || hint === null) return;
      const second = stateSnapshot(
        await send(session, { kind: "reveal", x: hint.x, y: hint.y }),
      );
      view.update(second);
      assertCountsConsistent(second, view);
      assertViewParity(second, view);
    } finally {
      pool.dispose();
    }
  }, 60_000);

  it("precomputes through the pool and adopts the prepared click", async () => {
    const pool = new SearchPool(2, () => new PooledSearchWorker());
    const session: EngineSession = { board: null, pool };
    try {
      await send(session, { kind: "new", seed: 3, density: 0.35 });
      await send(session, { kind: "reveal", x: 0, y: 0 });
      const board = session.board;
      if (board === null) throw new Error("session has no board");
      const target = board.nextRevealTarget();
      if (target === null) return;
      startPrepare(session, GAME_ID);
      for (
        let wait = 0;
        wait < 200 && !board.hasPrepared(target.x, target.y);
        wait++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(board.hasPrepared(target.x, target.y)).toBe(true);
      const before = board.revealedCount;
      const adopted = stateSnapshot(
        await send(session, { kind: "reveal", x: target.x, y: target.y }),
      );
      expect(adopted.revealed.size).toBeGreaterThan(before);
      expect(adopted.certainMove).toBe(true);
    } finally {
      pool.dispose();
    }
  }, 60_000);
});

function firstHiddenCell(view: SnapshotView) {
  for (let x = -3; x <= 3; x += 1) {
    for (let y = -3; y <= 3; y += 1) {
      if (!view.isRevealed(x, y) && !view.isFlagged(x, y)) return { x, y };
    }
  }
  throw new Error("no hidden cell");
}

function findHiddenMine(board: Board) {
  const keys = [...board.revealedView.keys()];
  for (const key of keys) {
    const { x, y } = parseKey(key);
    for (const [nx, ny] of neighborCoords(x, y)) {
      if (board.isRevealed(nx, ny) || board.isFlagged(nx, ny)) continue;
      if (board.isMine(nx, ny)) return { x: nx, y: ny };
    }
  }
  return null;
}
