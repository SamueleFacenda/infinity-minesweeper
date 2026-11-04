import { keyOf, neighborCoords, parseKey } from "./coords.js";

// Constraint solver over the revealed area. Lower and upper mine bounds
// are propagated across the whole frontier until saturation, then small
// unresolved components are enumerated exactly; results mirror what a
// careful player could conclude, powering hints and the no-guess board
// guarantee.

export interface SolveResult {
  readonly safe: Set<string>;
  readonly mines: Set<string>;
}

interface Constraint {
  readonly cells: string[];
  readonly count: number;
}

// Per-cell certainty between zero and one: lower bound one is a mine in
// every layout the constraints allow, upper bound zero is never a mine.
interface Bounds {
  readonly lower: ReadonlyMap<string, number>;
  readonly upper: ReadonlyMap<string, number>;
}

const MAX_PASSES = 16;
const MAX_ENUM_CELLS = 64;
const MAX_ENUM_SOLUTIONS = 100_000;

export function solve(revealed: ReadonlyMap<string, number>): SolveResult {
  const { safe, mines } = runDeduction(revealed, false);
  return { safe, mines };
}

// Fast progress oracle: any deduced-safe cell is a valid hint, so this
// bails out as soon as one appears instead of computing the full closure.
// Returns null exactly when solve().safe is empty.
export function findSafeCell(
  revealed: ReadonlyMap<string, number>,
): string | null {
  const { safe } = runDeduction(revealed, true);
  return firstOf(safe);
}

function runDeduction(
  revealed: ReadonlyMap<string, number>,
  earlyExitOnSafe: boolean,
): SolveResult {
  const safe = new Set<string>();
  const mines = new Set<string>();
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const constraints = buildConstraints(revealed, safe, mines);
    if (constraints.length === 0) break;
    const known = safe.size + mines.size;
    const bounds = propagateBounds(constraints);
    addResolved(bounds, safe, mines);
    if (earlyExitOnSafe && safe.size > 0) break;
    // why: bounds are per-cell, so they cannot express that one
    // constraint's certainty carries over to another's extra cells
    if (safe.size + mines.size === known) {
      deduceSubsets(constraints, safe, mines);
      if (earlyExitOnSafe && safe.size > 0) break;
    }
    if (safe.size + mines.size > known) continue;
    const enumerated = enumerateComponents(
      constraints,
      bounds,
      safe,
      mines,
      earlyExitOnSafe,
    );
    if (earlyExitOnSafe && safe.size > 0) break;
    if (!enumerated) break;
  }
  return { safe, mines };
}

function firstOf(set: ReadonlySet<string>): string | null {
  const first = set.values().next().value;
  return first ?? null;
}

function buildConstraints(
  revealed: ReadonlyMap<string, number>,
  safe: ReadonlySet<string>,
  mines: ReadonlySet<string>,
): Constraint[] {
  const constraints: Constraint[] = [];
  for (const [key, count] of revealed) {
    const { x, y } = parseKey(key);
    const cells: string[] = [];
    let knownMines = 0;
    for (const [nx, ny] of neighborCoords(x, y)) {
      const nkey = keyOf(nx, ny);
      if (revealed.has(nkey) || safe.has(nkey)) continue;
      if (mines.has(nkey)) {
        knownMines++;
        continue;
      }
      cells.push(nkey);
    }
    const remaining = count - knownMines;
    if (cells.length > 0 && remaining >= 0) {
      constraints.push({ cells, count: remaining });
    }
  }
  return constraints;
}

function addAll(target: Set<string>, cells: Iterable<string>): boolean {
  let changed = false;
  for (const cell of cells) {
    if (!target.has(cell)) {
      target.add(cell);
      changed = true;
    }
  }
  return changed;
}

function addResolved(
  bounds: Bounds,
  safe: Set<string>,
  mines: Set<string>,
): void {
  const resolved = resolvedCells(bounds);
  addAll(safe, resolved.safe);
  addAll(mines, resolved.mines);
}

function deduceSubsets(
  constraints: readonly Constraint[],
  safe: Set<string>,
  mines: Set<string>,
): void {
  const byCell = indexByCell(constraints);
  for (const inner of constraints) {
    if (inner.cells.length === 0) continue;
    const firstCell = inner.cells[0];
    if (firstCell === undefined) continue;
    const candidates = byCell.get(firstCell) ?? [];
    for (const outer of candidates) {
      if (outer === inner || inner.cells.length >= outer.cells.length) continue;
      if (!isSubset(inner.cells, outer.cells)) continue;
      applySubsetRule(inner, outer, safe, mines);
    }
  }
}

