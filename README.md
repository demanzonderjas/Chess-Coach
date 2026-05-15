# Chess Coach

A local web app that loads a PGN, analyzes every move with **Stockfish** (running in your browser via a Web Worker), and lets you ask **Claude** *why* a move is good or bad so you can improve your decision-making.

Everything runs on your Mac. The only thing that leaves your machine is the question + Stockfish's numbers, which the local server forwards to the Anthropic API.

## Stack

- **Stockfish 18** (NNUE, WebAssembly, single-threaded build by nmrugg) — released Feb 2026, ~3970 Elo on top hardware. Runs in a Web Worker in your browser, no special CORS/COOP-COEP setup needed.
- **Lc0** (Leela Chess Zero) — optional second engine. Native binary, run as a subprocess from Flask via `python-chess`. Comparable strength to Stockfish but very different style (pure NN + MCTS — strong positional / long-term judgment). Enables a "compare both engines" coach mode.
- **chess.js** — PGN parsing and move legality.
- **chessboard.js** — board UI.
- **Flask** — tiny local server that serves the page, proxies `/api/coach` to the Anthropic API so your key stays in `.env`, and proxies `/api/analyze` to Lc0.
- **Claude** (`claude-sonnet-4-5` by default) — generates the natural-language coaching.

## Setup

```bash
# 1. Create a virtualenv (recommended)
python3 -m venv .venv
source .venv/bin/activate

# 2. Install Python deps
pip install -r requirements.txt

# 3. Add your Anthropic API key
cp .env.example .env
# then open .env and paste your key on the ANTHROPIC_API_KEY= line
```

Get an API key at <https://console.anthropic.com/settings/keys>.

### Optional: add Lc0 as a second engine

If you want the "Lc0" / "Both" engine toggles to be active, install Lc0 natively and give it a network weights file:

```bash
# 1. Install the engine itself
brew install lc0

# 2. Download a network. Strong general-purpose nets live at
#    https://lczero.org/play/networks/bestnets/ — pick one (a few hundred MB
#    for a top net, much smaller for a Maia-style net) and save it as:
mkdir -p ~/.local/share/lc0
mv ~/Downloads/<network>.pb.gz ~/.local/share/lc0/weights.pb.gz
```

Alternatively, set `LC0_NETWORK=/path/to/your/network.pb.gz` in `.env`. If Lc0 or its network isn't found, the server still boots happily — the UI just greys out the Lc0 / Both options and `/healthz` reports why.

## Run

```bash
python server.py
```

On first run the server downloads Stockfish 18 into `static/` (~30 MB for the full `single` flavor — `.js` + `.wasm`). After that it starts immediately. Want a smaller download? Set `STOCKFISH_FLAVOR=lite-single` in `.env` (~7 MB, a bit weaker but still much stronger than human GMs).

Open <http://127.0.0.1:5173> in your browser.

## Use

1. Paste a PGN into the textarea at the top and click **Load Game** (or click **Sample Game** to try one).
2. Use **←** / **→** (or the on-screen buttons, or click any move in the list) to navigate.
3. The position you're on gets analyzed automatically. Click **Analyze All Moves** to grind through the whole game — afterwards every move in the list is colored by classification:
   - green underline = best move
   - yellow = inaccuracy
   - orange = mistake
   - red = blunder
4. Pick an engine in the loader bar (**SF18** / **Lc0** / **Both**). "Both" is the most interesting mode: the coach gets BOTH engines' verdicts and explicitly flags agreements/disagreements as teaching material.
5. On the right, click one of the suggested questions (or type your own) and hit **Ask Coach**. The coach gets the FEN, the PGN so far, each enabled engine's eval before & after the move, and its best line — then answers in plain language.

Keyboard shortcuts: `←` / `→` move through plies, `Home` / `End` jump to start/end, `f` flips the board, `Cmd/Ctrl+Enter` in the question box sends the question.

## Tuning

- **Depth**: bump the depth input in the top-right of the loader from 16 up to ~22 for stronger analysis (slower). 16 is a good balance for live navigation; 20+ if you're really grinding a critical position.
- **Engine flavor**: `STOCKFISH_FLAVOR=single` (default, full strength, ~30 MB), `lite-single` (~7 MB, weaker but still well above any human), or `asm` (pure-JS fallback, slow). Single-threaded variants don't require COOP/COEP headers and "just work".
- **Model**: set `CLAUDE_MODEL` in `.env` if you want a different Claude variant.
- **Port**: set `PORT` in `.env` (default 5173).

## Files

```
server.py                          # Flask app — serves static/, proxies /api/coach to Anthropic
requirements.txt
.env.example
static/
  index.html                       # Layout
  style.css                        # Dark theme
  app.js                           # All client logic: PGN → positions → Stockfish → classify → ask Claude
  stockfish-18-single.js           # Downloaded on first run (default flavor)
  stockfish-18-single.wasm
  img/chesspieces/wikipedia/*.png  # Downloaded on first run
```

These auto-downloaded assets (`static/stockfish-*` and `static/img/chesspieces/`) are gitignored — the WASM alone is 113 MB, past GitHub's 100 MB limit. Cloning the repo and running `python server.py` will re-fetch them.

## Notes & limits

- Stockfish 18 NNUE WASM is much faster than the old asm.js builds. Expect roughly half a second per ply at depth 16 on a modern Mac — a 40-move game (80 plies) analyzes in well under a minute. *Analyze All Moves* will sequentially walk the whole game.
- Move classification uses centipawn loss thresholds (30 / 100 / 250), the standard scheme used by most analysis tools.
- The coach is intentionally concise (3–6 sentences per answer) and oriented around concrete lines and human-understandable principles. If you want longer or more lecture-like explanations, just ask: "explain in more detail" or "walk me through the key variation move by move".
