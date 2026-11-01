# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
- Subpixel rendering: cell lines snap to a half-device-pixel lattice so canvas antialiases every dark/accent border uniformly at every zoom and pixel ratio — eliminates razor-sharp pixel-aligned border lines and isolated accent blend pixels at corners; concave corners are one continuous curve: the grout pocket's legs sit on the tile body edges and its arc joins the border lines tangentially; halo bands stay inside their own cell and tile-corner notches repaint as plain mortar, so no accent slivers, tabs, or specks remain at borders and inside corners; the hidden sheet overdraws only toward hidden neighbors, so revealed tile corner notches stay plain mortar at every cell switch; all cell edges derive from one lattice basis — an integer device pitch — so every cell is exactly as wide as its neighbors and the grid stays aligned and uniformly antialiased while panning at any zoom
- Loss screen taunts: random insult message from a 40-entry list
- Board inspection after loss: "Inspect board" button hides the overlay so the final board can be panned and zoomed; wrong flags are crossed out in red
- SVG favicon: spiky mine on the dark game background

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

### Deprecated

### Removed

### Fixed

### Security
