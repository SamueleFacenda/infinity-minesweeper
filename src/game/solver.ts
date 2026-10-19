import { keyOf, neighborCoords, parseKey } from "./coords.js";

// Constraint solver over the revealed area. Deducing with single-point
// rules, subset rules and bounded component enumeration; results mirror
// what a careful player could conclude, powering hints and the no-guess
// board guarantee.

export interface SolveResult {
  readonly safe: Set<string>;
  readonly mines: Set<string>;
}

interface Constraint {
  readonly cells: string[];
  readonly count: number;
}

const MAX_PASSES = 16;
const MAX_ENUM_CELLS = 32;
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
    deduceSinglePoint(constraints, safe, mines);
    if (earlyExitOnSafe && safe.size > 0) break;
    deduceSubsets(constraints, safe, mines);
    if (earlyExitOnSafe && safe.size > 0) break;
    deduceByEnumeration(constraints, safe, mines, earlyExitOnSafe);
    if (safe.size + mines.size === known) break;
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

function deduceSinglePoint(
  constraints: readonly Constraint[],
  safe: Set<string>,
  mines: Set<string>,
): void {
  for (const constraint of constraints) {
    if (constraint.count === 0) {
      addAll(safe, constraint.cells);
    } else if (constraint.count === constraint.cells.length) {
      addAll(mines, constraint.cells);
    }
  }
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

function deduceByEnumeration(
  constraints: readonly Constraint[],
  safe: Set<string>,
  mines: Set<string>,
  earlyExitOnSafe: boolean,
): void {
  const byCell = indexByCell(constraints);
  const components = connectedComponents(constraints, byCell);
  for (const component of components) {
    if (earlyExitOnSafe && safe.size > 0) return;
    const cells = new Set<string>();
    for (const constraint of component) {
      for (const cell of constraint.cells) cells.add(cell);
    }
    if (cells.size > MAX_ENUM_CELLS) continue;
    const forced = enumerateComponent(
      orderCells([...cells], component),
      component,
    );
    if (forced === null) continue;
    addAll(mines, forced.allMines);
    addAll(safe, forced.allSafe);
  }
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
  cells: string[],
  component: readonly Constraint[],
): string[] {
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
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
  }
  return ordered;
}

// Enumerates every satisfying assignment of a component; a cell forced in
// all solutions is a mine, never-a-mine is safe.
function enumerateComponent(
  cells: string[],
  component: readonly Constraint[],
): ForcedCells | null {
  const cellLimits = new Map<string, Limit[]>();
  for (const constraint of component) {
    const limit: Limit = {
      count: constraint.count,
      mines: 0,
      future: constraint.cells.length,
    };
    for (const cell of constraint.cells) {
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
  // degrades to single-point + subset rules there
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
