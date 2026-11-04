import type { ClickResult } from "./game/board.js";
import { Board } from "./game/board.js";
import type { Cell } from "./game/coords.js";
import { keyOf } from "./game/coords.js";
import type { Difficulty } from "./game/difficulty.js";
import {
  DIFFICULTIES,
  FASTEST_TARGET_TILES,
  difficultyById,
} from "./game/difficulty.js";
import type { RunRecord } from "./game/leaderboard.js";
import { Leaderboard } from "./game/leaderboard.js";
import { randomTaunt } from "./game/taunts.js";
import { Renderer } from "./render.js";
import { playFlagSound, playLossSound, playRevealSound } from "./sound.js";
import { ACCENTS, applyTheme, loadThemeSettings } from "./theme.js";
import type { ThemeName } from "./theme.js";

const DRAG_THRESHOLD_PX = 4;
const ZOOM_STEP = 1.02;
const LOSS_OVERLAY_DELAY_MS = 2000;
// why: browsers "should" not fire synthetic mouse events after a
// canceled touchend (W3C touch events), but the guard is cheap insurance
const MOUSE_SUPPRESS_AFTER_TOUCH_MS = 250;

interface Elements {
  canvas: HTMLCanvasElement;
  difficulty: HTMLSelectElement;
  flags: HTMLElement;
  cleared: HTMLElement;
  time: HTMLElement;
  state: HTMLElement;
  hint: HTMLButtonElement;
  leaderboard: HTMLButtonElement;
  newGame: HTMLButtonElement;
  theme: HTMLButtonElement;
  clickMode: HTMLButtonElement;
  accentDots: HTMLElement;
  overlay: HTMLDivElement;
  overlayTitle: HTMLElement;
  overlayText: HTMLElement;
  overlayInspect: HTMLButtonElement;
  overlayAction: HTMLButtonElement;
  modal: HTMLDivElement;
  modalClose: HTMLButtonElement;
  modalBoards: HTMLElement;
  toast: HTMLElement;
}

class Game {
  private board: Board;
  private readonly renderer: Renderer;
  private readonly leaderboard = new Leaderboard(window.localStorage);
  private timerStart: number | null = null;
  private fastestRecorded = false;
  private lastMilestone = 0;
  private dragStart: { x: number; y: number } | null = null;
  private dragged = false;
  private lossOverlayTimeout: number | null = null;
  private touchAnchor: { x: number; y: number } | null = null;
  private touchLast: { x: number; y: number } = { x: 0, y: 0 };
  private touchDragged = false;
  private touchConsumed = false;
  private touchActive = false;
  private pinchLast: { distance: number; x: number; y: number } | null = null;
  private lastTouchAt = 0;
  private flagFirst: boolean;
  private theme: ThemeName;
  private accent: string;
  private accentDotButtons: HTMLButtonElement[] = [];

  constructor(
    private readonly elements: Elements,
    private difficulty: Difficulty,
  ) {
    const ctx = this.elements.canvas.getContext("2d");
    if (ctx === null) throw new Error("canvas 2d context unavailable");
    const settings = loadThemeSettings(window.localStorage);
    this.theme = settings.theme;
    this.accent = settings.accent;
    this.board = this.newBoard();
    this.renderer = new Renderer(this.elements.canvas, ctx, this.board);
    this.flagFirst = settings.flagFirst ?? this.renderer.coarsePointer;
    this.buildAccentDots();
    this.applyAppearance();
    this.populateDifficulties();
    this.registerEvents();
    window.setInterval(() => {
      this.updateTime();
    }, 500);
    this.renderer.resize();
    this.renderer.draw();
    this.updateStats();
  }

  private newBoard(): Board {
    const seedBytes = new Uint32Array(1);
    crypto.getRandomValues(seedBytes);
    return new Board(seedBytes[0] ?? 0, this.difficulty.density);
  }

  private populateDifficulties(): void {
    for (const difficulty of DIFFICULTIES) {
      const option = document.createElement("option");
      option.value = difficulty.id;
      option.textContent = difficulty.label;
      this.elements.difficulty.appendChild(option);
    }
    this.elements.difficulty.value = this.difficulty.id;
  }

