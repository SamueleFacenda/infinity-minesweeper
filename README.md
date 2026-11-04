# Minesweeper∞

**Infinite-board minesweeper that never asks you to guess.**

An endless minesweeper board generated lazily and deterministically from a
seed, verified by a constraint solver after every reveal: a logical next
move always exists, and when one genuinely cannot, the board says so and
marks the zone instead of guessing for you. Modern flat design, one-click
chording, six difficulty tiers up to a brutal 35% mine density, and a
local leaderboard.

![Gameplay screenshot](docs/screenshot.png)

## Features

- **Infinite board** - the grid extends without limit in every direction;
  mine placement is a pure hash function of seed and coordinates, so
  nothing is stored until you explore it
- **No guessing** - after every reveal the solver verifies that a certain
  move exists and that no enclosed pocket of hidden cells is
  unresolvable; terrain that would dead-end is re-rolled, and the rare
  positions no re-roll can rescue are marked as guess zones instead of
  hidden or resolved by force
- **Deterministic solving aids** - a Hint button (or `H`) highlights a
  cell that is provably safe right now
- **Fast controls** - click a satisfied number to chord (auto-disclose
  neighbors), click a number whose remaining unknowns are all mines to
  auto-fill flags; drag to pan, wheel to zoom
- **Six difficulties** - from Easy to Insane (see table below)
- **Local leaderboard** - biggest run (tiles cleared) and fastest time to
  200 tiles, per difficulty, stored in your browser
- **First click is always safe** - every game opens with a safe area

## Controls

| Action            | Control                         |
| ----------------- | ------------------------------- |
| Reveal a cell     | Left click                      |
| Flag / unflag     | Right click                     |
| Chord / auto-fill | Left click on a revealed number |
| Hint              | `H` or the Hint button          |
| Pan               | Drag, or arrow keys             |
| Zoom              | Mouse wheel                     |
| New game          | `N` or the New game button      |
| Difficulty        | Dropdown in the top bar         |

## Difficulties

| Tier   | Mine density | Notes                                       |
| ------ | ------------ | ------------------------------------------- |
| Easy   | 12%          | near the classic Beginner board (12.3%)     |
| Medium | 17%          | near the classic Intermediate board (15.6%) |
| Hard   | 22%          | just past classic Expert (20.6%)            |
| Expert | 26%          | beyond-Expert calibration                   |
| Evil   | 30%          | every frontier needs subset logic           |
| Insane | 35%          | dense mine walls; the generator works hard  |

The classic reference ladder (Beginner 9×9/10 = 12.3%, Intermediate
16×16/40 = 15.6%, Expert 30×16/99 = 20.6%) is the community standard; the
tiers beyond Expert are our own calibration - past that point no universal
standard exists, only custom boards and "evil" no-guess modes like
minesweeper.online's (see References).

## How the no-guess engine works

1. A cell's mine status is a hash of `(seed, chunk nonce, x, y)` - the
   infinite board is fully defined yet stored nowhere.
2. Chunks (16×16) become **committed** (nonce frozen) once they are visible
   to the player; before commitment the generator may re-roll them
   invisibly.
3. Every reveal plays out tentatively; the solver then checks that the
   visible position contains at least one provably safe cell and that
   every enclosed pocket the reveal created is fully deducible. If either
   check fails, the freshly committed chunks are re-rolled.
4. The opening click also requires a deterministic playout of a depth
   scaled by density, so every game starts on terrain that stays solvable
   well past the first moves.
5. When re-rolling cannot repair ambiguity that already-committed terrain
   created, the honest layout stands and the ambiguous cells are
   **marked**: the HUD shows "Guess zone: N cells", those cells carry a
   dot on the sheet, and the Hint reports it plainly instead of claiming
   the state is impossible. You choose whether to guess or start a new
   game; the board never guesses for you and never opens cells you did
   not click.
6. Hint runs the same solver and highlights its next certain move.

The solver propagates per-cell mine bounds (lower and upper) across the
whole frontier until they stop tightening, then enumerates small
unresolved components exactly - so beyond the basic rules it also proves
cells safe that single-point and subset reasoning alone cannot reach.

## Build and run

Everything runs through nix; the site itself has zero runtime
dependencies (plain TypeScript compiled by `tsc`, native ES modules).

```sh
nix develop                           # dev shell
nix build .#site                      # static site in ./result
just serve                            # build + serve on http://localhost:8080
nix develop -c bash -c 'npm ci && npm test'   # unit tests (vitest)
nix flake check                       # full gate: build + pre-commit hooks
```

Pushing to `main` deploys to GitHub Pages via CI (enable "GitHub Pages via
GitHub Actions" once in the repository settings).

## References

- Simon Tatham's no-guess Mines - the classic perturbation-based
  generator/solver: https://www.chiark.greenend.org.uk/~sgtatham/puzzles/js/mines.html
- Minesweeper Online - no-guess mode and the Evil tier:
  https://minesweeper.online/help/gameplay
- Difficulty ladder reference: https://minesweeperblast.com/minesweeper-difficulty-levels/
- Approaches to creating solvable Minesweeper instances (CSP-based
  solver and generator study):
  https://doc.neuro.tu-berlin.de/bachelor/2024-BA-BenediktKunz.pdf
- Algorithms for Minesweeper Game Grid Generation:
  https://minesweepergame.com/math/algorithms-for-minesweeper-game-grid-generation-2017.pdf

## Who built this

This project was designed and implemented by **opencode**, an AI coding
agent (model: GLM, trained by z.ai), working under human direction and
review - including the game engine, solver, generator, UI, tests, nix
packaging, and this README.

**Disclaimer:** this is AI-generated code. It ships with a test suite and
CI, and the game engine is deterministic, but like any AI-written software
it may contain bugs or design choices a human author might have made
differently. Review before depending on it for anything serious. It is a
game; the stakes are your spare time.

## License

EUPL-1.2
