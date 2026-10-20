import type { ClickResult } from "./game/board.js";
import { Board } from "./game/board.js";
import type { Cell } from "./game/coords.js";
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
import { ACCENTS, applyTheme, loadThemeSettings } from "./theme.js";
import type { ThemeName } from "./theme.js";

const DRAG_THRESHOLD_PX = 4;
const ZOOM_STEP = 1.02;
const LOSS_OVERLAY_DELAY_MS = 2000;

interface Elements {
  canvas: HTMLCanvasElement;
  difficulty: HTMLSelectElement;
  flags: HTMLElement;
  cleared: HTMLElement;
  time: HTMLElement;
  hint: HTMLButtonElement;
  leaderboard: HTMLButtonElement;
  newGame: HTMLButtonElement;
  theme: HTMLButtonElement;
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
  }

  private applyAppearance(): void {
    applyTheme(this.theme, this.accent, document, window.localStorage);
    this.elements.theme.textContent =
      this.theme === "nord" ? "Nord" : "Charcoal";
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
    const rect = this.elements.canvas.getBoundingClientRect();
    return this.renderer.screenToCell(
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button === 0) {
      this.dragStart = { x: event.clientX, y: event.clientY };
      this.dragged = false;
    }
  }

  private onMouseMove(event: MouseEvent): void {
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
    this.renderer.draw();
  }

  private onMouseUp(event: MouseEvent): void {
    if (event.button !== 0 || this.dragStart === null) return;
    const wasDrag = this.dragged;
    this.dragStart = null;
    this.dragged = false;
    if (!wasDrag) this.clickCell(this.cellFromEvent(event));
  }

  private onMouseLeave(): void {
    this.dragStart = null;
    this.dragged = false;
    this.renderer.hoverCell = null;
    this.renderer.draw();
  }

  private onContextMenu(event: MouseEvent): void {
    event.preventDefault();
    if (this.board.status !== "playing") return;
    const cell = this.cellFromEvent(event);
    const wasFlagged = this.board.isFlagged(cell.x, cell.y);
    this.board.toggleFlag(cell.x, cell.y);
    const isFlagged = this.board.isFlagged(cell.x, cell.y);
    if (isFlagged !== wasFlagged) {
      this.renderer.animateFlagToggle(cell, isFlagged);
    }
    this.renderer.hintCell = null;
    this.updateStats();
    this.renderer.draw();
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
    this.renderer.draw();
  }

  private onResize(): void {
    this.renderer.resize();
    this.renderer.draw();
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
    this.renderer.draw();
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
    }
    if (result === "ok" && this.board.lastRevealed.length > 0) {
      this.renderer.animateReveal(this.board.lastRevealed, origin);
    }
    this.renderer.draw();
    if (result === "lost") {
      const explodedAt = this.board.explodedAt;
      if (explodedAt !== null) this.renderer.animateLoss(explodedAt);
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
          : "No certain move is available - this should not happen, start a new game (N)",
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
    this.updateTime();
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
  hint: requireElement("btn-hint", HTMLButtonElement),
  leaderboard: requireElement("btn-leaderboard", HTMLButtonElement),
  newGame: requireElement("btn-new", HTMLButtonElement),
  theme: requireElement("btn-theme", HTMLButtonElement),
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
