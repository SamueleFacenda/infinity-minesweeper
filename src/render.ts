import type { Board } from "./game/board.js";
import type { Cell } from "./game/coords.js";
import { keyOf } from "./game/coords.js";
import { accentColor, canvasPalette } from "./theme.js";

// Canvas renderer for a window of the infinite board. Camera keeps world
// coordinates (cell units) of the viewport center; cells draw flat with
// rounded corners for a modern look. Cell state changes animate through
// per-cell records replayed by a requestAnimationFrame loop that only runs
// while animations are pending.

const MIN_CELL_SIZE = 14;
const MAX_CELL_SIZE = 56;
const CELL_GAP = 1;
const CORNER_RADIUS = 3;

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

interface MineSprite {
  readonly cellSize: number;
  readonly color: string;
  readonly ratio: number;
  readonly canvas: HTMLCanvasElement;
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
  private drawPending = false;
  private mineSprite: MineSprite | null = null;
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
    for (let cy = originY; cy < originY + spanY; cy++) {
      for (let cx = originX; cx < originX + spanX; cx++) {
        this.drawCell(cx, cy);
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
    this.scheduleAnimationFrame();
  }

  animateFlagRaise(cells: readonly (readonly [number, number])[]) {
    if (this.reducedMotion) return;
    const startTime = performance.now();
    for (const [x, y] of cells) {
      this.flagAnims.set(keyOf(x, y), { placing: true, startTime });
    }
    this.scheduleAnimationFrame();
  }

  animateFlagToggle(cell: Cell, placing: boolean) {
    if (this.reducedMotion) return;
    this.flagAnims.set(keyOf(cell.x, cell.y), {
      placing,
      startTime: performance.now(),
    });
    this.scheduleAnimationFrame();
  }

  animateLoss(cell: Cell) {
    if (this.reducedMotion) return;
    this.lossAnim = { cell, startTime: performance.now() };
    this.scheduleAnimationFrame();
  }

  screenToCell(px: number, py: number): Cell {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    return {
      x: Math.floor(this.cameraX + (px - width / 2) / this.cellSize),
      y: Math.floor(this.cameraY + (py - height / 2) / this.cellSize),
    };
  }

  panBy(dx: number, dy: number): void {
    this.cameraX -= dx / this.cellSize;
    this.cameraY -= dy / this.cellSize;
  }

  zoomAt(px: number, py: number, factor: number): void {
    const before = this.screenToCell(px, py);
    this.cellSize = Math.min(
      MAX_CELL_SIZE,
      Math.max(MIN_CELL_SIZE, this.cellSize * factor),
    );
    const after = this.screenToCell(px, py);
    this.cameraX += before.x - after.x;
    this.cameraY += before.y - after.y;
  }

  centerOn(cell: Cell): void {
    this.cameraX = cell.x;
    this.cameraY = cell.y;
  }

  // why: high-polling mice fire mousemove far faster than the display
  // refreshes; coalescing input redraws into the shared animation loop
  // keeps one draw per frame regardless of event rate
  requestDraw(): void {
    this.drawPending = true;
    this.scheduleAnimationFrame();
  }

  private scheduleAnimationFrame(): void {
    if (this.animFrame !== null) return;
    this.animFrame = requestAnimationFrame(() => {
      this.onAnimationFrame();
    });
  }

  private onAnimationFrame(): void {
    this.animFrame = null;
    const animationsActive = this.pruneAnimations(performance.now());
    if (!animationsActive && !this.drawPending) return;
    this.drawPending = false;
    this.draw();
    this.scheduleAnimationFrame();
  }

  private pruneAnimations(now: number): boolean {
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
    return (
      this.revealAnims.size > 0 ||
      this.flagAnims.size > 0 ||
      this.lossAnim !== null
    );
  }

  private drawCell(x: number, y: number): void {
    const size = this.cellSize - CELL_GAP;
    const sx = (x - this.cameraX) * this.cellSize + this.canvas.clientWidth / 2;
    const sy =
      (y - this.cameraY) * this.cellSize + this.canvas.clientHeight / 2;
    const board = this.board;
    const key = keyOf(x, y);
    if (board.isRevealed(x, y)) {
      const anim = this.revealAnims.get(key);
      const progress =
        anim === undefined
          ? 1
          : clamp01(
              (performance.now() - anim.startTime - anim.delay) /
                REVEAL_DURATION_MS,
            );
      this.drawRevealed(x, y, sx, sy, size, progress);
      return;
    }
    const hiddenHover =
      this.hoverCell !== null &&
      this.hoverCell.x === x &&
      this.hoverCell.y === y;
    this.drawTile(
      sx,
      sy,
      size,
      hiddenHover ? canvasPalette().hiddenHover : canvasPalette().hidden,
    );
    if (hiddenHover) this.drawAccentTint(sx, sy, size, 0.12);
    const flagAnim = this.flagAnims.get(key);
    if (board.isFlagged(x, y)) {
      this.drawFlag(sx, sy, size, flagAnim ?? null);
      if (board.status === "lost" && !board.isMine(x, y)) {
        this.drawWrongFlagCross(sx, sy, size);
      }
    } else if (flagAnim !== undefined) {
      this.drawFlag(sx, sy, size, flagAnim);
    } else if (board.status === "lost" && board.isMine(x, y)) {
      this.drawMine(x, y, sx, sy, size);
    }
    if (
      this.hintCell !== null &&
      this.hintCell.x === x &&
      this.hintCell.y === y
    ) {
      this.drawHintGlow(sx, sy, size);
    }
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
      this.drawTile(sx, sy, size, canvasPalette().hidden);
      return;
    }
    this.drawTile(sx, sy, size, canvasPalette().revealed);
    this.ctx.globalAlpha = progress;
    this.drawNumber(x, y, sx, sy, size);
    this.ctx.globalAlpha = 1 - progress;
    this.drawTile(sx, sy, size, canvasPalette().hidden);
    const flash = progress * (1 - progress) * 4 * 0.22;
    if (flash > 0.01) {
      this.ctx.globalAlpha = flash;
      this.ctx.fillStyle = "#ffffff";
      this.ctx.beginPath();
      this.ctx.roundRect(sx, sy, size, size, CORNER_RADIUS);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  private drawAccentTint(
    sx: number,
    sy: number,
    size: number,
    alpha: number,
  ): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = accentColor();
    this.ctx.beginPath();
    this.ctx.roundRect(sx, sy, size, size, CORNER_RADIUS);
    this.ctx.fill();
    this.ctx.globalAlpha = 1;
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
    this.ctx.roundRect(sx, sy, size, size, CORNER_RADIUS);
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
  // with a slight overshoot; removal plays the same curve reversed + fade
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
    this.ctx.globalAlpha = raise.alpha;
    this.ctx.strokeStyle = palette.flagPole;
    this.ctx.lineWidth = Math.max(1.5, size * 0.06);
    this.ctx.beginPath();
    this.ctx.moveTo(cx, baseY);
    this.ctx.lineTo(cx, poleTop);
    this.ctx.stroke();
    if (raise.pennant > 0) {
      const pennantY = baseY + (topY - baseY) * raise.pennant;
      this.ctx.fillStyle = palette.flag;
      this.ctx.beginPath();
      this.ctx.moveTo(cx, pennantY);
      this.ctx.lineTo(cx + size * 0.3, pennantY + size * 0.14);
      this.ctx.lineTo(cx, pennantY + size * 0.28);
      this.ctx.closePath();
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
  }

  // why: after loss, a flag on a safe cell is the player's mistake
  private drawWrongFlagCross(sx: number, sy: number, size: number): void {
    const inset = size * 0.18;
    this.ctx.strokeStyle = canvasPalette().exploded;
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
    }
    const sprite = this.mineSpriteFor(size, palette.mine);
    this.ctx.drawImage(sprite, sx, sy, size, size);
  }

  // why: after loss the viewport can hold thousands of mines; a cached
  // raster replaces 9 path operations per mine with one drawImage
  private mineSpriteFor(size: number, color: string): HTMLCanvasElement {
    const ratio = window.devicePixelRatio;
    const current = this.mineSprite;
    if (
      current?.cellSize === this.cellSize &&
      current.color === color &&
      current.ratio === ratio
    ) {
      return current.canvas;
    }
    const canvas = buildMineSprite(size, color, ratio);
    this.mineSprite = { cellSize: this.cellSize, color, ratio, canvas };
    return canvas;
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

function buildMineSprite(
  size: number,
  color: string,
  ratio: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(size * ratio);
  canvas.height = Math.ceil(size * ratio);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("sprite 2d context unavailable");
  ctx.scale(ratio, ratio);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.22;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.2, size * 0.05);
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
    ctx.beginPath();
    ctx.moveTo(cx - dx * radius, cy - dy * radius);
    ctx.lineTo(cx + dx * radius * 1.6, cy + dy * radius * 1.6);
    ctx.stroke();
  }
  return canvas;
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
