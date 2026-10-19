export interface Difficulty {
  readonly id: string;
  readonly label: string;
  readonly density: number;
}

export const DIFFICULTIES: readonly Difficulty[] = [
  { id: "easy", label: "Easy", density: 0.12 },
  { id: "medium", label: "Medium", density: 0.17 },
  { id: "hard", label: "Hard", density: 0.22 },
  { id: "expert", label: "Expert", density: 0.26 },
  { id: "evil", label: "Evil", density: 0.3 },
  { id: "insane", label: "Insane", density: 0.35 },
];

export const FASTEST_TARGET_TILES = 200;

export function difficultyById(id: string): Difficulty {
  const found = DIFFICULTIES.find((d) => d.id === id);
  if (found === undefined) {
    throw new Error(`unknown difficulty: ${id}`);
  }
  return found;
}
