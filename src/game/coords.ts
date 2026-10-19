export const CHUNK_SIZE = 16;

const NEIGHBOR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

export interface Cell {
  x: number;
  y: number;
}

export function keyOf(x: number, y: number): string {
  return `${String(x)},${String(y)}`;
}

export function parseKey(key: string): Cell {
  const sep = key.indexOf(",");
  return { x: Number(key.slice(0, sep)), y: Number(key.slice(sep + 1)) };
}

export function neighborCoords(x: number, y: number): [number, number][] {
  return NEIGHBOR_OFFSETS.map(
    ([dx, dy]) => [x + dx, y + dy] as [number, number],
  );
}

export function chunkKeyOf(x: number, y: number): string {
  return keyOf(Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));
}
