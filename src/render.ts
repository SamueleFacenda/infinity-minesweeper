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
// runs while animations are pending or the view is still moving.

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

// why: corner index order matches the radii array roundRect consumes —
// topLeft, topRight, bottomRight, bottomLeft
const CORNER_TOP_LEFT = 0;
const CORNER_TOP_RIGHT = 1;
const CORNER_BOTTOM_RIGHT = 2;
const CORNER_BOTTOM_LEFT = 3;

interface CornerCollapseQueries {
  readonly isRevealed: (x: number, y: number) => boolean;
  // why: only a tile revealed before this batch owns a corner that can lose
  // its rounding — corners of cells uncovered together belong to the flood
  // itself and settle with it instead of animating apart
  readonly settledBeforeBatch: (x: number, y: number) => boolean;
}

interface CornerCollapseSide {
  readonly corner: number;
  readonly other: readonly [number, number];
}

interface CornerCollapseSides {
  readonly offset: readonly [number, number];
  readonly corners: readonly CornerCollapseSide[];
}

// why: discovering a cell collapses the island corners of the revealed
// orthogonal neighbors it borders; each entry pairs the offset from the
// discovered cell to the neighbor with the neighbor corners facing it and
// each corner's other side — a corner collapses only while that other side
// still faces hidden sheet, otherwise the corner already renders at the
// tile radius
const CORNER_COLLAPSE_SIDES: readonly CornerCollapseSides[] = [
  {
    offset: [-1, 0],
    corners: [
      { corner: CORNER_TOP_RIGHT, other: [0, -1] },
      { corner: CORNER_BOTTOM_RIGHT, other: [0, 1] },
    ],
  },
  {
    offset: [1, 0],
    corners: [
      { corner: CORNER_TOP_LEFT, other: [0, -1] },
      { corner: CORNER_BOTTOM_LEFT, other: [0, 1] },
    ],
  },
  {
    offset: [0, -1],
    corners: [
      { corner: CORNER_BOTTOM_LEFT, other: [-1, 0] },
      { corner: CORNER_BOTTOM_RIGHT, other: [1, 0] },
    ],
  },
  {
    offset: [0, 1],
    corners: [
      { corner: CORNER_TOP_LEFT, other: [-1, 0] },
      { corner: CORNER_TOP_RIGHT, other: [1, 0] },
    ],
  },
];

