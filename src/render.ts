import type { Board } from "./game/board.js";
import type { Cell } from "./game/coords.js";

// Canvas renderer for a window of the infinite board. Camera keeps world
// coordinates (cell units) of the viewport center; cells draw flat with
// rounded corners for a modern look.

const COLORS = {
  background: "#0b1120",
  hidden: "#334155",
  hiddenHover: "#475569",
  revealed: "#1e293b",
  grid: "#0b1120",
  flag: "#f59e0b",
  flagPole: "#e2e8f0",
  mine: "#fca5a5",
  exploded: "#dc2626",
  hint: "#facc15",
  numbers: [
    "#60a5fa",
    "#34d399",
    "#f87171",
    "#c084fc",
    "#fbbf24",
    "#22d3ee",
    "#f472b6",
    "#e2e8f0",
  ] as const,
};

const MIN_CELL_SIZE = 14;
const MAX_CELL_SIZE = 56;
const CELL_GAP = 1;
const CORNER_RADIUS = 3;

export class Renderer {
  cellSize = 30;
  cameraX = 0;
  cameraY = 0;
  hintCell: Cell | null = null;
  hoverCell: Cell | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private board: Board,
  ) {}

  setBoard(board: Board): void {
    this.board = board;
    this.hintCell = null;
    this.hoverCell = null;
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
    this.ctx.fillStyle = COLORS.background;
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

  private drawCell(x: number, y: number): void {
    const size = this.cellSize - CELL_GAP;
    const sx = (x - this.cameraX) * this.cellSize + this.canvas.clientWidth / 2;
    const sy =
      (y - this.cameraY) * this.cellSize + this.canvas.clientHeight / 2;
    const board = this.board;
    if (board.isRevealed(x, y)) {
      this.drawTile(sx, sy, size, COLORS.revealed);
      this.drawNumber(x, y, sx, sy, size);
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
      hiddenHover ? COLORS.hiddenHover : COLORS.hidden,
    );
    if (board.isFlagged(x, y)) {
      this.drawFlag(sx, sy, size);
    } else if (board.status === "lost" && board.isMine(x, y)) {
      this.drawMine(x, y, sx, sy, size);
    }
    if (
      this.hintCell !== null &&
      this.hintCell.x === x &&
      this.hintCell.y === y
    ) {
      this.ctx.strokeStyle = COLORS.hint;
      this.ctx.lineWidth = 3;
      this.ctx.shadowColor = COLORS.hint;
      this.ctx.shadowBlur = 10;
      this.ctx.strokeRect(sx - 1, sy - 1, size + 2, size + 2);
      this.ctx.shadowBlur = 0;
    }
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
    const palette = COLORS.numbers;
    this.ctx.fillStyle = palette[(count - 1) % palette.length] ?? "#e2e8f0";
    this.ctx.font = `600 ${String(Math.round(size * 0.5))}px system-ui, sans-serif`;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "middle";
    this.ctx.fillText(String(count), sx + size / 2, sy + size / 2 + 1);
  }

  private drawFlag(sx: number, sy: number, size: number): void {
    const cx = sx + size * 0.42;
    const cy = sy + size * 0.22;
    this.ctx.strokeStyle = COLORS.flagPole;
    this.ctx.lineWidth = Math.max(1.5, size * 0.06);
    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy);
    this.ctx.lineTo(cx, sy + size * 0.78);
    this.ctx.stroke();
    this.ctx.fillStyle = COLORS.flag;
    this.ctx.beginPath();
    this.ctx.moveTo(cx, cy);
    this.ctx.lineTo(cx + size * 0.3, cy + size * 0.14);
    this.ctx.lineTo(cx, cy + size * 0.28);
    this.ctx.closePath();
    this.ctx.fill();
  }

  private drawMine(
    x: number,
    y: number,
    sx: number,
    sy: number,
    size: number,
  ): void {
    const exploded =
      this.board.explodedAt !== null &&
      this.board.explodedAt.x === x &&
      this.board.explodedAt.y === y;
    if (exploded) {
      this.drawTile(sx, sy, size, COLORS.exploded);
    }
    const cx = sx + size / 2;
    const cy = sy + size / 2;
    const radius = size * 0.22;
    this.ctx.fillStyle = COLORS.mine;
    this.ctx.beginPath();
    this.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    this.ctx.fill();
    this.ctx.strokeStyle = COLORS.mine;
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
}
