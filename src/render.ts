import type { Board } from "./game/board.js";
import type { Cell } from "./game/coords.js";
import { keyOf } from "./game/coords.js";
import { canvasPalette } from "./theme.js";

// Canvas renderer for a window of the infinite board. Camera keeps world
// coordinates (cell units) of the viewport center. Hidden cells form one
// fluid accent-colored sheet (overdrawn edgeless rects); revealed cells are
// individual rounded tiles carved into it. Cell state changes animate
// through per-cell records replayed by a requestAnimationFrame loop that
// only runs while animations are pending.

const MIN_CELL_SIZE = 14;
const MAX_CELL_SIZE = 56;
const CELL_GAP = 1;
// why: proportional radius keeps tiles equally rounded at every zoom level
const CORNER_RADIUS_RATIO = 0.1;
const MIN_CORNER_RADIUS = 1;
// why: overlap between neighboring hidden cells hides subpixel seams
// between sheet rects when the camera sits on fractional coordinates
const SHEET_OVERDRAW_PX = 0.5;

const REVEAL_DURATION_MS = 300;
const REVEAL_STAGGER_MS = 50;
const FLAG_ANIMATION_MS = 260;
const LOSS_RING_MS = 1200;

interface RevealAnimation {
  readonly startTime: number;
  readonly delay: number;
}

interface FlagAnimation {
  readonly placing: boolean;
  readonly startTime: number;
}

interface LossAnimation {
  readonly cell: Cell;
  readonly startTime: number;
}

interface FlagRaiseState {
  readonly pole: number;
  readonly pennant: number;
  readonly alpha: number;
}

export class Renderer {
  cellSize = 30;
  cameraX = 0;
  cameraY = 0;
  hintCell: Cell | null = null;
  hoverCell: Cell | null = null;