// why: eases the rendered lattice toward its quantized target so zoom and
// pan glide instead of jumping between integer device-pixel snaps
const easeToward = (current: number, target: number): number =>
  Math.abs(target - current) < 0.05
    ? target
    : current + (target - current) * 0.35;

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
  // why: hidden cells that deduction cannot resolve, set from the board's
  // deduction state after every reveal
  guessZone: ReadonlySet<string> = new Set();

  private readonly revealAnims = new Map<string, RevealAnimation>();
  // why: keyed by cell and corner, each entry holds the reveal animation
  // driving that corner's collapse from the island to the tile radius
  private readonly cornerCollapses = new Map<string, RevealAnimation>();
  private readonly flagAnims = new Map<string, FlagAnimation>();
  private readonly concavePaints: ConcavePaint[] = [];
  private readonly snapXs = new Map<number, number>();
  private readonly snapYs = new Map<number, number>();
  private lattice = {
    dpr: 1,
    pitch: 1,
    originX: 0,
    originY: 0,
  };
  private latticeTarget = { pitch: 1, originX: 0, originY: 0 };
  private latticeStarted = false;
  private lossAnim: LossAnimation | null = null;
  private animFrame: number | null = null;
  private drawPending = false;
  private mineSprite: MineSprite | null = null;
  readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)")
    .matches;
  // why: the per-tile white flash on reveal reads as a full-screen strobe
  // on touch devices; the tile fade-in stays, only the flash is gated
  readonly coarsePointer = window.matchMedia("(pointer: coarse)").matches;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private board: Board,
  ) {}

  setBoard(board: Board): void {
    this.board = board;
    this.hintCell = null;
    this.guessZone = new Set();
    this.hoverCell = null;
    this.revealAnims.clear();
    this.cornerCollapses.clear();
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
    // why: cell lines snap to a quarter-device-pixel lattice so every
    // tile and band edge straddles two device pixels and antialiases
    // softly at every zoom and pixel ratio
    this.snapXs.clear();
    this.snapYs.clear();
    this.buildLattice(width, height);
    // why: the painted range derives from the rendered lattice rather than
    // the exact camera math — while the lattice eases toward its target the
    // exact range stops short of the viewport edge and leaves an uncovered
    // strip that flickers as the ease converges
    const deviceWidth = width * this.lattice.dpr;
    const deviceHeight = height * this.lattice.dpr;
    const firstCol =
      Math.ceil((-this.lattice.originX - 0.25) / this.lattice.pitch - 1) - 1;
    const lastCol =
      Math.floor(
        (deviceWidth - this.lattice.originX - 0.25) / this.lattice.pitch,
      ) + 1;
    const firstRow =
      Math.ceil((-this.lattice.originY - 0.25) / this.lattice.pitch - 1) - 1;
    const lastRow =
      Math.floor(
        (deviceHeight - this.lattice.originY - 0.25) / this.lattice.pitch,
      ) + 1;
    const originX = firstCol;
    const originY = firstRow;
    const spanX = lastCol - firstCol + 1;
    const spanY = lastRow - firstRow + 1;
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
    this.registerCornerCollapses(cells);
    this.scheduleAnimationFrame();
  }

  private registerCornerCollapses(
    cells: readonly (readonly [number, number])[],
  ): void {
    const registrations = cornerCollapseRegistrations(
      cells,
      this.revealAnims,
      (x, y) => this.board.isRevealed(x, y),
    );
    for (const [key, driver] of registrations) {
      this.cornerCollapses.set(key, driver);
    }
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
    // on screen (pockets stuck short of their full radius); the easing
    // lattice likewise needs frames until it settles onto its target
    if (
      !animationsActive &&
      !this.drawPending &&
      !hadAnimations &&
      this.latticeSettled()
    ) {
      return;
    }
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
    for (const [key, anim] of this.cornerCollapses) {
      if (now - anim.startTime - anim.delay >= REVEAL_DURATION_MS) {
        this.cornerCollapses.delete(key);
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

  // why: the overlap keeps shared sheet seams fully covered; overdraw
  // toward a revealed tile serves nothing there — its body repaints the
  // straight stretches — and only shows as an accent sliver inside its
  // rounded corner notches
  private sheetEdgeOverdraw(x: number, y: number): number {
    return this.board.isRevealed(x, y) ? 0 : SHEET_OVERDRAW_PX;
  }

  private drawSheetCell(x: number, y: number): void {
    const sx = this.snapX(x);
    const sy = this.snapY(y);
    const cellW = this.snapX(x + 1) - sx;
    const cellH = this.snapY(y + 1) - sy;
    const board = this.board;
    const key = keyOf(x, y);
    const left = this.sheetEdgeOverdraw(x - 1, y);
    const top = this.sheetEdgeOverdraw(x, y - 1);
    const right = this.sheetEdgeOverdraw(x + 1, y);
    const bottom = this.sheetEdgeOverdraw(x, y + 1);
    this.ctx.fillStyle = canvasPalette().hidden;
    this.ctx.fillRect(
      sx - left,
      sy - top,
      cellW + left + right,
      cellH + top + bottom,
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
    if (this.guessZone.has(key)) this.drawGuessMarker(sx, sy, cellW, cellH);
  }

  // why: a small centered dot reads as "pinned" without hiding the sheet
  // color, so guess cells stay recognizable as still-hidden ground
  private drawGuessMarker(sx: number, sy: number, w: number, h: number): void {
    this.ctx.globalAlpha = 0.7;
    this.ctx.fillStyle = canvasPalette().background;
    this.ctx.beginPath();
    this.ctx.arc(
      sx + w / 2,
      sy + h / 2,
      Math.max(1, this.cellSize * 0.08),
      0,
      Math.PI * 2,
    );
    this.ctx.fill();
    this.ctx.globalAlpha = 1;
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

  // why: all cell edges derive from one lattice basis — an integer device
  // pitch plus a snapped origin — so every cell is exactly as wide as its
  // neighbors and the whole grid moves by whole device pixels while
  // panning; rounding each edge separately let adjacent cells differ by a
  // pixel, which drifted borders apart into misaligned, unevenly
  // antialiased cells at zoom levels where cellSize * dpr is fractional.
  // The rendered values ease toward that target instead of snapping each
  // frame: a single wheel tick then glides the grid instead of rescaling
  // and re-rounding it at once, which reads as shaking
  private buildLattice(width: number, height: number): void {
    const dpr = this.canvas.width / this.canvas.clientWidth;
    const pitch = Math.max(1, Math.round(this.cellSize * dpr));
    const originX = Math.round(
      (width / 2 - this.cameraX * this.cellSize) * dpr,
    );
    const originY = Math.round(
      (height / 2 - this.cameraY * this.cellSize) * dpr,
    );
    if (!this.latticeStarted || this.lattice.dpr !== dpr) {
      this.lattice = { dpr, pitch, originX, originY };
      this.latticeTarget = { pitch, originX, originY };
      this.latticeStarted = true;
      return;
    }
    this.latticeTarget = { pitch, originX, originY };
    this.lattice = {
      dpr,
      pitch: easeToward(this.lattice.pitch, pitch),
      originX: easeToward(this.lattice.originX, originX),
      originY: easeToward(this.lattice.originY, originY),
    };
  }

  private latticeSettled(): boolean {
    return (
      this.lattice.pitch === this.latticeTarget.pitch &&
      this.lattice.originX === this.latticeTarget.originX &&
      this.lattice.originY === this.latticeTarget.originY
    );
  }

  // why: a quarter-device-pixel offset makes every edge straddle two device
  // pixels, so borders antialias across a soft two-pixel gradient instead
  // of one crisp mid-tone line; the fixed offset keeps that gradient
  // identical at every zoom level and camera phase
  private snapX(cellIndex: number): number {
    let snapped = this.snapXs.get(cellIndex);
    if (snapped === undefined) {
      snapped =
        (this.lattice.originX + 0.25 + cellIndex * this.lattice.pitch) /
        this.lattice.dpr;
      this.snapXs.set(cellIndex, snapped);
    }
    return snapped;
  }

  private snapY(cellIndex: number): number {
    let snapped = this.snapYs.get(cellIndex);
    if (snapped === undefined) {
      snapped =
        (this.lattice.originY + 0.25 + cellIndex * this.lattice.pitch) /
        this.lattice.dpr;
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

  // why: an island corner collapses toward the tile radius while the
  // neighboring reveal plays out, so the external corner retreats with the
  // tile that un-hid its side instead of snapping in a single frame
  private animatedCornerRadius(
    x: number,
    y: number,
    corner: number,
    island: boolean,
    size: number,
  ): number {
    if (island) return islandRadius(size);
    const collapse = this.cornerCollapses.get(cornerCollapseKey(x, y, corner));
    if (collapse === undefined) return tileRadius(size);
    const progress = clamp01(
      (performance.now() - collapse.startTime - collapse.delay) /
        REVEAL_DURATION_MS,
    );
    const tile = tileRadius(size);
    return islandRadius(size) + (tile - islandRadius(size)) * progress;
  }

  private animatedRadii(
    x: number,
    y: number,
    terrain: TileTerrain,
    size: number,
  ): [number, number, number, number] {
    return [
      this.animatedCornerRadius(
        x,
        y,
        CORNER_TOP_LEFT,
        terrain.left && terrain.top,
        size,
      ),
      this.animatedCornerRadius(
        x,
        y,
        CORNER_TOP_RIGHT,
        terrain.right && terrain.top,
        size,
      ),
      this.animatedCornerRadius(
        x,
        y,
        CORNER_BOTTOM_RIGHT,
        terrain.right && terrain.bottom,
        size,
      ),
      this.animatedCornerRadius(
        x,
        y,
        CORNER_BOTTOM_LEFT,
        terrain.left && terrain.bottom,
        size,
      ),
    ];
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
    const radii = this.animatedRadii(x, y, terrain, size);
    this.paintIslandHalo(tsx, tsy, size, terrain, radii);
    this.drawTile(tsx, tsy, size, canvasPalette().revealed, radii);
    this.paintNotchCorners(tsx, tsy, size, terrain);
    this.ctx.globalAlpha = progress;
    this.drawNumber(x, y, tsx, tsy, size);
    this.ctx.globalAlpha = 1 - progress;
    this.drawSheetRect(tsx, tsy, size + CELL_GAP);
    const flash = this.coarsePointer ? 0 : progress * (1 - progress) * 4 * 0.22;
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
    radii: [number, number, number, number],
  ): void {
    const cellSize = size + CELL_GAP;
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
    this.paintHaloCorners(sx, sy, size, radii);
  }

  // why: the accent square of a corner retreats with the corner's animated
  // radius, so a collapsing island corner keeps its crescent until it
  // settles into the plain tile corner
  private paintHaloCorners(
    sx: number,
    sy: number,
    size: number,
    radii: [number, number, number, number],
  ): void {
    for (const [corner, radius] of radii.entries()) {
      if (radius <= tileRadius(size)) continue;
      const left = corner === CORNER_TOP_LEFT || corner === CORNER_BOTTOM_LEFT;
      const top = corner === CORNER_TOP_LEFT || corner === CORNER_TOP_RIGHT;
      this.paintHaloCornerSquare(
        left ? sx : sx + size,
        top ? sy : sy + size,
        left ? 1 : -1,
        top ? 1 : -1,
        radius,
      );
    }
  }

  private paintHaloCornerSquare(
    cornerX: number,
    cornerY: number,
    hx: number,
    hy: number,
    radius: number,
  ): void {
    const side = radius + 2;
    const x = hx > 0 ? cornerX - 1 : cornerX - radius - 1;
    const y = hy > 0 ? cornerY - 1 : cornerY - radius - 1;
    this.ctx.fillRect(x, y, side, side);
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
      const feather = 1 / this.lattice.dpr;
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
          feather,
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
          feather,
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
          feather,
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
          feather,
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
    feather = 0,
  ): void {
    if (radius < 0.5) return;
    const angleAtVertical = hx === 1 ? Math.PI : 0;
    const angleAtHorizontal = hy === 1 ? Math.PI * 1.5 : Math.PI * 0.5;
    const trace = (lx: number, ly: number, r: number): void => {
      this.ctx.beginPath();
      this.ctx.moveTo(lx + hx * r, ly);
      this.ctx.lineTo(lx, ly);
      this.ctx.lineTo(lx, ly + hy * r);
      this.ctx.arc(
        lx + hx * r,
        ly + hy * r,
        r,
        angleAtVertical,
        angleAtHorizontal,
        hx !== hy,
      );
      this.ctx.closePath();
    };
    // why: a half-transparent overshoot spreads the pocket's edge across
    // two device pixels so the rounded arc and its legs read as a soft
    // gradient — a plain edge always cuts pixels in half, leaving a
    // one-pixel line equally sharp at every zoom
    if (feather > 0) {
      this.ctx.globalAlpha = 0.5;
      trace(legX - hx * feather, legY - hy * feather, radius + feather);
      this.ctx.fill();
      this.ctx.globalAlpha = 1;
    }
    trace(legX, legY, radius);
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

function islandRadius(size: number): number {
  return Math.min(size * ISLAND_CORNER_RADIUS_RATIO, size / 2);
}

// why: an external corner of a previously revealed tile collapses from the
// island radius to the tile radius when a neighboring cell is discovered;
// the collapse is registered at reveal time because a cell's reveal progress
// alone cannot tell a hidden cell from a long-settled one, so the corner
// has to remember that it is still collapsing
export function cornerCollapseRegistrations(
  batch: readonly (readonly [number, number])[],
  anims: ReadonlyMap<string, RevealAnimation>,
  isRevealed: (x: number, y: number) => boolean,
): Map<string, RevealAnimation> {
  const batchKeys = new Set(batch.map(([x, y]) => keyOf(x, y)));
  const queries: CornerCollapseQueries = {
    isRevealed,
    settledBeforeBatch: (x, y) =>
      isRevealed(x, y) && !batchKeys.has(keyOf(x, y)),
  };
  const registrations = new Map<string, RevealAnimation>();
  for (const [x, y] of batch) {
    const driver = anims.get(keyOf(x, y));
    if (driver === undefined) continue;
    for (const side of CORNER_COLLAPSE_SIDES) {
      registerNeighborCorners(
        registrations,
        { x: x + side.offset[0], y: y + side.offset[1] },
        side.corners,
        driver,
        queries,
      );
    }
  }
  return registrations;
}

// why: a corner of the neighbor faces the discovered cell through one of
// its sides and hidden sheet through the other; both sides discovered
// together leave nothing to collapse, and one key can only be reached
// through one side, so no duplicate can occur
function registerNeighborCorners(
  registrations: Map<string, RevealAnimation>,
  neighbor: Cell,
  corners: readonly CornerCollapseSide[],
  driver: RevealAnimation,
  queries: CornerCollapseQueries,
): void {
  if (!queries.settledBeforeBatch(neighbor.x, neighbor.y)) return;
  for (const affected of corners) {
    const otherX = neighbor.x + affected.other[0];
    const otherY = neighbor.y + affected.other[1];
    if (queries.isRevealed(otherX, otherY)) continue;
    const key = cornerCollapseKey(neighbor.x, neighbor.y, affected.corner);
    registrations.set(key, driver);
  }
}

function cornerCollapseKey(x: number, y: number, corner: number): string {
  return `${keyOf(x, y)}|${String(corner)}`;
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
