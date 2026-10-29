import type { Board } from "./game/board.js";
import type { Cell } from "./game/coords.js";
import { keyOf } from "./game/coords.js";
import type { CanvasPalette } from "./theme.js";
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
// why: island corners (tile corners facing hidden terrain on both sides)
// round far more than interior tile corners for a smooth island outline
const ISLAND_CORNER_RADIUS_RATIO = 0.4;
// why: overlap between neighboring hidden cells hides subpixel seams
// between sheet rects when the camera sits on fractional coordinates
const SHEET_OVERDRAW_PX = 0.5;
// why: halo bands and the sheet share the accent color, so a concave
// corner needs no accent rim — the grout pocket fills the rounded
// corner all the way to its arc and meets the sheet directly

const MINE_SPIKES: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

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

interface TileTerrain {
  readonly left: boolean;
  readonly right: boolean;
  readonly top: boolean;
  readonly bottom: boolean;
  readonly topLeft: boolean;
  readonly topRight: boolean;
  readonly bottomLeft: boolean;
  readonly bottomRight: boolean;
}

interface ConcavePaint {
  readonly x: number;
  readonly y: number;
  readonly sx: number;
  readonly sy: number;
  readonly size: number;
  readonly terrain: TileTerrain;
}

interface MineSprite {
  readonly cellSize: number;
  readonly colors: string;
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
  private readonly concavePaints: ConcavePaint[] = [];
  private readonly snapXs = new Map<number, number>();
  private readonly snapYs = new Map<number, number>();
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
    // why: cell lines snap to a half-device-pixel lattice so every tile
    // and band edge is antialiased at every zoom and pixel ratio —
    // camera phases that align edges with device pixels otherwise
    // render isolated razor-sharp accent lines
    this.snapXs.clear();
    this.snapYs.clear();
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
    // why: concave bites paint after every halo band so no later band can
    // slice through a bite's legs
    this.flushConcaveCorners();
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
    const now = performance.now();
    const hadAnimations =
      this.revealAnims.size > 0 ||
      this.flagAnims.size > 0 ||
      this.lossAnim !== null;
    const animationsActive = this.pruneAnimations(now);
    // why: the frame that prunes the last animation must still draw —
    // otherwise the canvas keeps the previous mid-animation frame frozen
    // on screen (pockets stuck short of their full radius)
    if (!animationsActive && !this.drawPending && !hadAnimations) return;
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

