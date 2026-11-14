import { describe, expect, it } from "vitest";
import { handleEngineMessage } from "../../src/engine.js";
import type {
  EngineReply,
  EngineRequest,
  EngineSession,
} from "../../src/engine.js";
import type { Board } from "../../src/game/board.js";
import { neighborCoords, parseKey } from "../../src/game/coords.js";
import { SnapshotView } from "../../src/game/snapshot.js";
import type { EngineSnapshot } from "../../src/game/snapshot.js";

const EASY_DENSITY = 0.12;
const GAME_ID = 1;

let requestCounter = 0;

function send(
  session: EngineSession,
  request: EngineRequest,
): readonly EngineReply[] {
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

function guidedReveals(
  session: EngineSession,
  view: SnapshotView,
  steps: number,
) {
  for (let step = 0; step < steps; step += 1) {
    const board = session.board;
    if (board?.status !== "playing") break;
    const hint = board.findHint();
    if (hint === null) break;
    const replies = send(session, {
      kind: "reveal",
      x: hint.x,
      y: hint.y,
    });
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
  it("starts a new board empty and playing", () => {
    const session: EngineSession = { board: null };
    const snapshot = stateSnapshot(
      send(session, { kind: "new", seed: 42, density: EASY_DENSITY }),
    );
    expect(snapshot.revealed.size).toBe(0);
    expect(snapshot.status).toBe("playing");
    expect(snapshot.certainMove).toBe(false);
  });

  // why: a guided step also runs the prepare search to completion, and a
  // chain of them measures in seconds on the easy tier
  it("keeps counts, flags and the mine view consistent through a guided game", () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    send(session, { kind: "new", seed: 7, density: EASY_DENSITY });
    wire(view, session);
    view.update(stateSnapshot(send(session, { kind: "reveal", x: 0, y: 0 })));
    guidedReveals(session, view, 15);
    expect(view.revealedCount).toBeGreaterThan(0);
  }, 60_000);

  it("reports no reveal batch for a flag toggle", () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    send(session, { kind: "new", seed: 3, density: EASY_DENSITY });
    wire(view, session);
    const opened = stateSnapshot(send(session, { kind: "reveal", x: 0, y: 0 }));
    expect(opened.lastRevealed.length).toBeGreaterThan(0);
    view.update(opened);
    const hidden = firstHiddenCell(view);
    const flagged = stateSnapshot(
      send(session, { kind: "flag", x: hidden.x, y: hidden.y }),
    );
    expect(flagged.lastRevealed).toEqual([]);
    expect(flagged.lastFlagged).toEqual([]);
  });

  it("reports a flag placement only when the flag changed", () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    send(session, { kind: "new", seed: 3, density: EASY_DENSITY });
    wire(view, session);
    view.update(stateSnapshot(send(session, { kind: "reveal", x: 0, y: 0 })));
    const hidden = firstHiddenCell(view);
    const placed = send(session, { kind: "flag", x: hidden.x, y: hidden.y });
    const reply = placed.find((candidate) => candidate.kind === "state");
    if (reply === undefined) {
      throw new Error("no state reply");
    }
    expect(reply.flag).toEqual({ x: hidden.x, y: hidden.y, placed: true });
    view.update(reply.snapshot);
    expect(view.isFlagged(hidden.x, hidden.y)).toBe(true);
    const removed = stateSnapshot(
      send(session, { kind: "flag", x: hidden.x, y: hidden.y }),
    );
    view.update(removed);
    expect(view.isFlagged(hidden.x, hidden.y)).toBe(false);
  });

  it("keeps the mine view exact after a loss", () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    send(session, { kind: "new", seed: 11, density: EASY_DENSITY });
    wire(view, session);
    view.update(stateSnapshot(send(session, { kind: "reveal", x: 0, y: 0 })));
    guidedReveals(session, view, 15);
    const board = session.board;
    if (board === null) throw new Error("session has no board");
    const mine = findHiddenMine(board);
    expect(mine).not.toBeNull();
    if (mine === null) return;
    const lost = stateSnapshot(
      send(session, { kind: "reveal", x: mine.x, y: mine.y }),
    );
    view.update(lost);
    expect(view.status).toBe("lost");
    expect(view.explodedAt).toEqual(mine);
    assertCountsConsistent(lost, view);
    assertViewParity(lost, view);
  }, 60_000);

  it("adopts a prepared reveal on the matching click", () => {
    const session: EngineSession = { board: null };
    const view = new SnapshotView();
    send(session, { kind: "new", seed: 5, density: EASY_DENSITY });
    wire(view, session);
    view.update(stateSnapshot(send(session, { kind: "reveal", x: 0, y: 0 })));
    guidedReveals(session, view, 5);
    const board = session.board;
    if (board === null) throw new Error("session has no board");
    const target = board.nextRevealTarget();
    if (target === null) return;
    board.prepareNext(target);
    board.advancePrepare(Number.POSITIVE_INFINITY);
    if (!board.hasPrepared(target.x, target.y)) return;
    const before = board.revealedCount;
    const adopted = stateSnapshot(
      send(session, { kind: "reveal", x: target.x, y: target.y }),
    );
    view.update(adopted);
    expect(view.revealedCount).toBeGreaterThan(before);
    assertViewParity(adopted, view);
  });
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