function isSubset(inner: readonly string[], outer: readonly string[]): boolean {
  const outerSet = new Set(outer);
  return inner.every((cell) => outerSet.has(cell));
}

function applySubsetRule(
  inner: Constraint,
  outer: Constraint,
  safe: Set<string>,
  mines: Set<string>,
): void {
  const innerSet = new Set(inner.cells);
  const difference = outer.cells.filter((cell) => !innerSet.has(cell));
  const diffCount = outer.count - inner.count;
  if (diffCount === 0) {
    addAll(safe, difference);
  } else if (diffCount === difference.length) {
    addAll(mines, difference);
  }
}

// why: constraints share cells, so one certainty tightens every
// neighbouring constraint; the worklist repeats until nothing tightens,
// which subsumes single-point and subset reasoning for the frontier.
function propagateBounds(constraints: readonly Constraint[]): Bounds {
  const lower = new Map<string, number>();
  const upper = new Map<string, number>();
  const of = indexByCell(constraints);
  const pending = new Set<Constraint>(constraints);
  while (pending.size > 0) {
    const constraint = takeConstraint(pending);
    const cells = constraint.cells;
    let sumLower = 0;
    let sumUpper = 0;
    for (const cell of cells) {
      sumLower += lower.get(cell) ?? 0;
      sumUpper += upper.get(cell) ?? 1;
    }
    // why: unreachable for consistent boards, guards against propagating
    // from a contradictory constraint
    if (sumLower > constraint.count || sumUpper < constraint.count) continue;
    for (const cell of cells) {
      const floor = lower.get(cell) ?? 0;
      const ceiling = upper.get(cell) ?? 1;
      const nextFloor = Math.max(
        floor,
        constraint.count - (sumUpper - ceiling),
      );
      const nextCeiling = Math.min(
        ceiling,
        constraint.count - (sumLower - floor),
      );
      if (nextFloor === floor && nextCeiling === ceiling) continue;
      lower.set(cell, nextFloor);
      upper.set(cell, nextCeiling);
      for (const related of of.get(cell) ?? []) pending.add(related);
    }
  }
  return { lower, upper };
}

function takeConstraint(pending: Set<Constraint>): Constraint {
  const constraint = pending.values().next().value;
  if (constraint === undefined) throw new Error("no pending constraint");
  pending.delete(constraint);
  return constraint;
}

function resolvedCells(bounds: Bounds): { mines: string[]; safe: string[] } {
  const mines: string[] = [];
  const safe: string[] = [];
  for (const cell of bounds.lower.keys()) {
    if ((bounds.upper.get(cell) ?? 1) === 0) safe.push(cell);
    else if (bounds.lower.get(cell) === 1) mines.push(cell);
  }
  return { mines, safe };
}

function enumerateComponents(
  constraints: readonly Constraint[],
  bounds: Bounds,
  safe: Set<string>,
  mines: Set<string>,
  earlyExitOnSafe: boolean,
): boolean {
  const byCell = indexByCell(constraints);
  const components = connectedComponents(constraints, byCell);
  let changed = false;
  for (const component of components) {
    if (earlyExitOnSafe && safe.size > 0) return changed;
    const pending = pendingCells(component, bounds);
    if (pending.length === 0 || pending.length > MAX_ENUM_CELLS) continue;
    const forced = enumerateComponent(
      orderCells(pending, component),
      component,
      bounds,
    );
    if (forced === null) continue;
    if (addAll(mines, forced.allMines)) changed = true;
    if (addAll(safe, forced.allSafe)) changed = true;
  }
  return changed;
}

function indexByCell(
  constraints: readonly Constraint[],
): Map<string, Constraint[]> {
  const byCell = new Map<string, Constraint[]>();
  for (const constraint of constraints) {
    for (const cell of constraint.cells) {
      const list = byCell.get(cell);
      if (list === undefined) {
        byCell.set(cell, [constraint]);
      } else {
        list.push(constraint);
      }
    }
  }
  return byCell;
}

function isPending(cell: string, bounds: Bounds): boolean {
  const floor = bounds.lower.get(cell) ?? 0;
  const ceiling = bounds.upper.get(cell) ?? 1;
  return floor < ceiling;
}

function pendingCells(
  component: readonly Constraint[],
  bounds: Bounds,
): string[] {
  const pending = new Set<string>();
  for (const constraint of component) {
    for (const cell of constraint.cells) {
      if (isPending(cell, bounds)) pending.add(cell);
    }
  }
  return [...pending];
}