  private drawSheetCell(x: number, y: number): void {
    const sx = this.snapX(x);
    const sy = this.snapY(y);
    const cellW = this.snapX(x + 1) - sx;
    const cellH = this.snapY(y + 1) - sy;
    const board = this.board;
    const key = keyOf(x, y);
    this.ctx.fillStyle = canvasPalette().hidden;
    // why: unconditional overlap gives every shared sheet edge full pixel
    // coverage — partial overdraw leaves a few percent of background
    // bleed on lattice-snapped edges, reading as a faint per-cell grid.
    // Overdraw into revealed cells lands under their halo bands; the
    // grout pocket painted last owns the concave vertex zones.
    this.ctx.fillRect(
      sx - SHEET_OVERDRAW_PX,
      sy - SHEET_OVERDRAW_PX,
      cellW + SHEET_OVERDRAW_PX * 2,
      cellH + SHEET_OVERDRAW_PX * 2,
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
    const sx = this.snapX(x);
    const sy = this.snapY(y);
    const size = this.snapX(x + 1) - sx - CELL_GAP;
    const progress = this.revealProgressFor(keyOf(x, y));
    this.drawRevealed(x, y, sx, sy, size, progress);
  }

  // why: cell lines snap to half-device-pixel coordinates; per-cell sizes
  // vary by at most one device pixel, which no rendered element reveals
  private snapX(cellIndex: number): number {
    let snapped = this.snapXs.get(cellIndex);
    if (snapped === undefined) {
      const raw =
        (cellIndex - this.cameraX) * this.cellSize +
        this.canvas.clientWidth / 2;
      snapped = snapToLattice(raw, this.canvas);
      this.snapXs.set(cellIndex, snapped);
    }
    return snapped;
  }

  private snapY(cellIndex: number): number {
    let snapped = this.snapYs.get(cellIndex);
    if (snapped === undefined) {
      const raw =
        (cellIndex - this.cameraY) * this.cellSize +
        this.canvas.clientHeight / 2;
      snapped = snapToLattice(raw, this.canvas);
      this.snapYs.set(cellIndex, snapped);
    }
    return snapped;
  }

  private revealProgressFor(key: string): number {
    const anim = this.revealAnims.get(key);
    if (anim === undefined) return 1;
    return clamp01(
      (performance.now() - anim.startTime - anim.delay) / REVEAL_DURATION_MS,
    );
  }

  // why: a concave corner comes into existence when the last of its three
  // revealed cells settles, so the bite grows with the slowest of their
  // reveal animations instead of popping in
  private biteProgress(cells: readonly (readonly [number, number])[]): number {
    let progress = 1;
    for (const [x, y] of cells) {
      const cellProgress = this.revealProgressFor(keyOf(x, y));
      if (cellProgress < progress) progress = cellProgress;
    }
    return progress;
  }

  private drawRevealed(
    x: number,
    y: number,
    tsx: number,
    tsy: number,
    size: number,
    progress: number,
  ): void {
    if (progress <= 0) {
      this.drawSheetRect(tsx, tsy, size + CELL_GAP);
      return;
    }
    const terrain = this.tileTerrain(x, y);
    const radii = tileRadii(terrain, size);
    this.paintIslandHalo(tsx, tsy, size, terrain);
    this.drawTile(tsx, tsy, size, canvasPalette().revealed, radii);
    this.paintNotchCorners(tsx, tsy, size, terrain);
    this.ctx.globalAlpha = progress;
    this.drawNumber(x, y, tsx, tsy, size);
    this.ctx.globalAlpha = 1 - progress;
    this.drawSheetRect(tsx, tsy, size + CELL_GAP);
    const flash = progress * (1 - progress) * 4 * 0.22;
    if (flash > 0.01) {
      this.ctx.globalAlpha = flash;
      this.ctx.fillStyle = "#ffffff";
      this.ctx.beginPath();
      this.ctx.roundRect(tsx, tsy, size, size, radii);
      this.ctx.fill();
    }
    this.ctx.globalAlpha = 1;
    if (hasConcaveCorner(terrain)) {
      this.concavePaints.push({ x, y, sx: tsx, sy: tsy, size, terrain });
    }
  }

  // why: the accent halo fills the border zone around a tile (the gaps the
  // tile leaves inside its cell plus the big-radius corner cuts) so the
  // island edge reads as sheet meeting tile directly, not dark background
  private paintIslandHalo(
    sx: number,
    sy: number,
    size: number,
    terrain: TileTerrain,
  ): void {
    const cellSize = size + CELL_GAP;
    const radius = islandRadius(size);
    this.ctx.fillStyle = canvasPalette().hidden;
    // why: bands run flush along the tile body edge and stop at the cell
    // edges — an into-body overlap only ever showed as accent tabs in the
    // mortar where a band end crossed a tile gap, and along-axis overshoot
    // spilled into neighboring cells' mortar
    if (terrain.top) {
      this.ctx.fillRect(sx, sy - 1, cellSize, 1);
    }
    if (terrain.left) {
      this.ctx.fillRect(sx - 1, sy, 1, cellSize);
    }
    if (terrain.right) {
      this.ctx.fillRect(sx + size, sy, 1.5, cellSize);
    }
    if (terrain.bottom) {
      this.ctx.fillRect(sx, sy + size, cellSize, 1.5);
    }
    if (terrain.left && terrain.top) {
      this.ctx.fillRect(sx - 1, sy - 1, radius + 2, radius + 2);
    }
    if (terrain.right && terrain.top) {
      this.ctx.fillRect(sx + size - radius - 1, sy - 1, radius + 2, radius + 2);
    }
    if (terrain.right && terrain.bottom) {
      this.ctx.fillRect(
        sx + size - radius - 1,
        sy + size - radius - 1,
        radius + 2,
        radius + 2,
      );
    }
    if (terrain.left && terrain.bottom) {
      this.ctx.fillRect(sx - 1, sy + size - radius - 1, radius + 2, radius + 2);
    }
  }

  // why: at a vertex with three revealed cells and one hidden cell the
  // sheet cell's corner pokes sharply into the island — a grout pocket
  // (background color) fills the corner, rounding the sheet's edge with
  // a concave arc that continues the two border lines meeting there.
  // Pockets paint after all halo bands, sheet overdraw, and notch
  // repaints, so they own the vertex zone.
  private flushConcaveCorners(): void {
    if (this.concavePaints.length === 0) return;
    this.ctx.fillStyle = canvasPalette().background;
    for (const paint of this.concavePaints) {
      const { x, y, sx, sy, size, terrain } = paint;
      const right = sx + size + CELL_GAP;
      const bottom = sy + size + CELL_GAP;
      const radius = islandRadius(size);
      if (terrain.topLeft && !terrain.top && !terrain.left) {
        this.paintConcaveBite(
          sx,
          sy,
          -1,
          -1,
          this.grownBiteRadius(radius, [
            [x, y],
            [x - 1, y],
            [x, y - 1],
          ]),
        );
      }
      if (terrain.topRight && !terrain.top && !terrain.right) {
        this.paintConcaveBite(
          right - CELL_GAP,
          sy,
          1,
          -1,
          this.grownBiteRadius(radius, [
            [x, y],
            [x + 1, y],
            [x, y - 1],
          ]),
        );
      }
      if (terrain.bottomRight && !terrain.right && !terrain.bottom) {
        this.paintConcaveBite(
          right - CELL_GAP,
          bottom - CELL_GAP,
          1,
          1,
          this.grownBiteRadius(radius, [
            [x, y],
            [x + 1, y],
            [x, y + 1],
          ]),
        );
      }
      if (terrain.bottomLeft && !terrain.left && !terrain.bottom) {
        this.paintConcaveBite(
          sx,
          bottom - CELL_GAP,
          -1,
          1,
          this.grownBiteRadius(radius, [
            [x, y],
            [x - 1, y],
            [x, y + 1],
          ]),
        );
      }
    }
    this.concavePaints.length = 0;
  }

  // why: linear growth matches the tile crossfade curve, so the pocket
  // materializes together with its neighboring tiles instead of racing
  // ahead of them
  private grownBiteRadius(
    radius: number,
    cells: readonly (readonly [number, number])[],
  ): number {
    return radius * this.biteProgress(cells);
  }

  // algorithm: legs run from the two tangent points through the corner,
  // then the arc (centered radius-deep inside the cut-out region) closes
  // the path — the fill rounds the corner with a concave curve. Legs sit
  // exactly on the tile body edges, the lines the visible border runs
  // along, so the cut edge continues each border line at the same
  // coordinate and the arc joins them tangentially — one smooth border.
  private paintConcaveBite(
    legX: number,
    legY: number,
    hx: number,
    hy: number,
    radius: number,
  ): void {
    if (radius < 0.5) return;
    const angleAtVertical = hx === 1 ? Math.PI : 0;
    const angleAtHorizontal = hy === 1 ? Math.PI * 1.5 : Math.PI * 0.5;
    this.ctx.beginPath();
    this.ctx.moveTo(legX + hx * radius, legY);
    this.ctx.lineTo(legX, legY);
    this.ctx.lineTo(legX, legY + hy * radius);
    this.ctx.arc(
      legX + hx * radius,
      legY + hy * radius,
      radius,
      angleAtVertical,
      angleAtHorizontal,
      hx !== hy,
    );
    this.ctx.closePath();
    this.ctx.fill();
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

  private tileTerrain(x: number, y: number): TileTerrain {
    const hidden = (nx: number, ny: number) => !this.board.isRevealed(nx, ny);
    return {
      left: hidden(x - 1, y),
      right: hidden(x + 1, y),
      top: hidden(x, y - 1),
      bottom: hidden(x, y + 1),
      topLeft: hidden(x - 1, y - 1),
      topRight: hidden(x + 1, y - 1),
      bottomLeft: hidden(x - 1, y + 1),
      bottomRight: hidden(x + 1, y + 1),
    };
  }

  private drawTile(
    sx: number,
    sy: number,
    size: number,
    color: string,
    radii?: [number, number, number, number],
  ): void {
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.roundRect(sx, sy, size, size, radii ?? tileRadius(size));
    this.ctx.fill();
  }

  // why: a tile corner flanked by exactly one hidden side keeps the halo
  // band's overlap strip visible inside its rounded notch, and a corner
  // facing a hidden diagonal keeps the sheet's overdraw speck — repaint
  // those notches so they read as plain mortar like interior corners;
  // corners with both orthogonal sides hidden are island corners filled
  // with accent by design
  private paintNotchCorners(
    sx: number,
    sy: number,
    size: number,
    terrain: TileTerrain,
  ): void {
    const radius = tileRadius(size);
    this.ctx.fillStyle = canvasPalette().background;
    const notch = (
      x: number,
      y: number,
      hx: number,
      hy: number,
      hiddenA: boolean,
      hiddenB: boolean,
      hiddenDiag: boolean,
    ): void => {
      if (hiddenA === hiddenB && !(hiddenDiag && !hiddenA)) return;
      this.paintConcaveBite(x, y, hx, hy, radius);
    };
    notch(sx, sy, 1, 1, terrain.left, terrain.top, terrain.topLeft);
    notch(sx + size, sy, -1, 1, terrain.top, terrain.right, terrain.topRight);
    notch(
      sx + size,
      sy + size,
      -1,
      -1,
      terrain.right,
      terrain.bottom,
      terrain.bottomRight,
    );
    notch(
      sx,
      sy + size,
      1,
      -1,
      terrain.bottom,
      terrain.left,
      terrain.bottomLeft,
    );
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
    const sprite = this.mineSpriteFor(size, palette);
    this.ctx.drawImage(sprite, sx, sy, size, size);
  }

  // why: after loss the viewport can hold thousands of mines; a cached
  // raster replaces a dozen path operations per mine with one drawImage
  private mineSpriteFor(
    size: number,
    palette: CanvasPalette,
  ): HTMLCanvasElement {
    const ratio = window.devicePixelRatio;
    const colors = mineSpriteColors(palette);
    const current = this.mineSprite;
    if (
      current?.cellSize === this.cellSize &&
      current.colors === colors &&
      current.ratio === ratio
    ) {
      return current.canvas;
    }
    const canvas = buildMineSprite(size, palette, ratio);
    this.mineSprite = { cellSize: this.cellSize, colors, ratio, canvas };
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

function hasConcaveCorner(terrain: TileTerrain): boolean {
  return (
    (terrain.topLeft && !terrain.top && !terrain.left) ||
    (terrain.topRight && !terrain.top && !terrain.right) ||
    (terrain.bottomRight && !terrain.right && !terrain.bottom) ||
    (terrain.bottomLeft && !terrain.left && !terrain.bottom)
  );
}

function snapToLattice(css: number, canvas: HTMLCanvasElement): number {
  const dpr = canvas.width / canvas.clientWidth;
  return (Math.floor(css * dpr) + 0.5) / dpr;
}

function islandRadius(size: number): number {
  return Math.min(size * ISLAND_CORNER_RADIUS_RATIO, size / 2);
}

// why: a tile corner is an island corner when both orthogonal neighbors
// are hidden sheet — straight border runs and interior corners keep the
// small per-tile radius, so the discovered region stays "tiled" inside
// why: island corners (both orthogonal neighbors hidden) round far more
// than interior corners; concave-facing corners render with the normal
// interior radius like every other tile corner — the grout pocket
// painted last covers their notch zone at concave vertices
function cornerRadius(
  orthHiddenA: boolean,
  orthHiddenB: boolean,
  size: number,
): number {
  return orthHiddenA && orthHiddenB ? islandRadius(size) : tileRadius(size);
}

function tileRadii(
  terrain: TileTerrain,
  size: number,
): [number, number, number, number] {
  return [
    cornerRadius(terrain.left, terrain.top, size),
    cornerRadius(terrain.right, terrain.top, size),
    cornerRadius(terrain.right, terrain.bottom, size),
    cornerRadius(terrain.left, terrain.bottom, size),
  ];
}

function buildMineSprite(
  size: number,
  palette: CanvasPalette,
  ratio: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(size * ratio);
  canvas.height = Math.ceil(size * ratio);
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("sprite 2d context unavailable");
  ctx.scale(ratio, ratio);
  paintMine(ctx, size, palette);
  return canvas;
}

function paintMine(
  ctx: CanvasRenderingContext2D,
  size: number,
  palette: CanvasPalette,
): void {
  const body = mineBodyColor(palette);
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.22;
  const lineWidth = Math.max(1.2, size * 0.05);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = lineWidth;
  ctx.stroke();
  ctx.fillStyle = palette.flagPole;
  ctx.beginPath();
  ctx.arc(
    cx - radius * 0.35,
    cy - radius * 0.35,
    radius * 0.28,
    0,
    Math.PI * 2,
  );
  ctx.fill();
  paintMineSpikes(ctx, cx, cy, radius, lineWidth, body);
}

function paintMineSpikes(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  lineWidth: number,
  color: string,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  for (const [dx, dy] of MINE_SPIKES) {
    ctx.beginPath();
    ctx.moveTo(cx - dx * radius, cy - dy * radius);
    ctx.lineTo(cx + dx * radius * 1.6, cy + dy * radius * 1.6);
    ctx.stroke();
  }
}

// why: when the accent equals the theme's mine red the body would
// vanish into the sheet, so fall back to the darkest theme color
function mineBodyColor(palette: CanvasPalette): string {
  return palette.mine.toLowerCase() === palette.hidden.toLowerCase()
    ? palette.grid
    : palette.mine;
}

function mineSpriteColors(palette: CanvasPalette): string {
  return `${mineBodyColor(palette)}/${palette.grid}/${palette.flagPole}`;
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
