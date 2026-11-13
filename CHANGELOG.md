# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Free-cell indicator: revealing a free cell (F) grows a ring from the cell's true position and plays a short cue, so a far-off cell shows an arc sweeping in from where it lies — the flatter the arc, the further away the cell — with a chevron on the edge it hides behind pointing the way to pan; the ring lasts two seconds and grows past a visible cell to a few cell widths
- Reveal precompute: the next reveal is searched while the browser is idle (twice the interactive budget) and adopted in O(1) by the click that lands on it, so a prepared click paints instantly with no "Generating board..." indicator and no search on the click path; a click that misses the prepared cell falls back to the interactive search unchanged

### Fixed

- Free cell (F) replayed the flag raise of an earlier chord: the auto-flag batch the renderer plays on every reveal was never reset by the free-cell path, so flags placed long before rose and clicked again when the free cell opened; it now clears like every other reveal path
- Bottom-of-screen glitch when the guess-zone counter appears: the HUD reflows to a second line, shrinking the canvas CSS box with no window resize event, so the canvas bitmap outlived its box and the browser squashed the stale frame into it (a bottom strip that kept old cells and a vertically compressed board). The renderer now observes the canvas box with a `ResizeObserver` instead of listening for window resizes, which also covers plain window resizes; the bitmap tracks its box across HUD wrap/unwrap, window resizes and short windows
- Reveal and flag animations no longer stutter past ~400 cleared cells: the precompute block that used to land inside the reveal ripple (30-80 ms, up to 140 ms at 2000 cells) is gone
- "keeps a long deterministic chain on every tier" test timeout raised from 300s to 600s — eighteen guided chains at the deep tiers cost minutes of search, and the limit was headroom over a loaded machine, not the expected path
- `Board.nextRevealTarget()` / `zoneFreeTarget()`: the cell the next reveal should open (the certain move, or the free cell of a marked zone) without revealing it, so the UI can aim the precompute

### Changed

