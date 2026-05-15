"""
Chess Coach — local Flask server.

Serves the static frontend and proxies the Anthropic API so your API key
never leaves the machine. Also downloads Stockfish on first run.

Run:
    python server.py
Then open http://127.0.0.1:5173 in your browser.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from dotenv import load_dotenv

try:
    from anthropic import Anthropic
except ImportError:
    print("Missing dependency: anthropic. Run: pip install -r requirements.txt")
    sys.exit(1)

try:
    from lc0_engine import setup_lc0, Lc0Engine  # noqa: F401
except Exception as _lc0_import_err:  # pragma: no cover
    setup_lc0 = None
    _lc0_import_error = str(_lc0_import_err)
else:
    _lc0_import_error = None

from cache import AnalysisCache
from library import Library
from book import Book


# --- Config -----------------------------------------------------------------

ROOT = Path(__file__).parent.resolve()
STATIC = ROOT / "static"

# Stockfish 18 (released 2026-01-31, npm port v18.0.0 by nmrugg, 2026-02-11).
# Variants: https://github.com/nmrugg/stockfish.js/releases/tag/v18.0.0
#
#   "single"      – large single-threaded NNUE (≈30MB total) — STRONGEST without
#                   needing COOP/COEP headers. Default.
#   "lite-single" – small single-threaded NNUE (≈7MB total) — quite a bit weaker
#                   but plenty for coaching, much faster to download.
#   "threaded"    – large multi-threaded NNUE — fastest, but requires
#                   cross-origin isolation (COOP/COEP). Not wired up here.
#   "asm"         – pure JS fallback. Don't use unless WASM is unavailable.
#
# Override the default by setting STOCKFISH_FLAVOR=lite-single in .env
STOCKFISH_FLAVOR = os.environ.get("STOCKFISH_FLAVOR", "single").lower()
# We try a list of mirrors for each file. jsDelivr and unpkg serve the npm
# `stockfish` package directly (no auth, no redirect hijinks). The GitHub
# Releases URL is kept as a fallback but is finicky: it issues a redirect to
# a signed Azure URL that some clients (or specific User-Agents) fail to
# follow correctly, leaving you with a 20KB error page.
_STOCKFISH_NPM_VERSION = os.environ.get("STOCKFISH_NPM_VERSION", "18")
STOCKFISH_MIRROR_BASES = [
    f"https://cdn.jsdelivr.net/npm/stockfish@{_STOCKFISH_NPM_VERSION}/src",
    f"https://unpkg.com/stockfish@{_STOCKFISH_NPM_VERSION}/src",
    "https://github.com/nmrugg/stockfish.js/releases/download/v18.0.0",
]
STOCKFISH_FLAVOR_FILES = {
    "single":      ["stockfish-18-single.js",      "stockfish-18-single.wasm"],
    "lite-single": ["stockfish-18-lite-single.js", "stockfish-18-lite-single.wasm"],
    "asm":         ["stockfish-18-asm.js"],
}
if STOCKFISH_FLAVOR not in STOCKFISH_FLAVOR_FILES:
    print(f"Unknown STOCKFISH_FLAVOR={STOCKFISH_FLAVOR!r}; falling back to 'single'.")
    STOCKFISH_FLAVOR = "single"

STOCKFISH_FILES = STOCKFISH_FLAVOR_FILES[STOCKFISH_FLAVOR]
STOCKFISH_WORKER_URL = "/static/" + STOCKFISH_FILES[0]

# Piece images for chessboard.js. The @chrisoakman/chessboardjs npm package
# does NOT ship images, so we pull them from the canonical site and serve
# them locally — keeps the app working offline after first launch.
PIECES_DIR = ROOT / "static" / "img" / "chesspieces" / "wikipedia"
PIECE_URL_TEMPLATE = "https://chessboardjs.com/img/chesspieces/wikipedia/{p}.png"
PIECES = ["wP", "wR", "wN", "wB", "wQ", "wK", "bP", "bR", "bN", "bB", "bQ", "bK"]

CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "5173"))

load_dotenv(ROOT / ".env")

API_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not API_KEY:
    print(
        "Warning: ANTHROPIC_API_KEY is not set. The coach endpoint will return "
        "an error. Copy .env.example to .env and add your key."
    )

client = Anthropic(api_key=API_KEY) if API_KEY else None

# --- Analysis cache (SQLite). Optional — server boots even if it fails. ---
try:
    _cache = AnalysisCache()
    print(f"Analysis cache opened at {_cache.db_path} "
          f"({_cache.stats()['total']} positions cached)")
except Exception as e:
    print(f"  ! Could not open analysis cache: {e}\n"
          f"  ! Cache is disabled. Analyses will not be persisted between runs.")
    _cache = None


def _cache_get(*args, **kwargs):
    return _cache.get(*args, **kwargs) if _cache else None


def _cache_put(*args, **kwargs):
    if _cache:
        try: _cache.put(*args, **kwargs)
        except Exception as e: print(f"  ! cache.put failed (continuing): {e}")


# --- Library (openings + saved games). Optional — server boots even if it fails. ---
try:
    _library = Library()
    _stats = _library.stats()
    print(f"Library opened at {_library.db_path} "
          f"({_stats['games']} games, {_stats['openings']} openings)")
except Exception as e:
    print(f"  ! Could not open library: {e}\n"
          f"  ! Library is disabled. PGNs will not be auto-saved.")
    _library = None

# --- Book (opening-theory recommendations). Optional — server boots even if it fails. ---
try:
    _book = Book()
    _book_stats = _book.stats()
    print(f"Book opened at {_book.db_path} "
          f"({_book_stats['lines']} lines, {_book_stats['moves']} moves, "
          f"{_book_stats['positions']} positions)")
except Exception as e:
    print(f"  ! Could not open book: {e}\n"
          f"  ! Book lookups are disabled.")
    _book = None

# --- Lc0 setup ---
_lc0_engine: "Lc0Engine | None" = None
_lc0_status: dict = {"available": False, "reason": "not initialized"}
if setup_lc0 is not None:
    try:
        _lc0_engine, _lc0_status = setup_lc0()
    except Exception as e:
        _lc0_status = {"available": False, "reason": f"setup error: {e}", "hint": None}
elif _lc0_import_error:
    _lc0_status = {
        "available": False,
        "reason": "python-chess not installed",
        "hint": f"Run: pip install -r requirements.txt  ({_lc0_import_error})",
    }


# --- Stockfish bootstrap ----------------------------------------------------

# Minimum sizes used as a sanity check. The .js loader can be small (some
# emscripten outputs are ~20KB), so we use a low floor for .js and rely
# mostly on content-sniffing to detect error pages. The .wasm is always big.
_STOCKFISH_MIN_SIZE = {".js": 8_000, ".wasm": 1_000_000}

# A handful of bytes that, if seen near the start of a downloaded file,
# indicate we got an HTML/error page instead of the real engine file.
_HTML_SNIFFS = (b"<!doctype", b"<!DOCTYPE", b"<html", b"<HTML", b"<?xml")


def _stockfish_file_threshold(name: str) -> int:
    ext = "." + name.rsplit(".", 1)[-1]
    return _STOCKFISH_MIN_SIZE.get(ext, 8_000)


def _looks_like_engine_file(path: Path) -> tuple[bool, str]:
    """Heuristic check: did we get the real file, or an HTML error page?"""
    if not path.exists():
        return False, "missing"
    size = path.stat().st_size
    if size < _stockfish_file_threshold(path.name):
        return False, f"too small ({size} bytes)"
    if path.suffix == ".wasm":
        # WASM files start with the 4-byte magic '\x00asm'.
        with open(path, "rb") as f:
            magic = f.read(4)
        if magic != b"\x00asm":
            return False, f"not a WASM file (magic={magic!r})"
        return True, "ok"
    # .js: reject HTML error pages by sniffing the first 256 bytes.
    with open(path, "rb") as f:
        head = f.read(256).lstrip()
    if any(head.startswith(s) for s in _HTML_SNIFFS) or b"<html" in head.lower():
        return False, "looks like an HTML error page"
    return True, "ok"


def _stockfish_file_ok(name: str) -> bool:
    return _looks_like_engine_file(STATIC / name)[0]


def _download_one(name: str) -> bool:
    """Try each mirror in turn for a single file. Returns True on success."""
    dest = STATIC / name
    last_err = "no mirrors tried"
    # Some CDNs gatekeep on User-Agent. Pretend to be a normal browser.
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        )
    }
    for base in STOCKFISH_MIRROR_BASES:
        url = f"{base}/{name}"
        print(f"  - {name}  trying {base.split('/')[2]} ... ", end="", flush=True)
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as out:
                # Stream copy so we don't load 30MB into memory at once.
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            ok, why = _looks_like_engine_file(dest)
            if not ok:
                raise IOError(why)
            size = dest.stat().st_size
            print(f"{size / (1024 * 1024):.2f} MB ✓", flush=True)
            return True
        except Exception as e:
            last_err = str(e)
            print(f"FAILED: {e}", flush=True)
            if dest.exists():
                try: dest.unlink()
                except OSError: pass
    print(
        f"  ! All mirrors failed for {name}.\n"
        f"  ! Last error: {last_err}\n"
        f"  ! Fix: pick any mirror above, download {name} manually, and save "
        f"it at {dest}. Then reload the page (no server restart needed).",
        flush=True,
    )
    return False


def ensure_stockfish() -> bool:
    """Download Stockfish 18 (the chosen flavor) to static/ if missing.

    Each flavor needs its .js file and (for WASM flavors) a matching .wasm.
    The Web Worker loads the .js, which then fetches the .wasm by relative
    path from the same directory.
    """
    STATIC.mkdir(parents=True, exist_ok=True)
    missing = [f for f in STOCKFISH_FILES if not _stockfish_file_ok(f)]
    if not missing:
        return True

    print(f"Downloading Stockfish 18 (flavor: {STOCKFISH_FLAVOR}) ...", flush=True)
    print(f"  This is a one-time download. Files are cached in {STATIC}/.", flush=True)
    for name in missing:
        if not _download_one(name):
            return False

    # Remove the old SF10 file if it's left over from a prior install.
    legacy = STATIC / "stockfish.js"
    if legacy.exists() and legacy.stat().st_size < 5 * 1024 * 1024:
        try:
            legacy.unlink()
            print(f"  (cleaned up legacy {legacy.name})", flush=True)
        except OSError:
            pass
    return True


def ensure_pieces() -> bool:
    """Download chessboard.js piece images to static/img/ on first run."""
    PIECES_DIR.mkdir(parents=True, exist_ok=True)

    def needs(p: str) -> bool:
        f = PIECES_DIR / f"{p}.png"
        return (not f.exists()) or f.stat().st_size < 200

    missing = [p for p in PIECES if needs(p)]
    if not missing:
        return True

    print(f"Downloading {len(missing)} chess piece images ...", flush=True)
    failed = []
    for p in missing:
        url = PIECE_URL_TEMPLATE.format(p=p)
        dest = PIECES_DIR / f"{p}.png"
        try:
            urllib.request.urlretrieve(url, dest)
        except Exception as e:
            failed.append((p, str(e)))
            if dest.exists():
                try: dest.unlink()
                except OSError: pass

    if failed:
        names = ", ".join(p for p, _ in failed)
        print(
            f"  ! Could not download piece images: {names}\n"
            f"  ! The board will show broken-image icons. Run the server again "
            f"once you have internet, or copy the PNGs manually into {PIECES_DIR}.",
            flush=True,
        )
        return False
    print(f"Saved piece images to {PIECES_DIR}", flush=True)
    return True


# --- App --------------------------------------------------------------------

app = Flask(__name__, static_folder=str(STATIC), static_url_path="/static")


# CORS for the book API only. Lets a tab on https://www.chessable.com (or
# anywhere else) POST directly to /api/book/import_chessable without the
# cross-tab dance. The rest of the API stays same-origin only — only the
# book endpoints are intended to be hit from arbitrary pages.
_CORS_PATHS = ("/api/book/",)


@app.after_request
def _add_cors_headers(resp):
    if request.path.startswith(_CORS_PATHS):
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
        resp.headers["Access-Control-Max-Age"] = "3600"
    return resp


@app.route("/api/book/<path:_>", methods=["OPTIONS"])
def _book_cors_preflight(_):
    # Empty response with the CORS headers added by _add_cors_headers above.
    return ("", 204)


@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/healthz")
def healthz():
    engine_ok = all(_stockfish_file_ok(f) for f in STOCKFISH_FILES)
    # Don't leak the full filesystem path in lc0 status — just present
    # whether things are wired up and a helpful hint if not.
    lc0_public = {
        "available": bool(_lc0_status.get("available")),
        "reason": _lc0_status.get("reason"),
        "hint": _lc0_status.get("hint"),
    }
    return jsonify({
        "ok": True,
        "claude_configured": bool(client),
        "engine": {
            "name": "Stockfish 18",
            "flavor": STOCKFISH_FLAVOR,
            "worker_url": STOCKFISH_WORKER_URL,
            "available": engine_ok,
        },
        "lc0": lc0_public,
    })


@app.route("/api/analyze", methods=["POST"])
def analyze():
    """Server-side analysis endpoint, currently only used for Lc0.

    Request body: { fen, engine: "lc0", nodes?, movetime_ms?, depth? }
    Response: { cp?, mate?, bestMove (uci), pv: [uci...], depth, nodes }
    """
    try:
        payload = request.get_json(force=True) or {}
    except Exception as e:
        return jsonify({"error": f"Invalid JSON: {e}"}), 400

    fen = (payload.get("fen") or "").strip()
    if not fen:
        return jsonify({"error": "Missing 'fen' in request body."}), 400

    engine_name = (payload.get("engine") or "lc0").lower()
    if engine_name != "lc0":
        return jsonify({"error": f"Unknown engine: {engine_name!r}. Only 'lc0' is supported server-side; Stockfish runs in the browser."}), 400

    # Normalize the effort budget into (limit_type, limit_value) for caching.
    if payload.get("nodes") is not None:
        limit_type, limit_value = "nodes", int(payload["nodes"])
    elif payload.get("movetime_ms") is not None:
        limit_type, limit_value = "movetime", int(payload["movetime_ms"])
    elif payload.get("depth") is not None:
        limit_type, limit_value = "depth", int(payload["depth"])
    else:
        limit_type, limit_value = "nodes", 20000
    multipv = int(payload.get("multipv") or 4)

    # Cache lookup. May return a cached result for a STRONGER analysis than
    # requested (deeper depth / longer movetime), which is still valid.
    cached = _cache_get("lc0", fen, limit_type, limit_value, multipv)
    if cached:
        return jsonify({**cached, "engine": "lc0", "cached": True})

    if not _lc0_engine:
        return jsonify({
            "error": "Lc0 is not available.",
            "reason": _lc0_status.get("reason"),
            "hint": _lc0_status.get("hint"),
        }), 503

    try:
        result = _lc0_engine.analyze(
            fen,
            nodes=payload.get("nodes"),
            movetime_ms=payload.get("movetime_ms"),
            depth=payload.get("depth"),
            multipv=multipv,
        )
        result["engine"] = "lc0"
        _cache_put("lc0", fen, limit_type, limit_value, multipv, result)
        return jsonify(result)
    except Exception as e:
        # If the subprocess died, drop our reference so the next call retries.
        try:
            _lc0_engine.close()
        except Exception:
            pass
        return jsonify({"error": f"Lc0 analysis failed: {e}"}), 502


# --- Cache endpoints (used by the in-browser Stockfish worker) ---

@app.route("/api/cache", methods=["GET"])
def cache_get():
    engine = (request.args.get("engine") or "").strip()
    fen = (request.args.get("fen") or "").strip()
    limit_type = (request.args.get("limit_type") or "").strip()
    limit_value = request.args.get("limit_value", type=int)
    multipv = request.args.get("multipv", type=int, default=1)
    if not (engine and fen and limit_type and limit_value is not None):
        return jsonify({"error": "Missing required params: engine, fen, limit_type, limit_value"}), 400
    result = _cache_get(engine, fen, limit_type, limit_value, multipv)
    if result is None:
        return jsonify({"hit": False}), 404
    return jsonify({"hit": True, "result": result})


@app.route("/api/cache", methods=["POST"])
def cache_put():
    if _cache is None:
        return jsonify({"error": "Cache is disabled on the server."}), 503
    try:
        body = request.get_json(force=True) or {}
    except Exception as e:
        return jsonify({"error": f"Invalid JSON: {e}"}), 400
    engine      = (body.get("engine") or "").strip()
    fen         = (body.get("fen") or "").strip()
    limit_type  = (body.get("limit_type") or "").strip()
    limit_value = body.get("limit_value")
    multipv     = int(body.get("multipv") or 1)
    result      = body.get("result")
    if not (engine and fen and limit_type and limit_value is not None and isinstance(result, dict)):
        return jsonify({"error": "Missing required fields"}), 400
    _cache_put(engine, fen, limit_type, int(limit_value), multipv, result)
    return jsonify({"ok": True, "stats": _cache.stats()})


@app.route("/api/cache/batch", methods=["POST"])
def cache_batch():
    """Batch cache lookup. Lets the frontend prefetch evals for every move of
    a loaded game in a single round-trip.

    Body: { engine, fens: [str], limit_type, limit_value, multipv? }
    Returns: { results: [ result_dict | null ] }  (parallel to `fens`)
    """
    try:
        body = request.get_json(force=True) or {}
    except Exception as e:
        return jsonify({"error": f"Invalid JSON: {e}"}), 400
    engine      = (body.get("engine") or "").strip()
    fens        = body.get("fens") or []
    limit_type  = (body.get("limit_type") or "").strip()
    limit_value = body.get("limit_value")
    multipv     = int(body.get("multipv") or 1)
    if not (engine and limit_type and limit_value is not None and isinstance(fens, list)):
        return jsonify({"error": "Missing required fields"}), 400
    results = [
        _cache_get(engine, fen, limit_type, int(limit_value), multipv)
        for fen in fens
    ]
    return jsonify({"results": results})


@app.route("/api/cache/stats", methods=["GET"])
def cache_stats():
    if _cache is None:
        return jsonify({"enabled": False})
    return jsonify({"enabled": True, **_cache.stats()})


# --- Library API ------------------------------------------------------------
# Persistent storage for the user's registered openings + every PGN they've
# imported. Auto-tags games against the openings registry by walking each
# game's FENs and finding the deepest match — so transpositions just work.

def _require_library():
    if _library is None:
        return jsonify({"error": "library disabled"}), 503
    return None


@app.route("/api/library/openings", methods=["GET"])
def library_list_openings():
    err = _require_library()
    if err: return err
    return jsonify({"openings": _library.list_openings()})


@app.route("/api/library/openings", methods=["POST"])
def library_create_opening():
    err = _require_library()
    if err: return err
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    raw = data.get("san_moves")
    # Accept either a list of SAN strings or a single string we tokenize.
    if isinstance(raw, str):
        # Strip move numbers like "1.", "1...", "2." so the user can paste
        # SAN as it appears in a PGN ("1. e4 e5 2. Nf3 Nc6").
        cleaned = []
        for tok in raw.replace(",", " ").split():
            if not tok: continue
            if tok.endswith(".") and tok.rstrip(".").lstrip("-").isdigit():
                continue  # bare move number like "1." or "1..."
            cleaned.append(tok)
        san_list = cleaned
    elif isinstance(raw, list):
        san_list = [str(x).strip() for x in raw if str(x).strip()]
    else:
        return jsonify({"error": "san_moves must be a list or string"}), 400
    try:
        opening = _library.create_opening(name, san_list)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(opening)


@app.route("/api/library/openings/<int:opening_id>", methods=["DELETE"])
def library_delete_opening(opening_id: int):
    err = _require_library()
    if err: return err
    deleted = _library.delete_opening(opening_id)
    return jsonify({"ok": deleted})


@app.route("/api/library/games", methods=["GET"])
def library_list_games():
    err = _require_library()
    if err: return err
    limit = request.args.get("limit", default=100, type=int)
    opening_id = request.args.get("opening_id", type=int)
    return jsonify({"games": _library.list_games(limit=limit, opening_id=opening_id)})


@app.route("/api/library/games/<int:game_id>", methods=["GET"])
def library_get_game(game_id: int):
    err = _require_library()
    if err: return err
    game = _library.get_game(game_id)
    if game is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(game)


@app.route("/api/library/games", methods=["POST"])
def library_save_game():
    err = _require_library()
    if err: return err
    data = request.get_json(silent=True) or {}
    pgn = data.get("pgn") or ""
    source = (data.get("source") or "import").strip() or "import"
    try:
        saved = _library.save_game(pgn, source=source)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(saved)


@app.route("/api/library/games/<int:game_id>", methods=["DELETE"])
def library_delete_game(game_id: int):
    err = _require_library()
    if err: return err
    deleted = _library.delete_game(game_id)
    return jsonify({"ok": deleted})


@app.route("/api/library/import_lichess_game", methods=["POST"])
def library_import_lichess_game():
    """Import a single Lichess game by URL or ID. Use when Lichess hasn't
    yet indexed a just-finished game into the user-archive endpoint —
    this fetches the game directly."""
    err = _require_library()
    if err: return err
    data = request.get_json(silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "url is required"}), 400
    username = (data.get("username") or "").strip() or None
    try:
        result = _library.import_lichess_game(url, username=username)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except urllib.error.HTTPError as e:
        msg = f"Lichess HTTP {e.code}"
        try: msg = f"{msg}: {e.read().decode('utf-8', errors='replace')[:200]}"
        except Exception: pass
        return jsonify({"error": msg}), 502
    except Exception as e:
        return jsonify({"error": f"Lichess fetch failed: {e}"}), 502
    return jsonify(result)


@app.route("/api/library/import_lichess", methods=["POST"])
def library_import_lichess():
    """Fetch a user's Lichess games and bulk-import into the library.
    Anonymous; respects Lichess rate limits implicitly via max-cap."""
    err = _require_library()
    if err: return err
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    if not username:
        return jsonify({"error": "username is required"}), 400
    try:
        max_games = int(data.get("max", 50))
    except (TypeError, ValueError):
        return jsonify({"error": "max must be an integer"}), 400
    perf_type = (data.get("perfType") or "").strip() or None
    color_raw = (data.get("color") or "").strip().lower() or None
    if color_raw not in (None, "white", "black"):
        return jsonify({"error": "color must be 'white' or 'black'"}), 400
    rated = data.get("rated")
    if rated is not None and not isinstance(rated, bool):
        rated = str(rated).lower() in ("1", "true", "yes")
    try:
        result = _library.import_from_lichess(
            username,
            max_games=max_games,
            rated=rated,
            perf_type=perf_type,
            color=color_raw,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except urllib.error.HTTPError as e:  # type: ignore[attr-defined]
        # Lichess returns 404 for unknown user, 429 if rate-limited.
        msg = f"Lichess HTTP {e.code}"
        try: msg = f"{msg}: {e.read().decode('utf-8', errors='replace')[:200]}"
        except Exception: pass
        return jsonify({"error": msg}), 502
    except Exception as e:
        return jsonify({"error": f"Lichess fetch failed: {e}"}), 502
    return jsonify(result)


# --- Book API ---------------------------------------------------------------
# Separate from /api/library/openings. The library tags games against named
# opening *positions*; the book stores "what move should I play here" rows
# keyed by FEN, so we can surface recommendations as the user navigates.

def _require_book():
    if _book is None:
        return jsonify({"error": "book disabled"}), 503
    return None


@app.route("/api/book/lookup", methods=["GET"])
def book_lookup():
    """Return all book moves recommended at this position. Used by the
    frontend on every position change to drive the BOOK badge + candidate
    highlight. Cheap: one indexed SQLite query."""
    err = _require_book()
    if err: return err
    fen = (request.args.get("fen") or "").strip()
    if not fen:
        return jsonify({"error": "Missing 'fen' query param."}), 400
    return jsonify({"moves": _book.lookup(fen)})


@app.route("/api/book/lookup_batch", methods=["POST"])
def book_lookup_batch():
    """Bulk lookup. Body: { fens: [str] }. Response: { results: { fen: [moves] } }."""
    err = _require_book()
    if err: return err
    data = request.get_json(silent=True) or {}
    fens = data.get("fens") or []
    if not isinstance(fens, list):
        return jsonify({"error": "fens must be a list"}), 400
    return jsonify({"results": _book.lookup_batch(fens)})


@app.route("/api/book/lines", methods=["GET"])
def book_list_lines():
    err = _require_book()
    if err: return err
    return jsonify({"lines": _book.list_lines()})


@app.route("/api/book/lines/<int:line_id>", methods=["GET"])
def book_get_line(line_id: int):
    err = _require_book()
    if err: return err
    line = _book.get_line(line_id)
    if line is None:
        return jsonify({"error": "not found"}), 404
    return jsonify(line)


@app.route("/api/book/lines", methods=["POST"])
def book_create_line():
    """Create a new line. Accepts EITHER:
        { name, pgn, color?, source?, source_url?, notes?, include_variations? }
      OR
        { name, san_moves: [str], color?, source?, source_url?, notes?,
          comments?: [str|null], nags?: [str|null], starting_fen?: str }
    PGN form handles branching variations natively. SAN form is for flat
    Chessable-screenshot-style ingestion where you've already extracted
    the moves into a list."""
    err = _require_book()
    if err: return err
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    color = data.get("color")
    if color is not None:
        color = str(color).lower().strip() or None
        if color not in (None, "w", "b", "white", "black"):
            return jsonify({"error": "color must be 'w', 'b', or null"}), 400
        if color in ("white", "w"): color = "w"
        elif color in ("black", "b"): color = "b"
    source = (data.get("source") or "manual").strip() or "manual"
    source_url = (data.get("source_url") or "").strip() or None
    notes = (data.get("notes") or "").strip() or None

    pgn_text = (data.get("pgn") or "").strip()
    san_moves = data.get("san_moves")

    try:
        if pgn_text:
            result = _book.create_line_from_pgn(
                name=name, pgn_text=pgn_text, color=color,
                source=source, source_url=source_url, notes=notes,
                include_variations=bool(data.get("include_variations", True)),
            )
        elif isinstance(san_moves, list):
            comments = data.get("comments")
            nags = data.get("nags")
            starting_fen = (data.get("starting_fen") or "").strip() or None
            result = _book.create_line_from_sans(
                name=name,
                san_moves=[str(m).strip() for m in san_moves if str(m).strip()],
                color=color,
                source=source,
                source_url=source_url,
                notes=notes,
                comments=comments if isinstance(comments, list) else None,
                nags=nags if isinstance(nags, list) else None,
                starting_fen=starting_fen,
            )
        else:
            return jsonify({"error": "Provide either 'pgn' or 'san_moves'."}), 400
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(result)


@app.route("/api/book/lines/<int:line_id>", methods=["DELETE"])
def book_delete_line(line_id: int):
    err = _require_book()
    if err: return err
    return jsonify({"ok": _book.delete_line(line_id)})


@app.route("/api/book/import_chessable", methods=["POST", "OPTIONS"])
def book_import_chessable():
    """One-shot import of a whole Chessable chapter. Body:
        {
          "course":      "Grandmaster Gambits: 1.e4 — Part 1",
          "chapter":     "Theory 1B: 3.Bc4 others",
          "source_url":  "https://www.chessable.com/course/59936/2/",
          "color":       "w" | "b" | null,
          "cards": [
            {"id": "v10582175", "title": "1 e4 e5 ... #1", "moves": "1.e4 e5 ..."},
            ...
          ]
        }

    Returns:
        { "inserted": [...], "skipped": [...], "failed": [...] }

    Skip rule: if a `book_lines` row with (name, source_url) already exists,
    that card is reported as "skipped" with the existing line id — so this
    endpoint is idempotent. Useful for re-running an ingest after the user
    has added new variations to a chapter without duplicating existing ones."""
    if request.method == "OPTIONS":
        return ("", 204)
    err = _require_book()
    if err: return err
    data = request.get_json(silent=True) or {}
    course = (data.get("course") or "").strip() or "Chessable course"
    chapter = (data.get("chapter") or "").strip() or "Chessable chapter"
    source_url = (data.get("source_url") or "").strip() or None
    color = data.get("color")
    if color in ("white", "w"): color = "w"
    elif color in ("black", "b"): color = "b"
    elif color: color = None
    cards = data.get("cards") or []
    if not isinstance(cards, list) or not cards:
        return jsonify({"error": "cards must be a non-empty list"}), 400

    # Pre-compute existing names for idempotent re-ingestion.
    existing = {(l["name"], l.get("source_url")) for l in _book.list_lines()}

    inserted: list[dict] = []
    skipped:  list[dict] = []
    failed:   list[dict] = []
    for c in cards:
        title = (c.get("title") or "").strip()
        moves = (c.get("moves") or "").strip()
        vid   = (c.get("id") or "").strip()
        if not title or not moves:
            failed.append({"title": title, "error": "missing title or moves"})
            continue
        name = f"{chapter} — {title}"
        if (name, source_url) in existing:
            skipped.append({"title": title, "name": name, "reason": "already present"})
            continue
        pgn = (
            f'[Event "{course}"]\n'
            f'[Site "Chessable"]\n'
            f'[Chapter "{chapter}"]\n'
            f'[Variation "{title}"]\n'
            f'[ChessableId "{vid}"]\n\n'
            f"{moves} *"
        )
        try:
            r = _book.create_line_from_pgn(
                name=name, pgn_text=pgn, color=color,
                source="chessable", source_url=source_url,
                notes=f"{course} → {chapter}. Chessable variation id: {vid}.",
                include_variations=False,
            )
            inserted.append({"title": title, "id": r["id"], "move_count": r["move_count"]})
        except Exception as e:
            failed.append({"title": title, "error": str(e)})

    return jsonify({
        "inserted": inserted,
        "skipped":  skipped,
        "failed":   failed,
        "total":    len(cards),
    })


@app.route("/api/book/lines/<int:line_id>/moves", methods=["POST"])
def book_append_move(line_id: int):
    """Append a single SAN move to an existing line. Body:
        { san, parent_move_id?, comment?, nag? }
    Used by the manual 'add to book' flow and by my screenshot/Chrome
    ingestion to grow a line incrementally."""
    err = _require_book()
    if err: return err
    data = request.get_json(silent=True) or {}
    san = (data.get("san") or "").strip()
    if not san:
        return jsonify({"error": "san is required"}), 400
    try:
        result = _book.append_move(
            line_id=line_id,
            san=san,
            parent_move_id=data.get("parent_move_id"),
            comment=(data.get("comment") or "").strip() or None,
            nag=(data.get("nag") or "").strip() or None,
        )
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(result)


@app.route("/api/book/stats", methods=["GET"])
def book_stats():
    if _book is None:
        return jsonify({"enabled": False})
    return jsonify({"enabled": True, **_book.stats()})


COACH_SYSTEM_PROMPT = """You are a chess coach helping an intermediate-to-advanced player improve their decision-making.

