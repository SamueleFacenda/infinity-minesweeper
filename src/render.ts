import type { Board } from "./game/board.js";
import type { Cell } from "./game/coords.js";
import { keyOf } from "./game/coords.js";
import type { CanvasPalette } from "./theme.js";
import { canvasPalette } from "./theme.js";

// Canvas renderer for a window of the infinite board. Camera keeps world
// coordinates (cell units) of the viewport center. Hidden cells paint over
// one fluid accent-colored sheet; revealed cells are individual rounded
// tiles carved into it. Cell state changes animate through per-cell
// records replayed by a requestAnimationFrame loop that runs while
// animations are pending or the view is still moving.

const MIN_CELL_SIZE = 14;
const MAX_CELL_SIZE = 56;
const CELL_GAP = 1;
// why: proportional radius keeps tiles equally rounded at every zoom level
const CORNER_RADIUS_RATIO = 0.1;
const MIN_CORNER_RADIUS = 1;
// why: island corners (tile corners facing hidden terrain on both sides)
// round far more than interior tile corners for a smooth island outline
const ISLAND_CORNER_RADIUS_RATIO = 0.4;
// why: the sheet rect overdrawn by half a pixel on every side hides the
// subpixel seam between neighboring rects when the camera sits on
// fractional coordinates
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
const FREE_CELL_RING_MS = 2000;
const FREE_CELL_RING_INSET = 24;
const FREE_CELL_RING_START_RATIO = 0.4;
const FREE_CELL_RING_ON_SCREEN_REACH = 3.5;
const FREE_CELL_RING_APPROACH_SHARE = 0.15;
// why: a cell's count is the number of adjacent mines, capped at the eight
// neighbors; the glyph atlas holds one slot per possible count
const MAX_ADJACENT_MINES = 8;

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

// why: a critically damped spring glides the lattice toward its quantized
// target from rest to rest; an exponential per-frame ease lurches 35% of the
// remaining gap in the single frame after each wheel tick, which reads as
// shaking while zooming. The exact solution keeps the glide identical at
// any frame rate, and the velocity survives a retarget so a fast stroke
// blends into one continuous glide instead of restarting per tick
const GLIDE_OMEGA = 25;
const GLIDE_MAX_STEP_SECONDS = 0.05;
const GLIDE_SETTLE_DISTANCE = 0.05;
const GLIDE_SETTLE_SPEED = 0.5;

export function glideStep(
  value: number,
  velocity: number,
  target: number,
  step: number,
): [number, number] {
  const offset = value - target;
  const slope = velocity + GLIDE_OMEGA * offset;
  const decay = Math.exp(-GLIDE_OMEGA * step);
  const moved = (offset + slope * step) * decay;
  const next = (velocity - GLIDE_OMEGA * slope * step) * decay;
  if (
    Math.abs(moved) < GLIDE_SETTLE_DISTANCE &&
    Math.abs(next) < GLIDE_SETTLE_SPEED
  ) {
    return [target, 0];
  }
  return [target + moved, next];
}

interface FlagAnimation {
  readonly placing: boolean;
  readonly startTime: number;
}

interface LossAnimation {
  readonly cell: Cell;
  readonly startTime: number;
}

interface FreeCellRing {
  readonly cell: Cell;
  readonly startTime: number;
}

export interface RingViewport {
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cellSize: number;
  readonly width: number;
  readonly height: number;
}

export interface RingAnchor {
  // ring center in screen pixels — the cell's true position, which sits
  // outside the viewport when the cell is off screen
  readonly x: number;
  readonly y: number;
  readonly inside: boolean;
  // radius that touches the viewport edge and the radius that crosses it
  readonly arrival: number;
  readonly reach: number;
  // chevron anchor, kept inside the viewport edge so the arrow stays visible
  readonly edgeX: number;
  readonly edgeY: number;
  readonly dirX: number;
  readonly dirY: number;
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
  readonly size: number;
  readonly colors: string;
  readonly ratio: number;
  readonly canvas: HTMLCanvasElement;
}

interface NumberSprite {
  readonly size: number;
  readonly colors: string;
  readonly ratio: number;
  readonly canvas: HTMLCanvasElement;
}