  private readonly revealAnims = new Map<string, RevealAnimation>();
  private readonly flagAnims = new Map<string, FlagAnimation>();
  private lossAnim: LossAnimation | null = null;
  private animFrame: number | null = null;
  readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    .matches;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private board: Board,
  ) {}

  setBoard(board: Board): void {
    this.board = board;
    this.hintCell = null;
    this.hoverCell = null;
    this.revealAnims.clear();
    this.flagAnims.clear();
    this.lossAnim = null;
  }

  resize(): void {
    const ratio = window.devicePixelRatio;
    this.canvas.width = Math.round(this.canvas.clientWidth * ratio);
    this.canvas.height = Math.round(this.canvas.clientHeight * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  draw(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const palette = canvasPalette();
    this.ctx.fillStyle = palette.background;
    this.ctx.fillRect(0, 0, width, height);
    const originX = Math.floor(this.cameraX - width / (2 * this.cellSize));
    const originY = Math.floor(this.cameraY - height / (2 * this.cellSize));
    const spanX = Math.ceil(width / this.cellSize) + 2;
    const spanY = Math.ceil(height / this.cellSize) + 2;
    // why: sheet first so its overdraw never bleeds over rounded tiles
    for (let cy = originY; cy < originY + spanY; cy++) {
      for (let cx = originX; cx < originX + spanX; cx++) {
        if (!this.board.isRevealed(cx, cy)) this.drawSheetCell(cx, cy);
      }
    }
    for (let cy = originY; cy < originY + spanY; cy++) {
      for (let cx = originX; cx < originX + spanX; cx++) {
        if (this.board.isRevealed(cx, cy)) this.drawCell(cx, cy);
      }
    }
    this.drawLossRing();
  }

  animateReveal(cells: readonly (readonly [number, number])[], origin: Cell) {
    if (this.reducedMotion) return;
    const startTime = performance.now();
    for (const [x, y] of cells) {
      const distance = Math.max(Math.abs(x - origin.x), Math.abs(y - origin.y));
      this.revealAnims.set(keyOf(x, y), {
        startTime,
        delay: distance * REVEAL_STAGGER_MS,
      });
    }
    this.scheduleAnimationLoop();
  }

  animateFlagRaise(cells: readonly (readonly [number, number])[]) {
    if (this.reducedMotion) return;
    const startTime = performance.now();
    for (const [x, y] of cells) {
      this.flagAnims.set(keyOf(x, y), { placing: true, startTime });
    }
    this.scheduleAnimationLoop();
  }

  animateFlagToggle(cell: Cell, placing: boolean) {
    if (this.reducedMotion) return;
    this.flagAnims.set(keyOf(cell.x, cell.y), {
      placing,
      startTime: performance.now(),
    });
    this.scheduleAnimationLoop();
  }

  animateLoss(cell: Cell) {
    if (this.reducedMotion) return;
    this.lossAnim = { cell, startTime: performance.now() };
    this.scheduleAnimationLoop();
  }

  screenToCell(px: number, py: number): Cell {
    const world = this.screenToWorld(px, py);
    return { x: Math.floor(world.x), y: Math.floor(world.y) };
  }

  private screenToWorld(px: number, py: number): Cell {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    return {
      x: this.cameraX + (px - width / 2) / this.cellSize,
      y: this.cameraY + (py - height / 2) / this.cellSize,
    };
  }

  panBy(dx: number, dy: number): void {
    this.cameraX -= dx / this.cellSize;
    this.cameraY -= dy / this.cellSize;
  }

  zoomAt(px: number, py: number, factor: number): void {
    // why: anchoring on the float world point (not the integer cell)
    // keeps the exact point under the cursor fixed across zoom steps
    const anchor = this.screenToWorld(px, py);
    this.cellSize = Math.min(
      MAX_CELL_SIZE,
      Math.max(MIN_CELL_SIZE, this.cellSize * factor),
    );
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.cameraX = anchor.x - (px - width / 2) / this.cellSize;
    this.cameraY = anchor.y - (py - height / 2) / this.cellSize;
  }

  centerOn(cell: Cell): void {
    this.cameraX = cell.x;
    this.cameraY = cell.y;
  }

  private scheduleAnimationLoop(): void {
    if (this.reducedMotion || this.animFrame !== null) return;
    this.animFrame = requestAnimationFrame(() => {
      this.animFrame = null;
      this.pruneAnimations(performance.now());
      if (
        this.revealAnims.size === 0 &&
        this.flagAnims.size === 0 &&
        this.lossAnim === null
      ) {
        return;
      }
      this.draw();
      this.scheduleAnimationLoop();
    });
  }

  private pruneAnimations(now: number): void {
    for (const [key, anim] of this.revealAnims) {
      if (now - anim.startTime - anim.delay >= REVEAL_DURATION_MS) {
        this.revealAnims.delete(key);
      }
    }
    for (const [key, anim] of this.flagAnims) {
      if (now - anim.startTime >= FLAG_ANIMATION_MS) {
        this.flagAnims.delete(key);
      }
    }
    if (
      this.lossAnim !== null &&
      now - this.lossAnim.startTime >= LOSS_RING_MS
    ) {
      this.lossAnim = null;
    }
  }

  private drawSheetCell(x: number, y: number): void {
    const sx = (x - this.cameraX) * this.cellSize + this.canvas.clientWidth / 2;
    const sy =
      (y - this.cameraY) * this.cellSize + this.canvas.clientHeight / 2;
    const board = this.board;
    const key = keyOf(x, y);
    this.ctx.fillStyle = canvasPalette().hidden;
    this.ctx.fillRect(
      sx - SHEET_OVERDRAW_PX,
      sy - SHEET_OVERDRAW_PX,
      this.cellSize + SHEET_OVERDRAW_PX * 2,
      this.cellSize + SHEET_OVERDRAW_PX * 2,
    );
    const hovered =
      this.hoverCell !== null &&
      this.hoverCell.x === x &&
      this.hoverCell.y === y;
    if (hovered) this.drawHoverOverlay(sx, sy);
    const flagAnim = this.flagAnims.get(key);
    if (board.isFlagged(x, y)) {
      this.drawFlag(sx, sy, this.cellSize, flagAnim ?? null);
      if (board.status === "lost" && !board.isMine(x, y)) {
        this.drawWrongFlagCross(sx, sy, this.cellSize);
      }
    } else if (flagAnim !== undefined) {
      this.drawFlag(sx, sy, this.cellSize, flagAnim);
    } else if (board.status === "lost" && board.isMine(x, y)) {
      this.drawMine(x, y, sx, sy, this.cellSize);
    }
    if (
      this.hintCell !== null &&
      this.hintCell.x === x &&
      this.hintCell.y === y
    ) {
      this.drawHintGlow(sx, sy, this.cellSize);
    }
  }

  private drawHoverOverlay(sx: number, sy: number): void {
    const inset = Math.max(1.5, this.cellSize * 0.08);
    const hoverSize = this.cellSize - inset * 2;
    this.ctx.globalAlpha = 0.25;
    this.ctx.fillStyle = canvasPalette().background;
    this.ctx.beginPath();
    this.ctx.roundRect(
      sx + inset,
      sy + inset,
      hoverSize,
      hoverSize,
      tileRadius(hoverSize),
    );
    this.ctx.fill();
    this.ctx.globalAlpha = 1;
  }

  private drawCell(x: number, y: number): void {
    const size = this.cellSize - CELL_GAP;
    const sx = (x - this.cameraX) * this.cellSize + this.canvas.clientWidth / 2;
    const sy =
      (y - this.cameraY) * this.cellSize + this.canvas.clientHeight / 2;
    const anim = this.revealAnims.get(keyOf(x, y));
    const progress =
      anim === undefined
        ? 1
        : clamp01(
            (performance.now() - anim.startTime - anim.delay) /
              REVEAL_DURATION_MS,
          );
    this.drawRevealed(x, y, sx, sy, size, progress);
  }

  private drawRevealed(
    x: number,
    y: number,
    sx: number,
    sy: number,
    size: number,
    progress: number,
  ): void {
    if (progress <= 0) {
      this.drawSheetRect(sx, sy, size + CELL_GAP);
      return;
    }
    this.drawTile(sx, sy, size, canvasPalette().revealed);
    this.ctx.globalAlpha = progress;
    this.drawNumber(x, y, sx, sy, size);
    this.ctx.globalAlpha = 1 - progress;
    this.drawSheetRect(sx, sy, size + CELL_GAP);
    const flash = progress * (1 - progress) * 4 * 0.22;
    if (flash > 0.01) {
      this.ctx.globalAlpha = flash;
      this.ctx.fillStyle = "#ffffff";
      this.ctx.beginPath();
      this.ctx.roundRect(sx, sy, size, size, tileRadius(size));
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  private drawSheetRect(sx: number, sy: number, cellSize: number): void {
    this.ctx.fillStyle = canvasPalette().hidden;
    this.ctx.fillRect(
      sx - SHEET_OVERDRAW_PX,
      sy - SHEET_OVERDRAW_PX,
      cellSize + SHEET_OVERDRAW_PX * 2,
      cellSize + SHEET_OVERDRAW_PX * 2,
    );
  }

  private drawHintGlow(sx: number, sy: number, size: number): void {
    this.ctx.strokeStyle = canvasPalette().hint;
    this.ctx.lineWidth = 3;
    this.ctx.shadowColor = canvasPalette().hint;
    this.ctx.shadowBlur = 10;
    this.ctx.strokeRect(sx - 1, sy - 1, size + 2, size + 2);
    this.ctx.shadowBlur = 0;
  }

  private drawTile(sx: number, sy: number, size: number, color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.roundRect(sx, sy, size, size, tileRadius(size));
    this.ctx.fill();
  }

  private drawNumber(
    x: number,
    y: number,
    sx: number,
    sy: number,
    size: number,
  ): void {
    const count = this.board.countAt(x, y);
    if (count === undefined || count === 0) return;
    const palette = canvasPalette().numbers;
    const fallback = palette[palette.length - 1] ?? "#ffffff";
    this.ctx.fillStyle = palette[(count - 1) % palette.length] ?? fallback;
    this.ctx.font = `600 ${String(Math.round(size * 0.5))}px system-ui, sans-serif`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(String(count), sx + size / 2, sy + size / 2 + 1);
  }

  private drawFlag(
    sx: number,
    sy: number,
    size: number,
    anim: FlagAnimation | null,
  ): void {
    if (anim === null) {
      this.paintFlag(sx, sy, size, { pole: 1, pennant: 1, alpha: 1 });
      return;
    }
    const t = clamp01((performance.now() - anim.startTime) / FLAG_ANIMATION_MS);
    const forward = anim.placing ? t : 1 - t;
    this.paintFlag(sx, sy, size, {
      pole: easeOutCubic(clamp01(forward / 0.55)),
      pennant: easeOutBack(clamp01((forward - 0.35) / 0.65)),
      alpha: anim.placing ? 1 : 1 - easeInCubic(t),
    });
  }

  // algorithm: raise = pole grows from the tile, then the pennant slides up
  // with a slight overshoot; removal plays the same curve reversed + fade.
  // Pole and pennant draw over a dark underlay so they stay readable when
  // the accent sheet matches their color.
  private paintFlag(
    sx: number,
    sy: number,
    size: number,
    raise: FlagRaiseState,
  ): void {
    const palette = canvasPalette();
    const cx = sx + size * 0.42;
    const baseY = sy + size * 0.78;
    const topY = sy + size * 0.22;
    const poleTop = baseY + (topY - baseY) * raise.pole;
    const poleWidth = Math.max(1.5, size * 0.06);
    this.ctx.globalAlpha = raise.alpha;
    this.ctx.lineCap = "round";
    this.ctx.strokeStyle = palette.grid;
    this.ctx.lineWidth = poleWidth + Math.max(2, size * 0.07);
    this.ctx.beginPath();
    this.ctx.moveTo(cx, baseY);
    this.ctx.lineTo(cx, poleTop);
    this.ctx.stroke();
    this.ctx.strokeStyle = palette.flagPole;
    this.ctx.lineWidth = poleWidth;
    this.ctx.beginPath();
    this.ctx.moveTo(cx, baseY);
    this.ctx.lineTo(cx, poleTop);
    this.ctx.stroke();
    if (raise.pennant > 0) {
      const pennantY = baseY + (topY - baseY) * raise.pennant;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, pennantY);
      this.ctx.lineTo(cx + size * 0.3, pennantY + size * 0.14);
      this.ctx.lineTo(cx, pennantY + size * 0.28);
      this.ctx.closePath();
      this.ctx.strokeStyle = palette.grid;
      this.ctx.lineWidth = Math.max(1.5, size * 0.05);
      this.ctx.stroke();
      this.ctx.fillStyle = palette.flag;
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  // why: after loss, a flag on a safe cell is the player's mistake; grid
  // color keeps the X readable on every accent sheet
  private drawWrongFlagCross(sx: number, sy: number, size: number): void {
    const inset = size * 0.18;
    this.ctx.strokeStyle = canvasPalette().grid;
    this.ctx.lineWidth = Math.max(1.5, size * 0.08);
    this.ctx.beginPath();
    this.ctx.moveTo(sx + inset, sy + inset);
    this.ctx.lineTo(sx + size - inset, sy + size - inset);
    this.ctx.moveTo(sx + size - inset, sy + inset);
    this.ctx.lineTo(sx + inset, sy + size - inset);
    this.ctx.stroke();
  }

  private drawMine(
    x: number,
    y: number,
    sx: number,
    sy: number,
    size: number,
  ): void {
    const palette = canvasPalette();
    const exploded =
      this.board.explodedAt !== null &&
      this.board.explodedAt.x === x &&
      this.board.explodedAt.y === y;
    if (exploded) {
      this.drawTile(sx, sy, size, palette.exploded);
      // why: border keeps the blast origin identifiable even when the
      // exploded fill matches the accent sheet
      this.ctx.strokeStyle = palette.grid;
      this.ctx.lineWidth = 3;
      this.ctx.beginPath();
      this.ctx.roundRect(sx, sy, size, size, tileRadius(size));
      this.ctx.stroke();
    }
    // why: when the accent equals the theme's mine red the body would
    // vanish into the sheet, so fall back to the darkest theme color
    const bodyColor =
      palette.mine.toLowerCase() === palette.hidden.toLowerCase()
        ? palette.grid
        : palette.mine;
    const cx = sx + size / 2;
    const cy = sy + size / 2;
    const radius = size * 0.22;
    this.ctx.fillStyle = bodyColor;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.strokeStyle = palette.grid;
    this.ctx.lineWidth = Math.max(1.2, size * 0.05);
    this.ctx.stroke();
    this.ctx.fillStyle = palette.flagPole;
    this.ctx.beginPath();
    this.ctx.arc(
      cx - radius * 0.35,
      cy - radius * 0.35,
      radius * 0.28,
      0,
      Math.PI * 2,
    );
    this.ctx.fill();
    this.ctx.strokeStyle = bodyColor;
    this.ctx.lineWidth = Math.max(1.2, size * 0.05);
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const) {
      this.ctx.beginPath();
      this.ctx.moveTo(cx - dx * radius, cy - dy * radius);
      this.ctx.lineTo(cx + dx * radius * 1.6, cy + dy * radius * 1.6);
      this.ctx.stroke();
    }
  }

  private drawLossRing(): void {
    const anim = this.lossAnim;
    if (anim === null) return;
    const t = (performance.now() - anim.startTime) / LOSS_RING_MS;
    if (t >= 1) {
      this.lossAnim = null;
      return;
    }
    const sx =
      (anim.cell.x - this.cameraX) * this.cellSize +
      this.canvas.clientWidth / 2;
    const sy =
      (anim.cell.y - this.cameraY) * this.cellSize +
      this.canvas.clientHeight / 2;
    this.ctx.globalAlpha = 0.7 * (1 - t);
    this.ctx.strokeStyle = canvasPalette().exploded;
    this.ctx.lineWidth = 2 + 4 * (1 - t);
    this.ctx.beginPath();
    this.ctx.arc(
      sx + this.cellSize / 2,
      sy + this.cellSize / 2,
      this.cellSize * (0.5 + 3 * easeOutCubic(t)),
      0,
      Math.PI * 2,
    );
    this.ctx.stroke();
    this.ctx.globalAlpha = 1;
  }
}

function tileRadius(size: number): number {
  return Math.max(MIN_CORNER_RADIUS, size * CORNER_RADIUS_RATIO);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function easeInCubic(t: number): number {
  return t ** 3;
}

function easeOutBack(t: number): number {
  const c = 1.7;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}