  private registerEvents(): void {
    const canvas = this.elements.canvas;
    canvas.addEventListener("mousedown", (event) => {
      this.onMouseDown(event);
    });
    canvas.addEventListener("mousemove", (event) => {
      this.onMouseMove(event);
    });
    canvas.addEventListener("mouseup", (event) => {
      this.onMouseUp(event);
    });
    canvas.addEventListener("mouseleave", () => {
      this.onMouseLeave();
    });
    canvas.addEventListener("contextmenu", (event) => {
      this.onContextMenu(event);
    });
    canvas.addEventListener(
      "wheel",
      (event) => {
        this.onWheel(event);
      },
      { passive: false },
    );
    // why: touchstart keeps its default behavior so the platform
    // long-press can fire contextmenu; touchmove/touchend preventDefault
    // suppresses the synthetic mouse sequence (stuck hover, ghost clicks)
    canvas.addEventListener(
      "touchstart",
      (event) => {
        this.onTouchStart(event);
      },
      { passive: true },
    );
    canvas.addEventListener(
      "touchmove",
      (event) => {
        this.onTouchMove(event);
      },
      { passive: false },
    );
    canvas.addEventListener(
      "touchend",
      (event) => {
        this.onTouchEnd(event);
      },
      { passive: false },
    );
    canvas.addEventListener(
      "touchcancel",
      () => {
        this.onTouchCancel();
      },
      { passive: false },
    );
    window.addEventListener("resize", () => {
      this.onResize();
    });
    window.addEventListener("keydown", (event) => {
      this.onKeyDown(event);
    });
    this.elements.difficulty.addEventListener("change", () => {
      this.onDifficultyChange();
    });
    this.elements.hint.addEventListener("click", () => {
      this.onHint();
    });
    this.elements.leaderboard.addEventListener("click", () => {
      this.showModal();
    });
    this.elements.newGame.addEventListener("click", () => {
      this.restart();
    });
    this.elements.overlayInspect.addEventListener("click", () => {
      this.hideOverlay();
    });
    this.elements.overlayAction.addEventListener("click", () => {
      this.restart();
    });
    this.elements.modalClose.addEventListener("click", () => {
      this.hideModal();
    });
    this.elements.theme.addEventListener("click", () => {
      this.theme = this.theme === "nord" ? "charcoal" : "nord";
      this.applyAppearance();
    });
    this.elements.clickMode.addEventListener("click", () => {
      this.onToggleClickMode();
    });
  }

  private onToggleClickMode(): void {
    this.flagFirst = !this.flagFirst;
    this.applyAppearance();
  }

  private applyAppearance(): void {
    applyTheme(
      this.theme,
      this.accent,
      this.flagFirst,
      document,
      window.localStorage,
    );
    this.elements.theme.textContent =
      this.theme === "nord" ? "Nord" : "Charcoal";
    this.elements.clickMode.setAttribute(
      "aria-pressed",
      this.flagFirst ? "true" : "false",
    );
    for (const dot of this.accentDotButtons) {
      dot.classList.toggle("selected", dot.dataset.accent === this.accent);
    }
    this.renderer.draw();
  }