interface FlagSprite {
  readonly size: number;
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
  private latticeVelocity = { pitch: 0, originX: 0, originY: 0 };
  private latticeTarget = { pitch: 1, originX: 0, originY: 0 };
  private latticeStarted = false;
  private latticeTime = 0;
  private lossAnim: LossAnimation | null = null;
  private freeCellRing: FreeCellRing | null = null;
  private animFrame: number | null = null;
  private drawPending = false;
  private mineSprite: MineSprite | null = null;
  private numberSprite: NumberSprite | null = null;
  private flagSprite: FlagSprite | null = null;
  // why: one frame paints every tile at the same lattice size, so the
  // bucketed atlas lookup and its palette-color join run once per frame
  // instead of once per cell; a new frame drops the cached sprite
  private frameNumberSprite: NumberSprite | null = null;
  private frameFlagSprite: HTMLCanvasElement | null = null;
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
    this.freeCellRing = null;
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
    // why: one fill covers the whole hidden sheet; a rect per hidden cell
    // costs one path per cell when zoomed out, and a single fill leaves no
    // seams because the sheet is one continuous surface
    this.ctx.fillStyle = palette.background;
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.fillStyle = palette.hidden;
    this.ctx.fillRect(0, 0, width, height);
    // why: cell lines snap to a quarter-device-pixel lattice so every
    // tile and band edge straddles two device pixels and antialiases
    // softly at every zoom and pixel ratio
    this.snapXs.clear();
    this.snapYs.clear();
    this.frameNumberSprite = null;
    this.frameFlagSprite = null;
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
    this.drawFreeCellRing();
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

  // why: the free cell can open far from the viewport, so its ring marks
  // the cell itself when visible and the edge it hides behind when not
  animateFreeCell(cell: Cell) {
    if (this.reducedMotion) return;
    this.freeCellRing = { cell, startTime: performance.now() };
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
      this.lossAnim !== null ||
      this.freeCellRing !== null;
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
    if (
      this.freeCellRing !== null &&
      now - this.freeCellRing.startTime >= FREE_CELL_RING_MS
    ) {
      this.freeCellRing = null;
    }
    return (
      this.revealAnims.size > 0 ||
      this.flagAnims.size > 0 ||
      this.lossAnim !== null ||
      this.freeCellRing !== null
    );
  }

  // why: the hidden sheet is one viewport-wide accent fill drawn before
  // this pass, so a hidden cell only paints what sits on top of it —
  // hover, flags, mines, hint
  private drawSheetCell(x: number, y: number): void {
    const sx = this.snapX(x);
    const sy = this.snapY(y);
    const board = this.board;
    // why: a resting flag lives on the board, not in the animation map, so
    // the key is only needed while a flag transitions or a guess zone is
    // marked - the common case then skips two hash lookups per hidden cell
    const needsKey = this.flagAnims.size > 0 || this.guessZone.size > 0;
    const key = needsKey ? keyOf(x, y) : null;
    const hovered =
      this.hoverCell !== null &&
      this.hoverCell.x === x &&
      this.hoverCell.y === y;
    if (hovered) this.drawHoverOverlay(sx, sy);
    const flagAnim = key === null ? undefined : this.flagAnims.get(key);
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
    if (key !== null && this.guessZone.has(key))
      this.drawGuessMarker(sx, sy, this.cellSize, this.cellSize);
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
  // panning; rounding each edge separately lets adjacent cells differ by a
  // pixel, which drifts borders apart into misaligned, unevenly
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
    const now = performance.now();
    if (!this.latticeStarted || this.lattice.dpr !== dpr) {
      this.snapLattice({ dpr, pitch, originX, originY }, now);
      return;
    }
    this.latticeTarget = { pitch, originX, originY };
    const step = Math.min(
      GLIDE_MAX_STEP_SECONDS,
      Math.max(0.001, (now - this.latticeTime) / 1000),
    );
    this.latticeTime = now;
    this.glideAxis("pitch", pitch, step);
    this.glideAxis("originX", originX, step);
    this.glideAxis("originY", originY, step);
  }

