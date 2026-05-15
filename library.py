"""
Local SQLite-backed library: openings + games.

Distinct from analysis_cache (cache.py) — that one stores transient engine
results keyed by position. This one stores curated user data: openings the
user has registered, and PGNs they've imported. Auto-saves every imported
PGN and tags it with the longest matching opening (matched by FEN, so
transpositions resolve naturally — playing 1.Nf3 e5 2.e4 finds your
"Italian-like" opening just as 1.e4 e5 2.Nf3 would).

Schema:
  openings(id, name UNIQUE, moves_uci, target_fen, move_count, created_at)
    - target_fen is the normalized FEN AFTER the defining move sequence;
      this is the position we match games against.
  games(id, pgn, pgn_hash UNIQUE, ...metadata..., opening_id, opening_match_depth)
    - opening_id is the deepest registered opening whose target_fen
      appears in this game's mainline.
"""

from __future__ import annotations

import hashlib
import io
import re
import sqlite3
import threading
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import chess
import chess.pgn

LICHESS_API_BASE = "https://lichess.org/api"

# Lichess game IDs are 8 alphanumeric chars. The export endpoint accepts
# the 8-char prefix even if the user pastes a longer URL with /black or
# move-anchor suffixes.
_LICHESS_GAME_ID_RE = re.compile(
    r"lichess\.org/(?:embed/)?(?:training/)?([a-zA-Z0-9]{8})"
)


def _extract_lichess_game_id(s: str) -> Optional[str]:
    """Pull an 8-char Lichess game ID out of a URL or plain ID string."""
    if not s:
        return None
    s = s.strip()
    m = _LICHESS_GAME_ID_RE.search(s)
    if m:
        return m.group(1)
    if re.fullmatch(r"[a-zA-Z0-9]{8,12}", s):
        return s[:8]
    return None


_DEFAULT_PATH = Path(__file__).parent / "library.db"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _fetch_lichess_games_text(
    username: str,
    max_games: int,
    rated: Optional[bool] = None,
    perf_type: Optional[str] = None,
    color: Optional[str] = None,
) -> str:
    """Stream a user's games from the Lichess API as raw PGN text.
    See https://lichess.org/api#tag/Games/operation/apiGamesUser.
    Anonymous; no token needed for public games."""
    params: dict[str, str] = {
        "max": str(max_games),
        "pgnInJson": "false",
        "moves": "true",
        "tags": "true",
        "clocks": "false",
        "evals": "false",
        "opening": "false",  # we run our own detection
        "literate": "false",
        "sort": "dateDesc",
    }
    if rated is not None:
        params["rated"] = "true" if rated else "false"
    if perf_type:
        params["perfType"] = perf_type
    if color:
        params["color"] = color  # "white" | "black"
    url = (
        f"{LICHESS_API_BASE}/games/user/"
        f"{urllib.parse.quote(username, safe='')}"
        f"?{urllib.parse.urlencode(params)}"
    )
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/x-chess-pgn",
            "User-Agent": "Chess-Coach-Local/1.0 (+local app)",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _split_pgn_stream(text: str) -> list[str]:
    """Split a multi-game PGN stream into individual game PGN strings.
    Lichess returns games as PGN blocks separated by blank lines. We
    split on the start of a new `[Event ` tag so the original text is
    preserved verbatim (no python-chess re-emission that could change
    tag formatting)."""
    games: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if line.startswith("[Event ") and current:
            chunk = "\n".join(current).strip()
            if chunk:
                games.append(chunk)
            current = [line]
        else:
            current.append(line)
    if current:
        chunk = "\n".join(current).strip()
        if chunk:
            games.append(chunk)
    return games


def _normalize_fen(fen: str) -> str:
    """Drop the halfmove clock and fullmove number — they don't affect the
    POSITION, only the move-count metadata. Same canonicalization as the
    analysis cache uses, so opening FENs match cache FENs."""
    parts = fen.strip().split()
    if len(parts) < 4:
        return fen.strip()
    return " ".join(parts[:4])


