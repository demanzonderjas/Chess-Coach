# Chess Coach

A local web app for analyzing your chess games with two world-class engines side by side. Load a PGN (or import directly from Lichess), and you get Stockfish 18 running in-browser plus Lc0 running natively on your machine, with an eval timeline, plan arrows, creative/sacrifice picks, and a library that auto-saves every game you load.

Everything runs locally. The only data that leaves your machine is Lichess game fetches (when you import) and — if you choose to enable the optional Claude coach — questions and engine numbers forwarded to the Anthropic API.

## What you get

The board sits on the left with an evaluation bar and on-board plan arrows for both sides. To its right are a move list with classification chips and a dedicated analysis panel showing each engine's eval, best move, full PV, and ranked alternatives. Below the board is an eval timeline chart spanning the whole game, with `??` / `?` / `!!` markers floating at the critical moments — click any point to jump there. A library panel slides in from the right with your auto-saved games (grouped by month), an openings registry, and Lichess import (single games or batches).

The analysis goes beyond the standard engine bar:

- **Move classification** with conservative tipping-point detection — only ~2-4 marks per game so the move list stays scannable, not noisy.
- **Brilliant sacrifice detection** (`!!`) when you give up a minor or better and the engine sees the capture as substantially worse than declining.
- **Creative mode** — when an engine has a sound sacrifice within tolerance (default 90cp) of the top line, it's shown as the primary pick with a "sacrifices N♟" badge. The objective top line is still shown underneath.
- **Chaos mode** — picks deliberately unsound moves (captures, checks, material swings) within a wider eval tolerance to maximize opponent difficulty in human games. Trades engine accuracy for practical fighting chances.
- **Plan arrows** — engine PV drawn directly on the board for the side to move, plus the opponent's plan (via null-move analysis) overlaid.
- **Deep dive** — re-analyze the current critical position at base depth + 6 with one click.
- **Variations** — drag pieces to explore sidelines without losing your place; engine PVs are clickable to play through them on the board.

A SQLite cache makes re-opening games instant — both engines' results are persisted keyed by position, depth, and MultiPV, and deeper analyses subsume shallower ones.

## Stack

- **Stockfish 18** (NNUE, WebAssembly, single-threaded build by nmrugg) — released Feb 2026, ~3970 Elo. Runs in a Web Worker in your browser, no COOP/COEP setup required.
- **Lc0** (Leela Chess Zero) — optional second engine. Native binary, run as a subprocess from Flask via `python-chess`. MCTS + neural network — comparable strength to Stockfish but very different style. Enables the "Both" mode that surfaces engine disagreements as teaching moments.
- **chess.js** v0.10.3 (UMD) — PGN parsing, move legality, SAN/UCI conversion.
- **chessboard.js** — board UI (depends on jQuery). Piece PNGs auto-download on first run.
- **Flask** + SQLite — local server, persists the analysis cache (`analysis_cache.db`) and game/opening library (`library.db`).
- **Claude** (`claude-sonnet-4-5` by default) — the `/api/coach` endpoint is wired up and the prompt receives both engines' verdicts, but the chat UI was removed in favor of the engine arrows + eval timeline. Re-enable in `static/index.html` if you want it back; an `ANTHROPIC_API_KEY` is only needed in that case.

## Setup

```bash
# 1. Create a virtualenv (recommended)
python3 -m venv .venv
source .venv/bin/activate

# 2. Install Python deps
pip install -r requirements.txt

# 3. (Optional) Configure
cp .env.example .env
```

The app runs without any configuration — `.env` is only needed if you want to override defaults (Stockfish flavor, Claude model, Lc0 paths, port) or use the disabled Claude coach.

### Optional: add Lc0 as a second engine

To activate the **Lc0** and **Both** engine toggles, install Lc0 natively and give it a network:

```bash
# 1. Install the engine
brew install lc0

# 2. Download a network from https://lczero.org/play/networks/bestnets/
#    A few hundred MB for a top net, much smaller for a Maia-style net.
mkdir -p ~/.local/share/lc0
mv ~/Downloads/<network>.pb.gz ~/.local/share/lc0/weights.pb.gz
```

Alternatively, point `LC0_BINARY` and/or `LC0_NETWORK` in `.env` at custom paths. If Lc0 or its network isn't found, the server boots happily — the UI just greys out the Lc0 / Both options, and `/healthz` reports why.

## Run

```bash
python server.py
```

