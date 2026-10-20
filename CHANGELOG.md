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

### Changed

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