  private buildAccentDots(): void {
    for (const preset of ACCENTS) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "accent-dot";
      dot.dataset.accent = preset.hex;
      dot.style.background = preset.hex;
      dot.setAttribute("aria-label", `Accent ${preset.name}`);
      dot.addEventListener("click", () => {
        this.accent = preset.hex;
        this.applyAppearance();
      });
      this.elements.accentDots.appendChild(dot);
      this.accentDotButtons.push(dot);
    }
  }

  private cellFromEvent(event: MouseEvent): Cell {
    return this.cellFromPoint(event.clientX, event.clientY);
  }

  private cellFromPoint(clientX: number, clientY: number): Cell {
    const rect = this.elements.canvas.getBoundingClientRect();
    return this.renderer.screenToCell(clientX - rect.left, clientY - rect.top);
  }

  private onMouseDown(event: MouseEvent): void {
    if (this.touchRecently()) return;
    if (event.button === 0) {
      this.dragStart = { x: event.clientX, y: event.clientY };
      this.dragged = false;
    }
  }

  private onMouseMove(event: MouseEvent): void {
    if (this.touchRecently()) return;
    const rect = this.elements.canvas.getBoundingClientRect();
    const cell = this.renderer.screenToCell(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    this.renderer.hoverCell = cell;
    if (this.dragStart !== null) {
      const dx = event.clientX - this.dragStart.x;
      const dy = event.clientY - this.dragStart.y;
      if (
        this.dragged ||
        Math.abs(dx) > DRAG_THRESHOLD_PX ||
        Math.abs(dy) > DRAG_THRESHOLD_PX
      ) {
        this.dragged = true;
        this.renderer.panBy(event.movementX, event.movementY);
      }
    }
    this.renderer.requestDraw();
  }

  private onMouseUp(event: MouseEvent): void {
    if (this.touchRecently()) return;
    if (event.button !== 0 || this.dragStart === null) return;
    const wasDrag = this.dragged;
    this.dragStart = null;
    this.dragged = false;
    if (!wasDrag) this.onPrimary(this.cellFromEvent(event));
  }

  private onMouseLeave(): void {
    this.dragStart = null;
    this.dragged = false;
    this.renderer.hoverCell = null;
    this.renderer.requestDraw();
  }

  // ponytail: the platform contextmenu event doubles as the mobile
  // long-press; browsers that never fire it (MDN: limited availability)
  // lose the secondary action — re-add a 500ms timer here if that bites
  private onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    if (this.touchActive) {
      if (this.touchDragged || this.touchConsumed) return;
      this.touchConsumed = true;
      this.vibrate();
    }
    this.onSecondary(this.cellFromEvent(event));
  }

  private onPrimary(cell: Cell): void {
    if (this.board.isRevealed(cell.x, cell.y)) this.clickCell(cell);
    else if (this.flagFirst) this.toggleFlagAt(cell);
    else this.clickCell(cell);
  }

  private onSecondary(cell: Cell): void {
    if (this.flagFirst) this.clickCell(cell);
    else this.toggleFlagAt(cell);
  }

  private vibrate(): void {
    // why: lib.dom declares vibrate unconditionally, but desktop
    // browsers ship without it
    (navigator as { vibrate?: (pattern: number) => boolean }).vibrate?.(30);
  }

  private touchRecently(): boolean {
    return performance.now() - this.lastTouchAt < MOUSE_SUPPRESS_AFTER_TOUCH_MS;
  }

  private toggleFlagAt(cell: Cell): void {
    if (this.board.status !== "playing") return;
    const wasFlagged = this.board.isFlagged(cell.x, cell.y);
    this.board.toggleFlag(cell.x, cell.y);
    const isFlagged = this.board.isFlagged(cell.x, cell.y);
    if (isFlagged !== wasFlagged) {
      this.renderer.animateFlagToggle(cell, isFlagged);
      playFlagSound(isFlagged);
    }
    this.renderer.hintCell = null;
    this.updateStats();
    this.renderer.requestDraw();
  }

  private onTouchStart(event: TouchEvent): void {
    this.lastTouchAt = performance.now();
    this.renderer.hoverCell = null;
    this.pinchLast = null;
    this.touchActive = true;
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      if (touch === undefined) return;
      this.touchAnchor = { x: touch.clientX, y: touch.clientY };
      this.touchLast = { x: touch.clientX, y: touch.clientY };
      this.touchDragged = false;
      this.touchConsumed = false;
    } else {
      this.touchConsumed = true;
      this.touchAnchor = null;
    }
  }

  private onTouchMove(event: TouchEvent): void {
    this.lastTouchAt = performance.now();
    // why: canceling the first touchmove of the series suppresses the
    // synthetic mouse sequence (MDN touch events) and blocks scrolling
    event.preventDefault();
    if (event.touches.length === 2) {
      this.pinch(event.touches);
      return;
    }
    if (event.touches.length !== 1 || this.touchAnchor === null) return;
    const touch = event.touches[0];
    if (touch === undefined) return;
    if (!this.touchDragged) {
      const totalX = touch.clientX - this.touchAnchor.x;
      const totalY = touch.clientY - this.touchAnchor.y;
      if (Math.hypot(totalX, totalY) > DRAG_THRESHOLD_PX) {
        this.touchDragged = true;
      }
    }
    if (this.touchDragged) {
      this.renderer.panBy(
        touch.clientX - this.touchLast.x,
        touch.clientY - this.touchLast.y,
      );
      this.renderer.requestDraw();
    }
    this.touchLast = { x: touch.clientX, y: touch.clientY };
  }

  private onTouchEnd(event: TouchEvent): void {
    this.lastTouchAt = performance.now();
    // why: a canceled touchend must not become a click or fire any
    // consequential mouse event (W3C touch events), so a tap can't
    // ghost a reveal through the mouse handlers
    event.preventDefault();
    if (event.touches.length > 0) {
      this.touchDragged = true;
      this.touchConsumed = true;
      this.touchAnchor = null;
      this.pinchLast = null;
      const touch = event.touches[0];
      if (touch !== undefined) {
        this.touchLast = { x: touch.clientX, y: touch.clientY };
      }
      return;
    }
    this.touchActive = false;
    const anchor = this.touchAnchor;
    if (anchor !== null && !this.touchDragged && !this.touchConsumed) {
      this.onPrimary(this.cellFromPoint(anchor.x, anchor.y));
    }
    this.touchAnchor = null;
    this.touchDragged = false;
    this.touchConsumed = false;
    this.pinchLast = null;
  }

  private onTouchCancel(): void {
    this.lastTouchAt = performance.now();
    this.touchActive = false;
    this.touchAnchor = null;
    this.touchDragged = false;
    this.touchConsumed = false;
    this.pinchLast = null;
  }

  private pinch(touches: TouchList): void {
    const first = touches[0];
    const second = touches[1];
    if (first === undefined || second === undefined) return;
    const midX = (first.clientX + second.clientX) / 2;
    const midY = (first.clientY + second.clientY) / 2;
    const distance = Math.hypot(
      first.clientX - second.clientX,
      first.clientY - second.clientY,
    );
    const last = this.pinchLast;
    if (last !== null && last.distance > 0 && distance > 0) {
      this.renderer.panBy(midX - last.x, midY - last.y);
      this.renderer.zoomAt(
        ...this.zoomArgs(midX, midY, distance / last.distance),
      );
      this.renderer.requestDraw();
    }
    this.pinchLast = { distance, x: midX, y: midY };
  }

  private zoomArgs(
    clientX: number,
    clientY: number,
    factor: number,
  ): [number, number, number] {
    const rect = this.elements.canvas.getBoundingClientRect();
    return [clientX - rect.left, clientY - rect.top, factor];
  }

  private onWheel(event: WheelEvent): void {
    event.preventDefault();
    const rect = this.elements.canvas.getBoundingClientRect();
    const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.renderer.zoomAt(
      event.clientX - rect.left,
      event.clientY - rect.top,
      factor,
    );
    this.renderer.requestDraw();
  }

  private onResize(): void {
    this.renderer.resize();
    this.renderer.requestDraw();
  }

  private onKeyDown(event: KeyboardEvent): void {
    const panDistance = 4;
    switch (event.key) {
      case "ArrowLeft":
        this.renderer.panBy(panDistance * this.renderer.cellSize, 0);
        break;
      case "ArrowRight":
        this.renderer.panBy(-panDistance * this.renderer.cellSize, 0);
        break;
      case "ArrowUp":
        this.renderer.panBy(0, panDistance * this.renderer.cellSize);
        break;
      case "ArrowDown":
        this.renderer.panBy(0, -panDistance * this.renderer.cellSize);
        break;
      case "h":
      case "H":
        this.onHint();
        return;
      case "n":
      case "N":
        this.restart();
        return;
      default:
        return;
    }
    this.renderer.requestDraw();
  }

  private clickCell(cell: Cell): void {
    if (this.board.status !== "playing") return;
    const result = this.board.isRevealed(cell.x, cell.y)
      ? this.board.clickNumber(cell.x, cell.y)
      : this.board.reveal(cell.x, cell.y);
    this.renderer.hintCell = null;
    this.applyResult(result, cell);
  }

  private applyResult(result: ClickResult, origin: Cell): void {
    this.startTimerIfNeeded();
    this.recordMilestones();
    this.updateStats();
    if (this.board.lastFlagged.length > 0) {
      this.renderer.animateFlagRaise(this.board.lastFlagged);
      playFlagSound(true);
    }
    if (result === "ok" && this.board.lastRevealed.length > 0) {
      this.renderer.animateReveal(this.board.lastRevealed, origin);
      playRevealSound(this.board.lastRevealed.length);
    }
    this.renderer.draw();
    if (result === "lost") {
      const explodedAt = this.board.explodedAt;
      if (explodedAt !== null) this.renderer.animateLoss(explodedAt);
      playLossSound();
      this.scheduleLossOverlay();
    }
  }

  // why: the un-blurred board (ring, mines, wrong flags) stays visible
  // until the overlay covers it; reduced motion draws no ring, so no wait
  private scheduleLossOverlay(): void {
    if (this.renderer.reducedMotion) {
      this.showLossOverlay();
      return;
    }
    this.lossOverlayTimeout = window.setTimeout(() => {
      this.lossOverlayTimeout = null;
      this.showLossOverlay();
    }, LOSS_OVERLAY_DELAY_MS);
  }

  private startTimerIfNeeded(): void {
    if (this.timerStart === null && this.board.revealedCount > 0) {
      this.timerStart = Date.now();
    }
  }

  private elapsedSeconds(): number {
    if (this.timerStart === null) return 0;
    return Math.floor((Date.now() - this.timerStart) / 1000);
  }

  // ponytail: biggest is checkpointed every 100 tiles instead of every
  // reveal, long runs persist within ~99 tiles of their peak
  private recordMilestones(): void {
    const cleared = this.board.revealedCount;
    if (cleared >= FASTEST_TARGET_TILES && !this.fastestRecorded) {
      this.fastestRecorded = true;
      this.leaderboard.recordFastest(this.difficulty.id, this.currentRecord());
    }
    if (cleared >= this.lastMilestone + 100) {
      this.lastMilestone = Math.floor(cleared / 100) * 100;
      this.leaderboard.recordBiggest(this.difficulty.id, this.currentRecord());
    }
    if (this.board.status === "lost") {
      this.leaderboard.recordBiggest(this.difficulty.id, this.currentRecord());
    }
  }

  private currentRecord(): RunRecord {
    return {
      tiles: this.board.revealedCount,
      seconds: this.elapsedSeconds(),
      date: new Date().toISOString(),
      seed: this.board.seed,
    };
  }

  private onHint(): void {
    if (this.board.status !== "playing") return;
    const hint = this.board.findHint();
    if (hint === null) {
      this.showToast(
        this.board.revealedCount === 0
          ? "Open anywhere to start - the first click is always safe"
          : "No certain move - the marked zone needs a guess",
      );
      return;
    }
    this.renderer.hintCell = hint;
    this.renderer.draw();
  }

  private onDifficultyChange(): void {
    this.difficulty = difficultyById(this.elements.difficulty.value);
    this.restart();
  }

  private restart(): void {
    if (this.lossOverlayTimeout !== null) {
      window.clearTimeout(this.lossOverlayTimeout);
      this.lossOverlayTimeout = null;
    }
    this.board = this.newBoard();
    this.renderer.setBoard(this.board);
    this.renderer.centerOn({ x: 0, y: 0 });
    this.timerStart = null;
    this.fastestRecorded = false;
    this.lastMilestone = 0;
    this.hideOverlay();
    this.updateStats();
    this.renderer.draw();
  }

  private showLossOverlay(): void {
    this.elements.overlayTitle.textContent = randomTaunt();
    this.elements.overlayText.textContent = `Cleared ${String(this.board.revealedCount)} tiles.`;
    this.elements.overlay.classList.remove("hidden");
  }

  private hideOverlay(): void {
    this.elements.overlay.classList.add("hidden");
  }

  private showModal(): void {
    const data = this.leaderboard.load();
    const boards = data[this.difficulty.id] ?? { biggest: [], fastest: [] };
    this.elements.modalBoards.replaceChildren(
      this.buildBoardTable(
        "Biggest runs",
        boards.biggest,
        (record) => `${String(record.tiles)} tiles`,
      ),
      this.buildBoardTable(
        `Fastest to ${String(FASTEST_TARGET_TILES)}`,
        boards.fastest,
        (record) => formatSeconds(record.seconds),
      ),
    );
    this.elements.modal.classList.remove("hidden");
  }

  private hideModal(): void {
    this.elements.modal.classList.add("hidden");
  }

  private buildBoardTable(
    title: string,
    records: readonly RunRecord[],
    formatValue: (record: RunRecord) => string,
  ): HTMLElement {
    const heading = document.createElement("h3");
    heading.textContent = title;
    const table = document.createElement("table");
    const body = document.createElement("tbody");
    if (records.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 2;
      cell.textContent = "No runs yet";
      row.appendChild(cell);
      body.appendChild(row);
    }
    records.forEach((record, index) => {
      const row = document.createElement("tr");
      for (const text of [
        String(index + 1),
        formatValue(record),
        shortDate(record.date),
      ]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.appendChild(cell);
      }
      body.appendChild(row);
    });
    table.appendChild(body);
    const wrapper = document.createElement("div");
    wrapper.className = "modal-board";
    wrapper.append(heading, table);
    return wrapper;
  }

  private updateStats(): void {
    this.elements.flags.textContent = `Flags ${String(this.board.flaggedCount)}`;
    this.elements.cleared.textContent = `Cleared ${String(this.board.revealedCount)}`;
    this.updateGuessZone();
    this.updateTime();
  }

  // why: the board reports hidden cells that stay ambiguous after
  // deduction; the zone is empty whenever a certain move exists
  private updateGuessZone(): void {
    const state = this.board.deductionState();
    this.renderer.guessZone = new Set(
      state.guessCells.map((cell) => keyOf(cell.x, cell.y)),
    );
    if (state.certainMove) {
      this.elements.state.textContent = "";
      this.elements.state.classList.add("hidden");
      return;
    }
    this.elements.state.textContent = `Guess zone ${String(state.guessCells.length)} cells`;
    this.elements.state.classList.remove("hidden");
  }

  private updateTime(): void {
    this.elements.time.textContent = formatSeconds(this.elapsedSeconds());
  }

  private showToast(message: string): void {
    this.elements.toast.textContent = message;
    this.elements.toast.classList.remove("hidden");
    window.setTimeout(() => {
      this.elements.toast.classList.add("hidden");
    }, 3000);
  }
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
}