class Library:
    """Thread-safe SQLite-backed library of openings + games."""

    def __init__(self, db_path: Path = _DEFAULT_PATH):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.db_path), check_same_thread=False)
        con.execute("PRAGMA foreign_keys = ON")
        con.row_factory = sqlite3.Row
        return con

    def _init_db(self) -> None:
        with self._lock:
            con = self._connect()
            try:
                con.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS openings (
                        id          INTEGER PRIMARY KEY AUTOINCREMENT,
                        name        TEXT NOT NULL UNIQUE,
                        moves_uci   TEXT NOT NULL,
                        target_fen  TEXT NOT NULL,
                        move_count  INTEGER NOT NULL,
                        created_at  TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_openings_fen ON openings(target_fen);

                    CREATE TABLE IF NOT EXISTS games (
                        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                        pgn                  TEXT NOT NULL,
                        pgn_hash             TEXT NOT NULL UNIQUE,
                        move_count           INTEGER NOT NULL,
                        white_name           TEXT,
                        black_name           TEXT,
                        result               TEXT,
                        played_date          TEXT,
                        opening_id           INTEGER REFERENCES openings(id) ON DELETE SET NULL,
                        opening_match_depth  INTEGER NOT NULL DEFAULT 0,
                        source               TEXT NOT NULL DEFAULT 'import',
                        user_color           TEXT,
                        created_at           TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_games_opening ON games(opening_id);
                    CREATE INDEX IF NOT EXISTS idx_games_created ON games(created_at DESC);
                    """
                )
                # Migration for existing library.db files that pre-date the
                # user_color column. Idempotent — only ALTERs when the column
                # doesn't already exist.
                cols = {
                    r[1] for r in con.execute("PRAGMA table_info(games)").fetchall()
                }
                if "user_color" not in cols:
                    con.execute("ALTER TABLE games ADD COLUMN user_color TEXT")
                con.commit()
            finally:
                con.close()

    # ------------------------------------------------------------------ openings

    def list_openings(self) -> list[dict]:
        with self._lock:
            con = self._connect()
            try:
                rows = con.execute(
                    """
                    SELECT o.id, o.name, o.moves_uci, o.target_fen, o.move_count,
                           o.created_at,
                           COUNT(g.id) AS game_count
                    FROM openings o
                    LEFT JOIN games g ON g.opening_id = o.id
                    GROUP BY o.id
                    ORDER BY o.name COLLATE NOCASE
                    """
                ).fetchall()
            finally:
                con.close()
        return [
            {
                "id": r["id"],
                "name": r["name"],
                "moves_uci": r["moves_uci"].split(),
                "target_fen": r["target_fen"],
                "move_count": r["move_count"],
                "game_count": r["game_count"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]

    def create_opening(self, name: str, san_moves: list[str]) -> dict:
        """Register an opening from a list of SAN moves. Re-scans every
        game in the library afterwards so existing games get tagged with
        this opening when it's deeper than their current match."""
        name = (name or "").strip()
        if not name:
            raise ValueError("Opening name is required.")
        if not san_moves:
            raise ValueError("At least one move is required.")

        board = chess.Board()
        uci_list: list[str] = []
        for i, san in enumerate(san_moves):
            try:
                move = board.parse_san(san)
            except ValueError as exc:
                raise ValueError(f"Move {i + 1} ({san!r}) is not legal: {exc}") from exc
            uci_list.append(move.uci())
            board.push(move)

        target_fen = _normalize_fen(board.fen())
        moves_uci_str = " ".join(uci_list)
        created_at = _now_iso()

        with self._lock:
            con = self._connect()
            try:
                try:
                    cur = con.execute(
                        """
                        INSERT INTO openings (name, moves_uci, target_fen, move_count, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        (name, moves_uci_str, target_fen, len(uci_list), created_at),
                    )
                except sqlite3.IntegrityError as exc:
                    raise ValueError(f"An opening named {name!r} already exists.") from exc
                opening_id = cur.lastrowid
                con.commit()
            finally:
                con.close()

        # Outside the lock: backfill existing games that match this opening.
        self._rescan_games_for_opening(opening_id, target_fen, len(uci_list))

        return {
            "id": opening_id,
            "name": name,
            "moves_uci": uci_list,
            "target_fen": target_fen,
            "move_count": len(uci_list),
            "game_count": 0,
            "created_at": created_at,
        }

    def delete_opening(self, opening_id: int) -> bool:
        with self._lock:
            con = self._connect()
            try:
                cur = con.execute("DELETE FROM openings WHERE id = ?", (opening_id,))
                # FK ON DELETE SET NULL handles games.opening_id; clear depth too.
                con.execute(
                    "UPDATE games SET opening_match_depth = 0 WHERE opening_id IS NULL"
                )
                con.commit()
                return (cur.rowcount or 0) > 0
            finally:
                con.close()

    def _rescan_games_for_opening(
        self, opening_id: int, target_fen: str, depth: int
    ) -> int:
        """For each existing game whose current match is shallower than
        `depth`, walk its mainline and check whether `target_fen` appears.
        If so, update the game's opening tag. Returns the number of games
        re-tagged."""
        # Snapshot the games to rescan (under lock) to avoid holding the
        # connection during PGN parsing.
        with self._lock:
            con = self._connect()
            try:
                rows = con.execute(
                    "SELECT id, pgn FROM games WHERE opening_match_depth < ?",
                    (depth,),
                ).fetchall()
            finally:
                con.close()

        updated_ids: list[int] = []
        for row in rows:
            try:
                game = chess.pgn.read_game(io.StringIO(row["pgn"]))
            except Exception:
                continue
            if game is None:
                continue
            board = game.board()
            for move in game.mainline_moves():
                try:
                    board.push(move)
                except Exception:
                    break
                if _normalize_fen(board.fen()) == target_fen:
                    updated_ids.append(row["id"])
                    break

        if not updated_ids:
            return 0
        with self._lock:
            con = self._connect()
            try:
                con.executemany(
                    "UPDATE games SET opening_id = ?, opening_match_depth = ? WHERE id = ?",
                    [(opening_id, depth, gid) for gid in updated_ids],
                )
                con.commit()
            finally:
                con.close()
        return len(updated_ids)

    # ------------------------------------------------------------------ games

    def list_games(
        self, limit: int = 1000, opening_id: Optional[int] = None
    ) -> list[dict]:
        # Cap at 5000 to keep the response from getting comically large; if
        # the user has more games than this we can add pagination later.
        limit = max(1, min(int(limit or 1000), 5000))
        with self._lock:
            con = self._connect()
            try:
                if opening_id is not None:
                    rows = con.execute(
                        """
                        SELECT g.id, g.white_name, g.black_name, g.result, g.played_date,
                               g.move_count, g.opening_id, o.name AS opening_name,
                               g.opening_match_depth, g.source, g.user_color, g.created_at
                        FROM games g
                        LEFT JOIN openings o ON o.id = g.opening_id
                        WHERE g.opening_id = ?
                        ORDER BY COALESCE(NULLIF(g.played_date, ''), g.created_at) DESC,
                                 g.created_at DESC
                        LIMIT ?
                        """,
                        (opening_id, limit),
                    ).fetchall()
                else:
                    rows = con.execute(
                        """
                        SELECT g.id, g.white_name, g.black_name, g.result, g.played_date,
                               g.move_count, g.opening_id, o.name AS opening_name,
                               g.opening_match_depth, g.source, g.user_color, g.created_at
                        FROM games g
                        LEFT JOIN openings o ON o.id = g.opening_id
                        ORDER BY COALESCE(NULLIF(g.played_date, ''), g.created_at) DESC,
                                 g.created_at DESC
                        LIMIT ?
                        """,
                        (limit,),
                    ).fetchall()
            finally:
                con.close()
        return [self._game_row_to_dict(r) for r in rows]

    def get_game(self, game_id: int) -> Optional[dict]:
        with self._lock:
            con = self._connect()
            try:
                row = con.execute(
                    """
                    SELECT g.id, g.pgn, g.white_name, g.black_name, g.result, g.played_date,
                           g.move_count, g.opening_id, o.name AS opening_name,
                           g.opening_match_depth, g.source, g.user_color, g.created_at
                    FROM games g
                    LEFT JOIN openings o ON o.id = g.opening_id
                    WHERE g.id = ?
                    """,
                    (game_id,),
                ).fetchone()
            finally:
                con.close()
        if not row:
            return None
        out = self._game_row_to_dict(row)
        out["pgn"] = row["pgn"]
        return out

    @staticmethod
    def _game_row_to_dict(row: sqlite3.Row) -> dict:
        opening = None
        if row["opening_id"] is not None:
            opening = {"id": row["opening_id"], "name": row["opening_name"]}
        # user_color may not be selected by older queries — guard with try.
        try:
            user_color = row["user_color"]
        except (IndexError, KeyError):
            user_color = None
        return {
            "id": row["id"],
            "white_name": row["white_name"] or "",
            "black_name": row["black_name"] or "",
            "result": row["result"] or "*",
            "played_date": row["played_date"] or "",
            "move_count": row["move_count"],
            "opening": opening,
            "opening_match_depth": row["opening_match_depth"],
            "source": row["source"],
            "user_color": user_color,
            "created_at": row["created_at"],
        }

    def save_game(self, pgn_text: str, source: str = "import") -> dict:
        """Parse PGN, detect opening (deepest FEN match), dedup by hash, insert.
        Returns dict with 'id', 'opening', 'opening_match_depth', and
        'was_duplicate' (True when the same PGN was already in the library —
        in that case we still re-run opening detection in case openings
        have been added/removed since the original save)."""
        if not pgn_text or not pgn_text.strip():
            raise ValueError("Empty PGN.")

        pgn_text = pgn_text.strip()
        pgn_hash = hashlib.sha256(pgn_text.encode("utf-8")).hexdigest()

        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is None:
            raise ValueError("Could not parse PGN.")
        headers = game.headers
        white = headers.get("White", "") or ""
        black = headers.get("Black", "") or ""
        result = headers.get("Result", "") or ""
        played = headers.get("Date", "") or ""

        board = game.board()
        ply_fens: list[str] = []
        for move in game.mainline_moves():
            try:
                board.push(move)
            except Exception:
                break
            ply_fens.append(_normalize_fen(board.fen()))
        move_count = len(ply_fens)

        opening_id, opening_depth = self._detect_opening(ply_fens)
        created_at = _now_iso()

        with self._lock:
            con = self._connect()
            try:
                existing = con.execute(
                    "SELECT id FROM games WHERE pgn_hash = ?", (pgn_hash,)
                ).fetchone()
                if existing:
                    con.execute(
                        """
                        UPDATE games
                           SET opening_id = ?, opening_match_depth = ?
                         WHERE id = ?
                        """,
                        (opening_id, opening_depth, existing["id"]),
                    )
                    con.commit()
                    game_id = existing["id"]
                    was_duplicate = True
                else:
                    cur = con.execute(
                        """
                        INSERT INTO games
                            (pgn, pgn_hash, move_count, white_name, black_name,
                             result, played_date, opening_id, opening_match_depth,
                             source, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            pgn_text, pgn_hash, move_count, white, black,
                            result, played, opening_id, opening_depth,
                            source, created_at,
                        ),
                    )
                    con.commit()
                    game_id = cur.lastrowid
                    was_duplicate = False
            finally:
                con.close()

        opening_dict = None
        if opening_id is not None:
            with self._lock:
                con = self._connect()
                try:
                    r = con.execute(
                        "SELECT name FROM openings WHERE id = ?", (opening_id,)
                    ).fetchone()
                finally:
                    con.close()
            if r:
                opening_dict = {"id": opening_id, "name": r["name"]}

        return {
            "id": game_id,
            "opening": opening_dict,
            "opening_match_depth": opening_depth,
            "was_duplicate": was_duplicate,
        }

    def _detect_opening(self, ply_fens: list[str]) -> tuple[Optional[int], int]:
        """Single pass: pull all openings into memory, then walk the game's
        per-ply normalized FENs and keep the deepest match. Returns
        (opening_id, match_depth). The starting position is intentionally
        skipped — matching openings of depth 0 would tag every game."""
        with self._lock:
            con = self._connect()
            try:
                rows = con.execute(
                    "SELECT id, target_fen, move_count FROM openings"
                ).fetchall()
            finally:
                con.close()
        if not rows:
            return None, 0
        fen_to_opening: dict[str, tuple[int, int]] = {
            r["target_fen"]: (r["id"], r["move_count"]) for r in rows
        }
        best_id: Optional[int] = None
        best_depth = 0
        for fen in ply_fens:
            hit = fen_to_opening.get(fen)
            if hit and hit[1] > best_depth:
                best_id, best_depth = hit[0], hit[1]
        return best_id, best_depth

    def delete_game(self, game_id: int) -> bool:
        with self._lock:
            con = self._connect()
            try:
                cur = con.execute("DELETE FROM games WHERE id = ?", (game_id,))
                con.commit()
                return (cur.rowcount or 0) > 0
            finally:
                con.close()

    # ------------------------------------------------------------------ lichess

    def import_from_lichess(
        self,
        username: str,
        max_games: int = 50,
        rated: Optional[bool] = None,
        perf_type: Optional[str] = None,
        color: Optional[str] = None,
    ) -> dict:
        """Fetch the user's games from Lichess and save each to the library.
        Sets user_color on imported games by matching `username` (case-
        insensitive) against the PGN's White/Black headers. Returns a
        counts dict {imported, duplicates, skipped, total}."""
        username = (username or "").strip()
        if not username:
            raise ValueError("Lichess username is required.")
        max_games = max(1, min(int(max_games or 50), 300))

        text = _fetch_lichess_games_text(
            username, max_games=max_games,
            rated=rated, perf_type=perf_type, color=color,
        )
        games_pgn = _split_pgn_stream(text)

        username_lower = username.lower()
        imported = 0
        duplicates = 0
        skipped = 0
        for pgn in games_pgn:
            try:
                result = self.save_game(pgn, source="lichess")
            except Exception:
                skipped += 1
                continue
            if result["was_duplicate"]:
                duplicates += 1
            else:
                imported += 1
            # Always (re)set user_color in case the game came in earlier
            # via PGN paste — Lichess import knows whose perspective this is.
            self._set_user_color_by_username(result["id"], username_lower)
        return {
            "imported": imported,
            "duplicates": duplicates,
            "skipped": skipped,
            "total": len(games_pgn),
        }

    def import_lichess_game(
        self, url_or_id: str, username: Optional[str] = None
    ) -> dict:
        """Import a single game by Lichess URL or game ID. Uses Lichess's
        `/game/export/{id}` endpoint which hits the game directly — works
        immediately after a game ends, unlike the user-archive endpoint
        which has indexing latency. If `username` is provided AND matches
        White or Black, we stamp user_color on the resulting row.

        Returns the same shape as save_game plus the game_id we resolved
        (so the frontend can confirm what it imported)."""
        game_id = _extract_lichess_game_id(url_or_id)
        if not game_id:
            raise ValueError(
                "Couldn't extract a Lichess game ID. Paste a URL like "
                "https://lichess.org/AbCdEfGh or just the 8-character ID."
            )
        url = f"https://lichess.org/game/export/{urllib.parse.quote(game_id)}"
        req = urllib.request.Request(
            url,
            headers={
                "Accept": "application/x-chess-pgn",
                "User-Agent": "Chess-Coach-Local/1.0 (+local app)",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            pgn = resp.read().decode("utf-8", errors="replace")
        if not pgn.strip():
            raise ValueError(f"Lichess returned an empty PGN for game {game_id}.")

        result = self.save_game(pgn, source="lichess")
        if username:
            self._set_user_color_by_username(result["id"], username.lower())
        result["game_id"] = game_id
        return result

    def _set_user_color_by_username(self, game_id: int, username_lower: str) -> None:
        with self._lock:
            con = self._connect()
            try:
                row = con.execute(
                    "SELECT white_name, black_name FROM games WHERE id = ?", (game_id,)
                ).fetchone()
                if not row:
                    return
                white = (row["white_name"] or "").lower()
                black = (row["black_name"] or "").lower()
                user_color: Optional[str] = None
                if white == username_lower:
                    user_color = "w"
                elif black == username_lower:
                    user_color = "b"
                if user_color:
                    con.execute(
                        "UPDATE games SET user_color = ? WHERE id = ?",
                        (user_color, game_id),
                    )
                    con.commit()
            finally:
                con.close()

    def stats(self) -> dict:
        with self._lock:
            con = self._connect()
            try:
                games = con.execute("SELECT COUNT(*) FROM games").fetchone()[0]
                openings = con.execute("SELECT COUNT(*) FROM openings").fetchone()[0]
                tagged = con.execute(
                    "SELECT COUNT(*) FROM games WHERE opening_id IS NOT NULL"
                ).fetchone()[0]
            finally:
                con.close()
        return {"games": games, "openings": openings, "tagged_games": tagged}