You will receive:
- The PGN moves played so far
- The current position (FEN)
- Whose turn it is
- The move the player just made (or is asking about)
- Engine evaluations BEFORE and AFTER the move, plus recommended best lines.
  This may come from Stockfish 18 only, Lc0 only, or BOTH engines.
- The player's specific question

When BOTH engines are available, treat them as two expert second opinions:
- Stockfish 18 is alpha-beta with NNUE — sharp, concrete, tactically deep.
- Lc0 is pure neural network with MCTS — strong positional / long-term judgment.
- If the engines AGREE on the best move and the verdict, present a single confident answer.
- If they DISAGREE, this is the most interesting case — explain WHY they likely differ
  (Stockfish sees a concrete tactic Lc0 underweights; Lc0 prefers a long-term structural
  asset Stockfish discounts; one sees a fortress the other doesn't; etc). Use the
  disagreement itself as teaching material.
- Their centipawn scales aren't identical (Lc0 cp is sigmoid-derived from WDL,
  Stockfish cp is classical), so don't compare numbers directly — compare DIRECTION
  (winning/balanced/losing) and ranking of candidate moves.

The PLAYER prefers aggressive, creative chess and is happy to sacrifice material for
initiative when it's sound. When an engine section reports a "creative SACRIFICE
alternative", that's a non-top engine candidate that GIVES UP material but stays within
the soundness window (~35cp of the engine's top eval). Treat these as first-class
teaching material:
- Explain WHY the sacrifice works — what activity, threats, attacking chances, or
  structural weaknesses does it create that compensate for the lost material?
- Compare it to the "objective best" line and explain the trade-off: what's the
  practical or psychological advantage of the sacrifice vs. the safer line?
- If a sacrifice is identified, lead with it (the player asked for this) but
  acknowledge the safer top-line as the engine's objective preference.
- Do NOT invent sacrifices that the engines didn't suggest. Only discuss what's in
  the context.

Your job:
1. Answer the player's question directly and concisely.
2. Ground your explanation in concrete chess ideas: tactics (forks, pins, skewers,
   discovered attacks), structure (pawn chains, weak squares, outposts), king safety,
   piece activity, tempo, and prophylaxis.
3. When citing engine evaluations, translate centipawn numbers into meaning
   ("+0.8 ≈ small but real edge for White", "−2.5 ≈ near-decisive for Black").
4. If the move was a mistake, identify the SPECIFIC concrete reason it fails — show
   the line: "After ...Nxe5 Bxe5 Qxe5 the d6 pawn falls and Black is just down a piece".
5. If the move was good, identify the SPECIFIC concrete reason it works.
6. Where helpful, contrast with the engine's recommended move and explain WHY that
   move is stronger in human-understandable terms.
7. End with one actionable takeaway the player can apply in future games — a pattern,
   principle, or thinking habit. Keep this one sentence.

Style:
- Conversational but precise. Use SAN notation for moves (Nf3, exd5, O-O).
- No bullet lists unless the player explicitly asks for a list. Write in prose.
- Don't pad. 3–6 sentences is usually enough (a bit longer is fine when the
  engines disagree and there's a real lesson in the disagreement).
- Don't restate the question or hedge. Lead with the answer.
- Assume the player knows piece names, basic notation, and common tactical motifs.
"""


def _format_eval(cp: float | None, mate: int | None) -> str:
    if mate is not None:
        return f"mate in {abs(mate)} ({'White' if mate > 0 else 'Black'} winning)"
    if cp is None:
        return "unknown"
    pawns = cp / 100.0
    sign = "+" if pawns >= 0 else ""
    return f"{sign}{pawns:.2f}"


def _engine_section(label: str, data: dict, last_move_san: str | None) -> list[str]:
    """Format a single engine's analysis block for the coach prompt."""
    lines: list[str] = [f"--- {label} ---"]
    eb = data.get("evalBefore") or {}
    ea = data.get("evalAfter") or {}
    if eb:
        lines.append(f"Eval BEFORE the move: {_format_eval(eb.get('cp'), eb.get('mate'))}")
    if ea:
        lines.append(f"Eval AFTER the move:  {_format_eval(ea.get('cp'), ea.get('mate'))}")
    if data.get("bestMoveSan"):
        ref = last_move_san or "the player's move"
        lines.append(f"{label}'s preferred move in the position before {ref}: {data['bestMoveSan']}")
    if data.get("bestLine"):
        lines.append(f"{label} main line: {' '.join(data['bestLine'])}")
    if data.get("depth") is not None:
        lines.append(f"Analysis depth: {data['depth']}")
    if data.get("nodes") is not None:
        lines.append(f"Nodes searched: {data['nodes']:,}")

    # Creative (sacrifice) alternative within the soundness window
    creative = data.get("creative")
    if creative:
        ev = creative.get("eval") or {}
        eval_str = _format_eval(ev.get("cp"), ev.get("mate"))
        delta_cp = creative.get("materialDelta") or 0
        pawns = abs(delta_cp) / 100.0
        lines.append(
            f"{label} ALSO identified a creative SACRIFICE alternative within the "
            f"soundness window: {creative.get('moveSan')} (eval {eval_str}, "
            f"sacrifices ≈ {pawns:.1f} pawns of material)."
        )
        if creative.get("line"):
            lines.append(f"{label} sacrifice line: {' '.join(creative['line'])}")
    return lines


def _build_coach_user_message(payload: dict) -> str:
    pgn = payload.get("pgn", "").strip()
    fen = payload.get("fen", "").strip()
    side_to_move = payload.get("sideToMove", "")
    move_number = payload.get("moveNumber")
    last_move_san = payload.get("lastMoveSan")
    last_move_by = payload.get("lastMoveBy")  # 'white' or 'black'
    question = payload.get("question", "").strip()

    # NEW dual-engine shape. The frontend can send either:
    #   { stockfish: {...}, lc0: {...} }  OR (legacy)
    #   { evalBefore, evalAfter, bestMoveSan, bestLine, engineDepth }
    stockfish = payload.get("stockfish")
    lc0 = payload.get("lc0")

    # Legacy fallback — bundle the flat fields into a stockfish dict.
    if stockfish is None and lc0 is None and any(
        k in payload for k in ("evalBefore", "evalAfter", "bestMoveSan", "bestLine")
    ):
        stockfish = {
            "evalBefore": payload.get("evalBefore"),
            "evalAfter":  payload.get("evalAfter"),
            "bestMoveSan": payload.get("bestMoveSan"),
            "bestLine":    payload.get("bestLine"),
            "depth":       payload.get("engineDepth"),
        }

    lines: list[str] = []
    lines.append("=== GAME (PGN so far) ===")
    lines.append(pgn or "(no moves yet)")
    lines.append("")
    lines.append("=== CURRENT POSITION ===")
    lines.append(f"FEN: {fen}")
    lines.append(f"Side to move: {side_to_move}")
    if move_number is not None:
        lines.append(f"Move number: {move_number}")

    if last_move_san:
        lines.append("")
        lines.append("=== MOVE IN QUESTION ===")
        who = last_move_by or "the player"
        lines.append(f"{who.capitalize()} just played: {last_move_san}")

    if stockfish or lc0:
        lines.append("")
        if stockfish and lc0:
            lines.append("=== ENGINE ANALYSIS (Stockfish 18 + Lc0) ===")
        elif stockfish:
            lines.append("=== ENGINE ANALYSIS (Stockfish 18) ===")
        else:
            lines.append("=== ENGINE ANALYSIS (Lc0) ===")
        if stockfish:
            lines.extend(_engine_section("Stockfish 18", stockfish, last_move_san))
        if stockfish and lc0:
            lines.append("")
        if lc0:
            lines.extend(_engine_section("Lc0", lc0, last_move_san))
        if stockfish and lc0:
            # Hand the model an explicit "do they agree?" hint.
            sf_best = stockfish.get("bestMoveSan")
            lc_best = lc0.get("bestMoveSan")
            if sf_best and lc_best:
                lines.append("")
                if sf_best == lc_best:
                    lines.append(f"Both engines agree the best move is {sf_best}.")
                else:
                    lines.append(
                        f"The engines DISAGREE on the best move: "
                        f"Stockfish prefers {sf_best}, Lc0 prefers {lc_best}. "
                        f"Treat the disagreement as the most interesting teaching point."
                    )

    lines.append("")
    lines.append("=== PLAYER'S QUESTION ===")
    lines.append(question or "(no specific question — give general coaching feedback on this move)")

    return "\n".join(lines)


@app.route("/api/coach", methods=["POST"])
def coach():
    if not client:
        return jsonify({"error": "ANTHROPIC_API_KEY is not set on the server."}), 500

    try:
        payload = request.get_json(force=True) or {}
    except Exception as e:
        return jsonify({"error": f"Invalid JSON: {e}"}), 400

    if not payload.get("fen"):
        return jsonify({"error": "Missing 'fen' in request body."}), 400

    user_message = _build_coach_user_message(payload)

    try:
        resp = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=900,
            system=COACH_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
        )
        text = "".join(
            block.text for block in resp.content if getattr(block, "type", "") == "text"
        ).strip()
        return jsonify({
            "reply": text,
            "model": CLAUDE_MODEL,
            "usage": {
                "input_tokens": getattr(resp.usage, "input_tokens", None),
                "output_tokens": getattr(resp.usage, "output_tokens", None),
            },
        })
    except Exception as e:
        return jsonify({"error": f"Anthropic API error: {e}"}), 502


# --- Main -------------------------------------------------------------------

if __name__ == "__main__":
    ensure_stockfish()
    ensure_pieces()
    print(f"\n  Chess Coach running at http://{HOST}:{PORT}\n")
    app.run(host=HOST, port=PORT, debug=False)
