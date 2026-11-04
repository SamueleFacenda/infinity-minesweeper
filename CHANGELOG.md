# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Changed

- No-guess engine rewritten: the solver propagates per-cell mine bounds across the whole frontier and enumerates small unresolved components exactly, so hints prove cells safe that the old single-point and subset passes could not reach
- Removed the forced-opening fallback that pinned mine-free 3x3 areas and revealed them as part of an unrelated click; a reveal now only ever opens the cells it reaches
- Fixed re-rolls being no-ops after the first attempt (chunk nonces were restored instead of incremented), so the generator actually explores a different layout per attempt
- New per-reveal guarantees: a certain move must exist and every enclosed pocket the reveal created must be fully deducible
- Every game now opens on terrain that survives a deterministic playout whose depth scales with difficulty, so no game stalls a few moves in
- Stuck states are honest now: when no re-roll can rescue a position the ambiguous cells are reported and marked, the HUD shows the guess-zone size, those cells carry a dot on the hidden sheet, and the Hint message no longer claims the state is impossible

- Infinite minesweeper webapp: hash-based infinite board, no-guess generation with lazy chunk re-rolling, hint, chording, auto-fill, canvas renderer, local leaderboard (biggest/fastest)
- Nix static site package (`nix build .#site`) built with nixpkgs tsc, no bundler
- GitHub Pages deploy workflow and CI (flake checks, typecheck, lint, vitest)
- Difficulty tiers Expert (26%), Evil (30%) and Insane (35%)
- Theme system: Nord and warm charcoal palettes with in-game switcher, six preset accent colors (Nord Frost + Aurora), persisted per browser
- Canvas animations: flags raise/lower on the pole, flood-fill reveal ripples outward from the click, expanding ring on explosion; disabled under `prefers-reduced-motion`
- HUD polish: button/select transitions, toast slide-in, overlay and modal fade/scale-in, focus rings in the accent color
- Zoom: wheel step lowered from 1.1x to 1.02x, anchored on the exact float world point under the cursor (no per-tick board drift), tile corner radius proportional to zoom (10% of tile size at every level)
- Board restyle ("clean look"): hidden cells merge into one seamless fluid sheet in the accent color (flagged cells included, flags float on it with dark underlay outlines), revealed cells stay individual rounded tiles; hover becomes a subtle inset overlay
- Game-over clarity: mines keep theme colors with dark outlines plus a white glint and fall back to near-black when the accent matches the mine color; exploded cell gains a thick dark border; wrong-flag crosses render in the theme's dark color
- Island borders: tile corners facing hidden terrain on both sides round at 40% of tile size, giving the discovered region smoothly rounded outlines while interior corners keep the per-tile look
- Island edge cleanup: the border zone around discovered tiles is filled with the accent sheet (no dark background strips or squared corners at the island outline) and concave corners — three revealed cells meeting one hidden cell — become grout pockets: the interior tile-gap color rounds the sheet's corner with a concave arc, blends with the tiled pattern's mortar, and grows in sync with the reveal ripple so every island corner is smooth; halo bands stop short of concave vertices and the tiles meeting such a vertex render with sharp corners there, so no band overdraw or sheet overdraw leaks accent into the corner
- Animation loop: the frame that expires the last animation now still renders, fixing canvas state frozen mid-animation (concave pockets stuck short of their full radius)
- Subpixel rendering: cell lines snap to a half-device-pixel lattice so canvas antialiases every dark/accent border uniformly at every zoom and pixel ratio — eliminates razor-sharp pixel-aligned border lines and isolated accent blend pixels at corners; concave corners are one continuous curve: the grout pocket's legs sit on the tile body edges and its arc joins the border lines tangentially; halo bands stay inside their own cell and tile-corner notches repaint as plain mortar, so no accent slivers, tabs, or specks remain at borders and inside corners; the hidden sheet overdraws only toward hidden neighbors, so revealed tile corner notches stay plain mortar at every cell switch; all cell edges derive from one lattice basis — an integer device pitch — so every cell is exactly as wide as its neighbors and the grid stays aligned and uniformly antialiased while panning at any zoom; the rendered lattice eases toward that basis while the view moves, so zooming and panning glide instead of shaking, and the painted cells follow the rendered lattice so the viewport stays fully covered through the glide; the grout pocket paints a half-transparent overshoot so its rounded edge and its legs against the revealed tiles antialias across a soft gradient instead of a one-pixel line that stays equally sharp at every zoom, and every edge carries a quarter-pixel offset so borders antialias across a soft gradient rather than one crisp mid-tone line
- Loss screen taunts: random insult message from a 40-entry list
- Board inspection after loss: "Inspect board" button hides the overlay so the final board can be panned and zoomed; wrong flags are crossed out in red
- SVG favicon: spiky mine on the dark game background
- Touch input: one-finger drag pans, two-finger pinch zooms, short tap takes the primary action, and the platform contextmenu event doubles as the long-press secondary action; the synthetic mouse sequence is suppressed (canceled touchend) plus a 250ms mouse-event guard after touches
- Click mode switch: "Flag first" HUD toggle swaps short-click/right-click (and tap/long-press) between flag and open; numbers always chord on short click; default is flag-first on touch devices and open-first on desktop, persisted per browser
- Mobile rendering: per-tile white reveal flash skipped on coarse pointers (kept on desktop) and the platform tap-highlight overlay disabled on the canvas
- Sound design: crunchy WebAudio-synthesized feedback with no audio files — thock on flag placement and a lighter pick-up on removal, a reveal crunch that gets deeper and longer as the discovered area grows (with a low rumble on big floods), and a 1.2s low sweeping explosion on loss; the audio context is created lazily inside the triggering input handlers (autoplay-policy safe) and all sounds no-op silently when WebAudio is unavailable

### Changed

- Pan/zoom input redraws coalesce into one canvas draw per animation frame instead of one per mouse event; mines render from a cached hi-dpi sprite, keeping board inspection smooth after loss

- Loss sequence pacing: slower reveal ripple (600ms wave, 50ms stagger), 1.2s explosion ring, ~2s unobstructed board view before the end screen fades in over 900ms; the hold is skipped under `prefers-reduced-motion`

- Rebuilt the starter flake as a nodejs-only webapp template; rust/python/docker scaffolding removed
- Solver: count-0 constraints included, component enumeration raised to 32 cells, constraint-chain cell ordering, and a fast early-exit progress oracle
- Generator: stuck-state rescue searches expanding rings (radius 1-5) around the click and carves a safe opening in fresh terrain, eliminating accepted dead-end boards
- Hint message distinguishes a fresh board from a no-certain-move state
- Colors unified in one theme module feeding both CSS variables and the canvas palette; accent changes propagate to the board, HUD, and buttons simultaneously

### Fixed

- Stale animation replay: a no-op click no longer re-animates the previous reveal or auto-flag batch (cell change batches are cleared at the start of every click path)
- External corner removal now animates: when a neighboring cell is discovered, a previously revealed tile's island corner (40% radius plus accent crescent) collapses to the tile radius (10%) over the neighbor's reveal instead of snapping in one frame; corners of cells uncovered in the same batch settle with the flood, and internal concave pockets already animated

### Deprecated

### Removed

### Fixed

### Security