  private snapLattice(
    next: { dpr: number; pitch: number; originX: number; originY: number },
    now: number,
  ): void {
    this.lattice = next;
    this.latticeTarget = {
      pitch: next.pitch,
      originX: next.originX,
      originY: next.originY,
    };
    this.latticeVelocity = { pitch: 0, originX: 0, originY: 0 };
    this.latticeStarted = true;
    this.latticeTime = now;
  }

  // algorithm: each axis integrates one critically damped spring step
  // toward its quantized target, so the glide accelerates out of rest and
  // decelerates into it and successive wheel ticks carry into each other
  private glideAxis(
    axis: "pitch" | "originX" | "originY",
    target: number,
    step: number,
  ): void {
    const [value, velocity] = glideStep(
      this.lattice[axis],
      this.latticeVelocity[axis],
      target,
      step,
    );
    this.lattice[axis] = value;
    this.latticeVelocity[axis] = velocity;
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
    // why: an empty map makes every lookup a miss, so the key is not built
    if (this.revealAnims.size === 0) return 1;
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
    if (this.revealAnims.size === 0) return 1;
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
    // why: an empty map cannot hold this corner, so the key is not built
    if (this.cornerCollapses.size === 0) return tileRadius(size);
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
    const terrain = this.tileTerrain(x, y);
    this.paintMortar(tsx, tsy, size, terrain);
    if (progress <= 0) {
      this.drawSheetRect(tsx, tsy, size + CELL_GAP);
      return;
    }
    const radii = this.animatedRadii(x, y, terrain, size);
    this.paintIslandHalo(tsx, tsy, size, terrain, radii);
    this.drawTile(tsx, tsy, size, canvasPalette().revealed, radii);
    this.paintNotchCorners(tsx, tsy, size, terrain);
    this.ctx.globalAlpha = progress;
    this.drawNumber(x, y, tsx, tsy, size);
    // why: a fully revealed tile crossfades to nothing, so the sheet rect it
    // would leave behind is skipped instead of painted at zero alpha
    if (progress < 1) {
      this.ctx.globalAlpha = 1 - progress;
      this.drawSheetRect(tsx, tsy, size + CELL_GAP);
    }
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

  // why: the sheet is one viewport-wide accent fill, so the base under a
  // tile — the mortar strips toward revealed neighbors and the rounded
  // corner notches of the cell box — must be repainted, or the island
  // interior reads as an accent grid with accent crosses at every
  // four-cell intersection. Two grid rules keep the repaint
  // invisible: the rect snaps to the device-pixel grid, because a
  // fractional edge would antialias the background against the accent
  // sheet into a sharp accent line along every boundary; and it
  // overlaps one device pixel toward revealed neighbors, because the
  // eased pitch is fractional mid-glide and rounding each box alone can
  // leave a one-pixel gap that flashes the sheet through the mortar.
  // Sides facing hidden terrain stay unexpanded so the halo band still
  // owns the island edge, and the tile keeps its own quarter-pixel
  // edges — tiles still antialias softly over this pure dark base
  private paintMortar(
    sx: number,
    sy: number,
    size: number,
    terrain: TileTerrain,
  ): void {
    const ratio = this.lattice.dpr;
    const pitch = size + CELL_GAP;
    const x = Math.round(sx * ratio) / ratio;
    const y = Math.round(sy * ratio) / ratio;
    const width = Math.round(pitch * ratio) / ratio;
    const overlap = 1 / ratio;
    this.ctx.fillStyle = canvasPalette().background;
    this.ctx.fillRect(
      x,
      y,
      width + (terrain.right ? 0 : overlap),
      width + (terrain.bottom ? 0 : overlap),
    );
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
    // edges — an into-body overlap shows as accent tabs in the
    // mortar where a band end crosses a tile gap, and along-axis overshoot
    // spills into neighboring cells' mortar
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
    const sprite = this.numberSpriteForFrame(size);
    const slot = sprite.size * sprite.ratio;
    this.ctx.drawImage(
      sprite.canvas,
      (count - 1) * slot,
      0,
      slot,
      slot,
      sx,
      sy,
      size,
      size,
    );
  }

  // why: numbers repaint on every frame while zooming; rasterizing the
  // glyph set once per zoom level replaces a per-cell font parse, fill
  // style and text raster with a single drawImage, and the atlas covers
  // the counts of all visible cells instead of rebuilding per digit.
  // The render size is bucketed because the eased lattice pitch takes a
  // new value every glide frame — keying on the exact size would rebuild
  // the atlas each frame, and a sub-2px glyph rescale is invisible
  private numberSpriteFor(size: number): NumberSprite {
    const palette = canvasPalette();
    const colors = palette.numbers.join(",");
    const ratio = window.devicePixelRatio;
    const bucket = numberSpriteBucket(size);
    const current = this.numberSprite;
    if (
      current !== null &&
      current.size === bucket &&
      current.colors === colors &&
      current.ratio === ratio
    ) {
      return current;
    }
    const canvas = buildNumberSprite(bucket, palette, ratio);
    this.numberSprite = { size: bucket, colors, ratio, canvas };
    return this.numberSprite;
  }

  // why: every revealed tile in a frame shares one lattice size, so the
  // glyph atlas lookup and its palette-color join run once per frame
  // instead of once per cell while the lattice glides
  private numberSpriteForFrame(size: number): NumberSprite {
    const cached = this.frameNumberSprite;
    if (cached !== null) return cached;
    const sprite = this.numberSpriteFor(size);
    this.frameNumberSprite = sprite;
    return sprite;
  }

  // why: a resting flag is a fixed drawing redrawn on every frame while
  // zooming; the bucketed raster replaces its path operations with one
  // drawImage. Only the raise/remove animation still draws live paths
  private flagSpriteFor(size: number): HTMLCanvasElement {
    const palette = canvasPalette();
    const colors = flagSpriteColors(palette);
    const ratio = window.devicePixelRatio;
    const bucket = numberSpriteBucket(size);
    const current = this.flagSprite;
    if (
      current !== null &&
      current.size === bucket &&
      current.colors === colors &&
      current.ratio === ratio
    ) {
      return current.canvas;
    }
    const canvas = buildFlagSprite(bucket, palette, ratio);
    this.flagSprite = { size: bucket, colors, ratio, canvas };
    return canvas;
  }

  // why: every flag in a frame shares one lattice size, so the flag atlas
  // lookup runs once per frame instead of once per flagged hidden cell
  private flagSpriteForFrame(size: number): HTMLCanvasElement {
    const cached = this.frameFlagSprite;
    if (cached !== null) return cached;
    const sprite = this.flagSpriteFor(size);
    this.frameFlagSprite = sprite;
    return sprite;
  }

  private drawFlag(
    sx: number,
    sy: number,
    size: number,
    anim: FlagAnimation | null,
  ): void {
    if (anim === null) {
      this.ctx.drawImage(this.flagSpriteForFrame(size), sx, sy, size, size);
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

  private paintFlag(
    sx: number,
    sy: number,
    size: number,
    raise: FlagRaiseState,
  ): void {
    drawFlagPath(this.ctx, sx, sy, size, canvasPalette(), raise);
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
  // raster replaces a dozen path operations per mine with one drawImage.
  // The render size is bucketed because the eased lattice pitch changes
  // every glide frame — keying on the exact size rebuilds per frame, and
  // a sub-2px mine rescale is invisible
  private mineSpriteFor(
    size: number,
    palette: CanvasPalette,
  ): HTMLCanvasElement {
    const ratio = window.devicePixelRatio;
    const colors = mineSpriteColors(palette);
    const bucket = numberSpriteBucket(size);
    const current = this.mineSprite;
    if (
      current !== null &&
      current.size === bucket &&
      current.colors === colors &&
      current.ratio === ratio
    ) {
      return current.canvas;
    }
    const canvas = buildMineSprite(bucket, palette, ratio);
    this.mineSprite = { size: bucket, colors, ratio, canvas };
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

  private drawFreeCellRing(): void {
    const anim = this.freeCellRing;
    if (anim === null) return;
    const t = (performance.now() - anim.startTime) / FREE_CELL_RING_MS;
    if (t >= 1) {
      this.freeCellRing = null;
      return;
    }
    const anchor = freeCellRingPoint(anim.cell, {
      cameraX: this.cameraX,
      cameraY: this.cameraY,
      cellSize: this.cellSize,
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
    });
    this.ctx.globalAlpha = 0.75 * (1 - t);
    this.ctx.strokeStyle = canvasPalette().hint;
    this.ctx.lineWidth = 2 + 3 * (1 - t);
    this.ctx.beginPath();
    this.ctx.arc(
      anchor.x,
      anchor.y,
      freeCellRingRadius(t, anchor, this.cellSize),
      0,
      Math.PI * 2,
    );
    this.ctx.stroke();
    if (!anchor.inside) this.drawFreeCellChevron(anchor);
    this.ctx.globalAlpha = 1;
  }

  // why: the ring that finally sweeps the screen shows how far away the cell
  // was — the flatter the arc, the further off it started; the chevron at the
  // edge keeps the direction readable while the arc is still crossing
  private drawFreeCellChevron(anchor: RingAnchor): void {
    const size = this.cellSize * 0.5;
    this.ctx.save();
    this.ctx.translate(anchor.edgeX, anchor.edgeY);
    this.ctx.rotate(Math.atan2(anchor.dirY, anchor.dirX));
    this.ctx.fillStyle = canvasPalette().hint;
    this.ctx.beginPath();
    this.ctx.moveTo(size, 0);
    this.ctx.lineTo(-size * 0.6, size * 0.6);
    this.ctx.lineTo(-size * 0.6, -size * 0.6);
    this.ctx.closePath();
    this.ctx.fill();
    this.ctx.restore();
  }
}

// why: the free cell can hide far outside the viewport, so its ring starts at
// the cell's true position — outside the viewport when it is off screen — and
// grows until the arc sweeps the viewport; the distance the ring travels
// before it becomes visible tells the player how far away the cell was
export function freeCellRingPoint(cell: Cell, view: RingViewport): RingAnchor {
  const originX = (cell.x - view.cameraX) * view.cellSize + view.width / 2;
  const originY = (cell.y - view.cameraY) * view.cellSize + view.height / 2;
  const x = originX + view.cellSize / 2;
  const y = originY + view.cellSize / 2;
  const offsetX = x - view.width / 2;
  const offsetY = y - view.height / 2;
  const length = Math.hypot(offsetX, offsetY) || 1;
  const inside = x >= 0 && x <= view.width && y >= 0 && y <= view.height;
  const inset = Math.max(FREE_CELL_RING_INSET, view.cellSize * 1.5);
  const arrival = distanceToViewport(x, y, view);
  // why: a visible cell only needs a ring a few cells wide; an off-screen cell
  // needs one that reaches from the cell to the far corner of the viewport, so
  // the arc always crosses the screen no matter how far away the cell is
  const reach = inside
    ? view.cellSize * FREE_CELL_RING_ON_SCREEN_REACH
    : arrival + Math.hypot(view.width, view.height) + view.cellSize;
  return {
    x,
    y,
    inside,
    arrival,
    reach,
    edgeX: clampToEdge(x, view.width, inset),
    edgeY: clampToEdge(y, view.height, inset),
    dirX: offsetX / length,
    dirY: offsetY / length,
  };
}

function distanceToViewport(x: number, y: number, view: RingViewport): number {
  const beyondX = Math.max(0, -x, x - view.width);
  const beyondY = Math.max(0, -y, y - view.height);
  return Math.hypot(beyondX, beyondY);
}

// why: the ring spends a short share of the animation growing from the cell
// to the viewport and the rest sweeping across it, so a cell a hundred cells
// away shows its arc for most of the animation instead of flashing in at the
// very end; the segment where the arc enters the viewport reads as distance
export function freeCellRingRadius(
  t: number,
  anchor: RingAnchor,
  cellSize: number,
): number {
  const start = cellSize * FREE_CELL_RING_START_RATIO;
  if (anchor.inside) {
    return start + (anchor.reach - start) * easeOutCubic(t);
  }
  const approach = FREE_CELL_RING_APPROACH_SHARE;
  if (t < approach) {
    return start + (anchor.arrival - start) * easeOutCubic(t / approach);
  }
  const swept = (t - approach) / (1 - approach);
  return anchor.arrival + (anchor.reach - anchor.arrival) * easeOutCubic(swept);
}

// why: an axis shorter than the inset has no edge to sit against, so the
// anchor collapses to the middle of that axis instead of sliding past it
function clampToEdge(value: number, extent: number, inset: number): number {
  const middle = extent / 2;
  return Math.min(
    Math.max(value, Math.min(inset, middle)),
    Math.max(extent - inset, middle),
  );
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

// algorithm: one slot per adjacent count, each rendered with the exact
// geometry the direct path used — same font string, weight and the +1px
// baseline bias — so blitting a slot reproduces fillText pixel-for-pixel
// at a fraction of the per-cell cost
function buildNumberSprite(
  size: number,
  palette: CanvasPalette,
  ratio: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(size * MAX_ADJACENT_MINES * ratio));
  canvas.height = Math.max(1, Math.ceil(size * ratio));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("sprite 2d context unavailable");
  ctx.scale(ratio, ratio);
  const fontSize = Math.max(1, Math.round(size * 0.5));
  ctx.font = `600 ${String(fontSize)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const fallback = palette.numbers[palette.numbers.length - 1] ?? "#ffffff";
  for (let count = 1; count <= MAX_ADJACENT_MINES; count++) {
    ctx.fillStyle =
      palette.numbers[(count - 1) % palette.numbers.length] ?? fallback;
    ctx.fillText(String(count), (count - 0.5) * size, size / 2 + 1);
  }
  return canvas;
}

// why: the eased lattice pitch takes a fresh float every glide frame;
// bucketing keeps the number of cached atlases in the low tens over a
// full zoom range instead of one per frame
function numberSpriteBucket(size: number): number {
  return Math.max(2, Math.round(size / 2) * 2);
}

// algorithm: raise = pole grows from the tile, then the pennant slides up
// with a slight overshoot; removal plays the same curve reversed + fade.
// Pole and pennant draw over a dark underlay so they stay readable when
// the accent sheet matches their color. Kept as a free function so the
// sprite builder and the animation path share one drawing
function drawFlagPath(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  size: number,
  palette: CanvasPalette,
  raise: FlagRaiseState,
): void {
  const cx = sx + size * 0.42;
  const baseY = sy + size * 0.78;
  const topY = sy + size * 0.22;
  const poleTop = baseY + (topY - baseY) * raise.pole;
  const poleWidth = Math.max(1.5, size * 0.06);
  ctx.globalAlpha = raise.alpha;
  ctx.lineCap = "round";
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = poleWidth + Math.max(2, size * 0.07);
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, poleTop);
  ctx.stroke();
  ctx.strokeStyle = palette.flagPole;
  ctx.lineWidth = poleWidth;
  ctx.beginPath();
  ctx.moveTo(cx, baseY);
  ctx.lineTo(cx, poleTop);
  ctx.stroke();
  if (raise.pennant > 0) {
    const pennantY = baseY + (topY - baseY) * raise.pennant;
    ctx.beginPath();
    ctx.moveTo(cx, pennantY);
    ctx.lineTo(cx + size * 0.3, pennantY + size * 0.14);
    ctx.lineTo(cx, pennantY + size * 0.28);
    ctx.closePath();
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = Math.max(1.5, size * 0.05);
    ctx.stroke();
    ctx.fillStyle = palette.flag;
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function buildFlagSprite(
  size: number,
  palette: CanvasPalette,
  ratio: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(size * ratio));
  canvas.height = Math.max(1, Math.ceil(size * ratio));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("sprite 2d context unavailable");
  ctx.scale(ratio, ratio);
  drawFlagPath(ctx, 0, 0, size, palette, { pole: 1, pennant: 1, alpha: 1 });
  return canvas;
}

function flagSpriteColors(palette: CanvasPalette): string {
  return `${palette.grid}/${palette.flagPole}/${palette.flag}`;
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
