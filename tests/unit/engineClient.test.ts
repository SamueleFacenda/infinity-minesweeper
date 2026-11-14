import { describe, expect, it } from "vitest";
import { LocalEngineClient } from "../../src/engineClient.js";

// The worker transport cannot run under vitest's node environment, so the
// in-process client covers the shared handler wiring; the worker entry is
// typechecked by tsc and exercised by the browser smoke check.

describe("local engine client", () => {
  it("plays a game in-process through the shared handler", async () => {
    const client = new LocalEngineClient();
    const started = await client.newGame(9, 0.12);
    expect(started?.kind).toBe("state");
    const opened = await client.request({ kind: "reveal", x: 0, y: 0 });
    expect(opened?.kind).toBe("state");
    expect(client.view.revealedCount).toBeGreaterThan(0);
    expect(client.view.status).toBe("playing");
  });

  it("answers a hint and a flag through the view", async () => {
    const client = new LocalEngineClient();
    await client.newGame(9, 0.12);
    await client.request({ kind: "reveal", x: 0, y: 0 });
    const hint = await client.request({ kind: "hint" });
    expect(hint?.kind).toBe("hint");
    if (hint?.kind !== "hint" || hint.hint === null) return;
    expect(client.view.isRevealed(hint.hint.x, hint.hint.y)).toBe(false);

    let hidden: { x: number; y: number } | null = null;
    for (let x = -3; x <= 3 && hidden === null; x += 1) {
      for (let y = -3; y <= 3; y += 1) {
        if (!client.view.isRevealed(x, y) && !client.view.isFlagged(x, y)) {
          hidden = { x, y };
          break;
        }
      }
    }
    if (hidden === null) return;
    const flagged = await client.request({
      kind: "flag",
      x: hidden.x,
      y: hidden.y,
    });
    expect(flagged?.kind).toBe("state");
    expect(client.view.isFlagged(hidden.x, hidden.y)).toBe(true);
    expect(client.view.flaggedCount).toBe(1);
  });

  it("notifies prepared cells so the click can skip the indicator", async () => {
    const client = new LocalEngineClient();
    const prepared: { x: number; y: number }[] = [];
    client.onPrepared((cell) => prepared.push(cell));
    await client.newGame(9, 0.12);
    await client.request({ kind: "reveal", x: 0, y: 0 });
    const first = prepared.at(0);
    if (first === undefined) return;
    expect(client.view.isRevealed(first.x, first.y)).toBe(false);
  });
});