- Zoom/pan render cost per frame cut by roughly a third: animation lookups return their settled value without building a key when no reveal, corner-collapse or flag animation is pending, hidden cells skip the flag/guess-zone key entirely when no flag animates and no zone is marked, the reveal crossfade sheet rect is skipped at full reveal (it painted at zero alpha), and the number and flag atlases are looked up once per frame instead of once per cell — every revealed tile in a frame shares one lattice size. Rendered output is unchanged
- Reveal precompute runs in idle slices instead of one block: the reveal search is now resumable (a candidate's deterministic playout can stop between its steps) and each slice is bounded by the idle deadline, so the search never spends a whole frame on the main thread — measured on Insane at ~900 cleared cells, animation frames stay at 16.7 ms p50 / 16.8 ms p95 with a prepared-click rate of 0.81 and a prepared click at 3.3 ms
- Per-chunk quota floor lowered from 80/85/90% to 60% of the nominal density on the deep tiers: a frontier where every chunk sits at the nominal density is uniformly ambiguous, so sparse stretches must survive past Expert. Measured over 8 seeds and 400 guided reveals per seed: the first guess zone at Insane density moves from the 23rd-208th revealed cell to the 166th-438th, zones per run drop from 176 to 53, and the settled mine fraction stays on the tier
- The quota floor lives in one table (`QUOTA_FLOORS`) and is covered by tests that assert sparse stretches exist and the settled fraction stays near the nominal density

## [1.0.0] - 2026-11-06

First release.

### Added

- Infinite minesweeper webapp: hash-based infinite board, no-guess generation with lazy chunk re-rolling, hint, chording, auto-fill, canvas renderer, local leaderboard (biggest/fastest)
- Nix static site package (`nix build .#site`) built with nixpkgs tsc, no bundler
- GitHub Pages deploy workflow and CI (flake checks, typecheck, lint, vitest)
- Difficulty tiers Expert (30%), Evil (35%) and Insane (40%) settled mine fraction
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
- Free cell action (`F` or the Free cell button): when no certain move exists, opens one guaranteed-safe cell of the marked guess zone - a real cell of the fixed layout, so a run never has to end in a guess
- Loading UX for generation: a "Generating board..." indicator paints before the search runs (up to ~1s on Insane) and the fastest-run clock excludes generation time

### Changed

- Zoom/pan rendering performance: the hidden sheet is one viewport-wide accent fill instead of a rect per hidden cell, numbers render from a cached hi-dpi glyph atlas (one drawImage per numbered cell), and resting flags render from a cached hi-dpi sprite — only the raise/remove animation still draws live paths; sprite render sizes are bucketed so the eased zoom glide does not rebuild a cache per frame; each revealed cell repaints its whole cell box in the background color first (mortar strips plus the rounded corner notches the per-cell sheet left dark), snapped to the device-pixel grid so the repaint antialiases nothing against the accent sheet and overlapped one device pixel toward revealed neighbors so the fractional glide pitch cannot open a flashing gap, so the discovered island still reads as individual tiles carved into the sheet with no accent inside it
- Pan/zoom input redraws coalesce into one canvas draw per animation frame instead of one per mouse event; mines render from a cached hi-dpi sprite, keeping board inspection smooth after loss
- Loss sequence pacing: slower reveal ripple (600ms wave, 50ms stagger), 1.2s explosion ring, ~2s unobstructed board view before the end screen fades in over 900ms; the hold is skipped under `prefers-reduced-motion`
- Rebuilt the starter flake as a nodejs-only webapp template; rust/python/docker scaffolding removed
- Solver: count-0 constraints included, component enumeration raised to 32 cells, constraint-chain cell ordering, and a fast early-exit progress oracle
- Generator: stuck-state rescue searches expanding rings (radius 1-5) around the click and carves a safe opening in fresh terrain, eliminating accepted dead-end boards
- Hint message distinguishes a fresh board from a no-certain-move state
- Colors unified in one theme module feeding both CSS variables and the canvas palette; accent changes propagate to the board, HUD, and buttons simultaneously
- Per-tier generation budgets with a best-of-N reveal search: each reveal re-rolls fresh chunks inside its tier's budget and keeps the candidate whose deterministic chain runs deepest, instead of the first acceptable one (Easy stays first-fit, it never stalled)
- Mine quota spread is peaked (`sign(u) * u^2`) and floored per tier (80% of the nominal density at Expert and Evil, 85% at Insane, uniform below that): most chunks sit at the tier density so the difficulty reads uniform and the board has no empty islands, while rare chunks still swing far enough to anchor long deterministic chains. Measured at Insane: median chain ~590 moves (67 before any modulation, 1200 at the cap with the flat spread), zero-cell cascades down from 31% to 12% of revealed tiles, mine fraction 34.9% under the old 60% floor
- Mine placement is quota-modulated per chunk: each 16×16 chunk draws its own mine quota around the difficulty density (frozen on first visibility), so the frontier alternates tractable and dense ground while the global mine fraction stays at the tier; below Hard the distribution stays uniform because those tiers never stalled and their cascades are expensive
- The opening reveal now searches over the quotas of its unrevealed chunks and freezes them with the first visible numbers, so a cramped first click can still open a playable game without any committed number ever changing
- Opening playout depth is scaled by density (25 moves on easy up to 60 on insane) instead of a single deep requirement
- No-guess engine rewritten: the solver propagates per-cell mine bounds across the whole frontier and enumerates small unresolved components exactly, so hints prove cells safe that the old single-point and subset passes could not reach
- New per-reveal guarantees: a certain move must exist and every enclosed pocket the reveal created must be fully deducible
- Every game now opens on terrain that survives a deterministic playout whose depth scales with difficulty, so no game stalls a few moves in
- Stuck states are honest now: when no re-roll can rescue a position the ambiguous cells are reported and marked, the HUD shows the guess-zone size, those cells carry a dot on the hidden sheet, and the Hint message no longer claims the state is impossible
- Difficulty ladder recompensated: the quota floor inflates the settled mine fraction, so the nominal densities are inverted to land on the intended percentages — Medium 20%, Hard 25%, Expert 30%, Evil 35%, Insane 40% settled, with Easy untouched at 12%
- Removed the forced-opening fallback that pinned mine-free 3x3 areas and revealed them as part of an unrelated click; a reveal now only ever opens the cells it reaches

### Fixed

- Zoom shaking: the lattice glide toward its quantized zoom target is now a critically damped spring integrated with the frame time instead of an exponential per-frame ease — the old ease lurched 35% of the remaining gap in the single frame after each wheel tick and then froze until the next tick, which read as shaking while zooming in; the spring starts and ends at rest and carries its velocity when a new tick retargets it, so successive notches blend into one continuous glide and a fast wheel stroke cruises smoothly
- Stale animation replay: a no-op click no longer re-animates the previous reveal or auto-flag batch (cell change batches are cleared at the start of every click path)
- Re-rolls were no-ops after the first attempt (chunk nonces were restored instead of incremented), so the generator actually explores a different layout per attempt
- External corner removal now animates: when a neighboring cell is discovered, a previously revealed tile's island corner (40% radius plus accent crescent) collapses to the tile radius (10%) over the neighbor's reveal instead of snapping in one frame; corners of cells uncovered in the same batch settle with the flood, and internal concave pockets already animated

### Deprecated

### Removed

### Security
