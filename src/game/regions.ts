import { keyOf, neighborCoords, parseKey } from "./coords.js";

// Unknown pockets completely enclosed by revealed cells. Every cell of
// such a pocket that borders revealed ground carries a constraint, so the
// solver must be able to resolve the pocket without a guess; pockets
// that reach the unexplored boundary are left to the frontier checks.

export interface EnclosedRegion {
  readonly cells: readonly string[];
  readonly bordered: readonly string[];
}

interface Box {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

// why: two cells past the revealed bounding box keeps every enclosed
// pocket inside the scan while still classifying pockets that continue
// into unexplored ground
const REGION_MARGIN = 2;

export function enclosedRegions(
  revealed: ReadonlyMap<string, number>,
): EnclosedRegion[] {
  if (revealed.size === 0) return [];
  const box = scanBox(revealed);
  const escaped = floodFromBoundary(revealed, box);
  const regions: EnclosedRegion[] = [];
  const seen = new Set<string>();
  for (let x = box.minX; x <= box.maxX; x++) {
    for (let y = box.minY; y <= box.maxY; y++) {
      const key = keyOf(x, y);
      if (revealed.has(key) || escaped.has(key) || seen.has(key)) continue;
      regions.push(collectRegion(revealed, escaped, seen, box, x, y));
    }
  }
  return regions;
}

function scanBox(revealed: ReadonlyMap<string, number>): Box {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const key of revealed.keys()) {
    const { x, y } = parseKey(key);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    minX: minX - REGION_MARGIN,
    maxX: maxX + REGION_MARGIN,
    minY: minY - REGION_MARGIN,
    maxY: maxY + REGION_MARGIN,
  };
}

// why: hidden cells reachable from the scan boundary via other hidden
// cells connect to unexplored ground, so they are frontier rather than
// enclosed pockets
function floodFromBoundary(
  revealed: ReadonlyMap<string, number>,
  box: Box,
): Set<string> {
  const escaped = new Set<string>();
  const stack: [number, number][] = [];
  const seed = (x: number, y: number): void => {
    const key = keyOf(x, y);
    if (!revealed.has(key) && !escaped.has(key)) {
      escaped.add(key);
      stack.push([x, y]);
    }
  };
  for (let x = box.minX; x <= box.maxX; x++) {
    seed(x, box.minY);
    seed(x, box.maxY);
  }
  for (let y = box.minY; y <= box.maxY; y++) {
    seed(box.minX, y);
    seed(box.maxX, y);
  }
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const [x, y] = current;
    for (const [nx, ny] of neighborCoords(x, y)) {
      if (!insideBox(box, nx, ny)) continue;
      const key = keyOf(nx, ny);
      if (revealed.has(key) || escaped.has(key)) continue;
      escaped.add(key);
      stack.push([nx, ny]);
    }
  }
  return escaped;
}

function collectRegion(
  revealed: ReadonlyMap<string, number>,
  escaped: ReadonlySet<string>,
  seen: Set<string>,
  box: Box,
  startX: number,
  startY: number,
): EnclosedRegion {
  const cells: string[] = [];
  const bordered: string[] = [];
  const stack: [number, number][] = [[startX, startY]];
  seen.add(keyOf(startX, startY));
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const [x, y] = current;
    const key = keyOf(x, y);
    cells.push(key);
    let borders = false;
    for (const [nx, ny] of neighborCoords(x, y)) {
      if (revealed.has(keyOf(nx, ny))) {
        borders = true;
        continue;
      }
      if (escaped.has(keyOf(nx, ny)) || !insideBox(box, nx, ny)) continue;
      const neighborKey = keyOf(nx, ny);
      if (seen.has(neighborKey)) continue;
      seen.add(neighborKey);
      stack.push([nx, ny]);
    }
    if (borders) bordered.push(key);
  }
  return { cells, bordered };
}

function insideBox(box: Box, x: number, y: number): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
}
