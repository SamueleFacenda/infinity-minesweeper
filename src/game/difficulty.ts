export interface Difficulty {
  readonly id: string;
  readonly label: string;
  readonly density: number;
}

// why: the deep tiers spend a generation budget per reveal and their quota
// floor clips the lower tail, so each nominal density is compensated so
// the settled mine fraction lands on the intended percentage. Insane is
// the hardest density that still opens a long deterministic chain
export const DIFFICULTIES: readonly Difficulty[] = [
  { id: "easy", label: "Easy", density: 0.12 },
  { id: "medium", label: "Medium", density: 0.2 },
  { id: "hard", label: "Hard", density: 0.25 },
  { id: "expert", label: "Expert", density: 0.2733 },
  { id: "evil", label: "Evil", density: 0.3147 },
  { id: "insane", label: "Insane", density: 0.3545 },
];

export const FASTEST_TARGET_TILES = 200;

export function difficultyById(id: string): Difficulty {
  const found = DIFFICULTIES.find((d) => d.id === id);
  if (found === undefined) {
    throw new Error(`unknown difficulty: ${id}`);
  }
  return found;
}