On first run the server downloads the Stockfish 18 WebAssembly build into `static/` (loader ~20 KB, `.wasm` ~113 MB for the full `single` flavor). After that it starts immediately. Want a smaller download? Set `STOCKFISH_FLAVOR=lite-single` in `.env` (~7 MB total, a bit weaker but still well above any human). Piece PNGs are also auto-downloaded the first time the server boots.

Then open <http://127.0.0.1:5173> in your browser.

## Use

Load a game by pasting a PGN and clicking **Load PGN**, importing from Lichess via the library panel (📚 in the top bar), or hitting **+ New Game** to drag pieces from the starting position. The position you're on gets analyzed automatically as you navigate; **Analyze All** grinds the whole game in the background so the move list, classification chips, and eval timeline fill in.

Navigate with `←` / `→`, `Home` / `End`, or by clicking moves directly. `f` flips the board. `Esc` exits the current variation back to the main game line.

The settings row above the board controls the analysis style. **Depth** is the search depth for SF and a thinktime scale for Lc0 (16 is a sensible default; 20+ is for grinding critical positions). The engine selector picks SF18, Lc0, or both running side by side. **🔥 Creative** prefers sound sacrifice lines when they stay within the tolerance you set; **🌀 Chaos** picks deliberately offbeat moves within a wider tolerance for maximum practical difficulty; **🎯 Plans** draws each side's recommended plan as arrows on the board.

The library panel (📚) auto-saves every PGN you load and lets you import games from Lichess by username (with filters for time control and rated-only) or by direct game URL. Saved games are grouped by month. The same panel houses an openings registry so the app can label what opening you're in via an "Opening:" chip in the analysis column.

## Configuration

All optional, set in `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...        # only needed if you re-enable the coach UI
CLAUDE_MODEL=claude-sonnet-4-5      # alternate Claude variant for /api/coach

STOCKFISH_FLAVOR=single             # "single" (default, ~113 MB) or "lite-single" (~7 MB)
STOCKFISH_NPM_VERSION=18

LC0_BINARY=/opt/homebrew/bin/lc0    # override the auto-detected Lc0 path
LC0_NETWORK=/path/to/weights.pb.gz  # override the auto-detected network path

HOST=127.0.0.1
PORT=5173
```

## Files

```
server.py             # Flask app — serves static/, proxies /api/coach, /api/analyze, /api/library/*
cache.py              # SQLite-backed analysis cache (per-position, per-engine, depth-aware)
lc0_engine.py         # Lc0 subprocess wrapper via python-chess
library.py            # Saved games + openings registry, Lichess import
requirements.txt
.env.example
analysis_cache.db     # SQLite, created on first run
library.db            # SQLite, created on first run
static/
  index.html          # Layout (board | moves | analysis, with eval chart under the board)
  style.css           # Dark theme
  app.js              # All client logic: PGN parsing, Stockfish worker, classification,
                      #   plan arrows, eval timeline, library, variations, coach payload
  stockfish-18-single.js     # Auto-downloaded
  stockfish-18-single.wasm   # Auto-downloaded (~113 MB)
  img/chesspieces/wikipedia/*.png  # Auto-downloaded
```

The auto-downloaded assets are gitignored — the WASM alone exceeds GitHub's 100 MB file limit. Cloning the repo and running `python server.py` will re-fetch them. The two SQLite files are also gitignored so cloned copies start fresh.

## Notes & limits

Stockfish 18 NNUE WASM is much faster than the old asm.js builds — roughly half a second per ply at depth 16 on a modern Mac, so a typical 40-move game analyzes in well under a minute end-to-end. Re-opening a previously-analyzed position is instant thanks to the cache. Lc0 analysis is measured in movetime rather than nodes (the nodes-based limit blew up on the Metal backend); roughly 3 seconds per move at the default depth.

Move classification uses centipawn-loss thresholds (30 / 100 / 250) with an extra "tipping point" filter for the `??` / `?` chips — a move only gets a chip if the eval crossed a practical bucket boundary (winning → equal → losing), keeping the annotations focused on the moves that mattered. The eval timeline mirrors the same logic.

The Claude coach endpoint is still wired up server-side and the prompt is structured to receive both engines' verdicts plus the creative and chaos picks — but the chat UI was removed from the layout. Re-enabling means restoring the `.coach-col` section in `static/index.html` and the matching listener wiring; the `askCoach()` JS function and Flask route are intact.