function connectedComponents(
  constraints: readonly Constraint[],
  byCell: ReadonlyMap<string, Constraint[]>,
): Constraint[][] {
  const seen = new Set<Constraint>();
  const components: Constraint[][] = [];
  for (const start of constraints) {
    if (seen.has(start)) continue;
    const component: Constraint[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.pop();
      if (current === undefined) break;
      component.push(current);
      for (const cell of current.cells) {
        for (const neighbor of byCell.get(cell) ?? []) {
          if (!seen.has(neighbor)) {
            seen.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
    components.push(component);
  }
  return components;
}

interface ForcedCells {
  allMines: string[];
  allSafe: string[];
}

// Chains cells through shared constraints so the backtracking completes
// constraints early and prunes aggressively; arbitrary order can explode
// combinatorially on dense frontiers.
function orderCells(
  cells: readonly string[],
  component: readonly Constraint[],
): string[] {
  const wanted = new Set(cells);
  const constraintsOf = new Map<string, Constraint[]>();
  for (const constraint of component) {
    for (const cell of constraint.cells) {
      const list = constraintsOf.get(cell);
      if (list === undefined) {
        constraintsOf.set(cell, [constraint]);
      } else {
        list.push(constraint);
      }
    }
  }
  const visited = new Set<string>();
  const ordered: string[] = [];
  for (const start of cells) {
    if (visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cell = queue.shift();
      if (cell === undefined) break;
      ordered.push(cell);
      for (const constraint of constraintsOf.get(cell) ?? []) {
        for (const neighbor of constraint.cells) {
          if (!wanted.has(neighbor) || visited.has(neighbor)) continue;
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }
  return ordered;
}

// Enumerates every satisfying assignment of a component's unresolved
// cells; a cell mined in all solutions is a mine, never-a-mine is safe.
function enumerateComponent(
  cells: string[],
  component: readonly Constraint[],
  bounds: Bounds,
): ForcedCells | null {
  const cellLimits = new Map<string, Limit[]>();
  for (const constraint of component) {
    let settled = 0;
    let future = 0;
    for (const cell of constraint.cells) {
      if (isPending(cell, bounds)) future++;
      else settled += bounds.lower.get(cell) ?? 0;
    }
    const remaining = constraint.count - settled;
    if (remaining < 0 || remaining > future) return null;
    if (future === 0) continue;
    const limit: Limit = { count: remaining, mines: 0, future };
    for (const cell of constraint.cells) {
      if (!isPending(cell, bounds)) continue;
      const list = cellLimits.get(cell);
      if (list === undefined) {
        cellLimits.set(cell, [limit]);
      } else {
        list.push(limit);
      }
    }
  }

  const mineHits = new Map<string, number>();
  const assignment = new Map<string, 0 | 1>();
  let solutions = 0;

  const walk = (position: number): void => {
    if (solutions >= MAX_ENUM_SOLUTIONS) return;
    if (position === cells.length) {
      solutions++;
      for (const cell of cells) {
        if ((assignment.get(cell) ?? 0) === 1) {
          mineHits.set(cell, (mineHits.get(cell) ?? 0) + 1);
        }
      }
      return;
    }
    const cell = cells[position];
    if (cell === undefined) return;
    const touched = cellLimits.get(cell) ?? [];
    for (const limit of touched) limit.future--;
    for (const choice of [1, 0] as const) {
      if (touched.every(isChoiceValid(choice))) {
        for (const limit of touched) limit.mines += choice;
        assignment.set(cell, choice);
        walk(position + 1);
        for (const limit of touched) limit.mines -= choice;
      }
    }
    for (const limit of touched) limit.future++;
  };

  walk(0);
  // ponytail: components above the solution cap are skipped, deduction
  // degrades to propagation alone there
  if (solutions >= MAX_ENUM_SOLUTIONS || solutions === 0) return null;
  const allMines: string[] = [];
  const allSafe: string[] = [];
  for (const cell of cells) {
    if ((mineHits.get(cell) ?? 0) === solutions) allMines.push(cell);
    else if ((mineHits.get(cell) ?? 0) === 0) allSafe.push(cell);
  }
  return { allMines, allSafe };
}

interface Limit {
  count: number;
  mines: number;
  future: number;
}

function isChoiceValid(choice: 0 | 1): (limit: Limit) => boolean {
  return (limit) => {
    const mines = limit.mines + choice;
    return mines <= limit.count && mines + limit.future >= limit.count;
  };
}