function shortDate(iso: string): string {
  return iso.slice(0, 10);
}

function requireElement<T extends HTMLElement>(
  id: string,
  kind: abstract new () => T,
): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`missing element #${id}`);
  if (!(element instanceof kind))
    throw new Error(`element #${id} has unexpected type`);
  return element;
}

const elements: Elements = {
  canvas: requireElement("board-canvas", HTMLCanvasElement),
  difficulty: requireElement("difficulty", HTMLSelectElement),
  flags: requireElement("stat-flags", HTMLElement),
  cleared: requireElement("stat-cleared", HTMLElement),
  time: requireElement("stat-time", HTMLElement),
  state: requireElement("stat-state", HTMLElement),
  hint: requireElement("btn-hint", HTMLButtonElement),
  leaderboard: requireElement("btn-leaderboard", HTMLButtonElement),
  newGame: requireElement("btn-new", HTMLButtonElement),
  theme: requireElement("btn-theme", HTMLButtonElement),
  clickMode: requireElement("btn-clickmode", HTMLButtonElement),
  accentDots: requireElement("accent-dots", HTMLElement),
  overlay: requireElement("overlay", HTMLDivElement),
  overlayTitle: requireElement("overlay-title", HTMLElement),
  overlayText: requireElement("overlay-text", HTMLElement),
  overlayInspect: requireElement("overlay-inspect", HTMLButtonElement),
  overlayAction: requireElement("overlay-action", HTMLButtonElement),
  modal: requireElement("leaderboard-modal", HTMLDivElement),
  modalClose: requireElement("modal-close", HTMLButtonElement),
  modalBoards: requireElement("modal-boards", HTMLElement),
  toast: requireElement("toast", HTMLElement),
};

new Game(elements, difficultyById("medium"));
