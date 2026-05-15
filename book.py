"""
Book moves — a separate SQLite-backed store for opening-theory recommendations.

Distinct from `library.py` (which tags games with openings by FEN) and from
`cache.py` (which stores engine results). This module persists curated
"what to play here" recommendations sourced from Chessable / PGN / manual.

Schema
------
book_lines    one row per named line/course/study
book_moves    one row per move node in a line — possibly branching via
              parent_id, with normalized fen_before so we can answer
              "what does my book say here?" with a single indexed query.

The killer feature is FEN-based lookup: transpositions just work. Whether
the user reaches a Najdorf via 1.e4 c5 or via 1.Nf3 c5 2.e4, the same
fen_before row matches and the book move surfaces.

FEN normalization matches `cache.py` and `library.py` (drop halfmove clock
+ fullmove number) so all three systems agree on what "same position" means.
"""

from __future__ import annotations

import io
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

import chess
import chess.pgn

_DEFAULT_PATH = Path(__file__).parent / "book.db"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _normalize_fen(fen: str) -> str:
    parts = fen.strip().split()
    if len(parts) < 4:
        return fen.strip()
    return " ".join(parts[:4])


class Book:
    """Thread-safe SQLite store of book lines + moves."""

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
                    CREATE TABLE IF NOT EXISTS book_lines (
                        id          INTEGER PRIMARY KEY AUTOINCREMENT,
                        name        TEXT NOT NULL,
                        color       TEXT,            -- 'w' | 'b' | NULL (both)
                        source      TEXT NOT NULL DEFAULT 'manual',
                                                      -- 'chessable' | 'screenshot' | 'pgn' | 'manual'
                        source_url  TEXT,
                        notes       TEXT,
                        created_at  TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_book_lines_name ON book_lines(name);

                    CREATE TABLE IF NOT EXISTS book_moves (
                        id          INTEGER PRIMARY KEY AUTOINCREMENT,
                        line_id     INTEGER NOT NULL REFERENCES book_lines(id) ON DELETE CASCADE,
                        parent_id   INTEGER REFERENCES book_moves(id) ON DELETE CASCADE,
                        ply         INTEGER NOT NULL,        -- 1-indexed from line root
                        fen_before  TEXT NOT NULL,           -- normalized FEN BEFORE the move
                        fen_after   TEXT NOT NULL,           -- normalized FEN AFTER the move
                        san         TEXT NOT NULL,
                        uci         TEXT NOT NULL,
                        comment     TEXT,
                        nag         TEXT,                    -- '!', '?', '!!', '??', '!?', '?!', etc.
                        is_mainline INTEGER NOT NULL DEFAULT 1
                    );
                    -- The hot index for the "what does my book say here?" query.
                    CREATE INDEX IF NOT EXISTS idx_book_moves_fen_before ON book_moves(fen_before);
                    CREATE INDEX IF NOT EXISTS idx_book_moves_line       ON book_moves(line_id, parent_id);
                    """
                )
                con.commit()
            finally:
                con.close()

    # ------------------------------------------------------------------ lines

    def list_lines(self) -> list[dict]:
        with self._lock:
            con = self._connect()
            try:
                rows = con.execute(
                    """
                    SELECT l.id, l.name, l.color, l.source, l.source_url, l.notes,
                           l.created_at, COUNT(m.id) AS move_count
                    FROM book_lines l
                    LEFT JOIN book_moves m ON m.line_id = l.id
                    GROUP BY l.id
                    ORDER BY l.name COLLATE NOCASE
                    """
                ).fetchall()
            finally:
                con.close()
        return [dict(r) for r in rows]

    def get_line(self, line_id: int) -> Optional[dict]:
        """Return the line metadata + all its moves (flat list, ordered by ply
        then id). Caller can rebuild the tree via parent_id if needed."""
        with self._lock:
            con = self._connect()
            try:
                line_row = con.execute(
                    "SELECT * FROM book_lines WHERE id = ?", (line_id,)
                ).fetchone()
                if not line_row:
                    return None
                move_rows = con.execute(
                    """
                    SELECT id, parent_id, ply, fen_before, fen_after,
                           san, uci, comment, nag, is_mainline
                    FROM book_moves
                    WHERE line_id = ?
                    ORDER BY ply, id
                    """,
                    (line_id,),
                ).fetchall()
            finally:
                con.close()
        return {
            **dict(line_row),
            "moves": [dict(r) for r in move_rows],
        }

    def delete_line(self, line_id: int) -> bool:
        with self._lock:
            con = self._connect()
            try:
                cur = con.execute("DELETE FROM book_lines WHERE id = ?", (line_id,))
                con.commit()
                return (cur.rowcount or 0) > 0
            finally:
                con.close()

    # ------------------------------------------------------------------ create

    def create_line_from_pgn(
        self,
        name: str,
        pgn_text: str,
        color: Optional[str] = None,
        source: str = "pgn",
        source_url: Optional[str] = None,
        notes: Optional[str] = None,
        include_variations: bool = True,
    ) -> dict:
        """Create a line by parsing a PGN. Handles branches: every PGN variation
        becomes a sub-branch via parent_id, so reaching the same position via
        any path matches via fen_before lookup.

        Pass `include_variations=False` to only ingest the PGN mainline."""
        name = (name or "").strip()
        if not name:
            raise ValueError("Line name is required.")
        if not pgn_text or not pgn_text.strip():
            raise ValueError("Empty PGN.")

        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is None:
            raise ValueError("Could not parse PGN.")

        # Collect nodes via DFS, recording parent linkage so we can reproduce
        # the tree shape in the DB. We resolve fen_before from the parent node's
        # post-move board state.
        # Each entry: (parent_db_idx, ply, board_before, move, comment, nag, is_mainline)
        entries: list[tuple[Optional[int], int, "chess.Board", chess.Move, str, str, int]] = []

        def walk(node: chess.pgn.GameNode, parent_db_idx: Optional[int], ply: int, parent_is_mainline: bool) -> None:
            children = list(node.variations)
            for i, child in enumerate(children):
                # In python-chess, variations[0] of a node is its "mainline
                # continuation". A child is on the mainline of the whole line
                # only if every ancestor was also the 0th variation.
                child_is_mainline = parent_is_mainline and (i == 0)
                if i > 0 and not include_variations:
                    continue
                # NAG → glyph (subset of common ones; full table is large).
                nag = ""
                if child.nags:
                    nag_map = {1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!"}
                    for n in child.nags:
                        if n in nag_map:
                            nag = nag_map[n]
                            break
                board_before = node.board()
                entries.append((
                    parent_db_idx,
                    ply,
                    board_before,
                    child.move,
                    (child.comment or "").strip(),
                    nag,
                    1 if child_is_mainline else 0,
                ))
                # The DB index of THIS child won't be known until insert; pass
                # the position in `entries` so we can resolve it later.
                this_idx = len(entries) - 1
                walk(child, this_idx, ply + 1, child_is_mainline)

        walk(game, parent_db_idx=None, ply=1, parent_is_mainline=True)
        if not entries:
            raise ValueError("PGN contains no moves.")

        created_at = _now_iso()
        # Insert under lock; resolve parent_db_idx → actual DB id as we go.
        with self._lock:
            con = self._connect()
            try:
                cur = con.execute(
                    """
                    INSERT INTO book_lines (name, color, source, source_url, notes, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (name, color, source, source_url, notes, created_at),
                )
                line_id = cur.lastrowid
                # entry_idx → DB id, for parent resolution.
                idx_to_db_id: dict[int, int] = {}
                for idx, (parent_idx, ply, board_before, move, comment, nag, is_main) in enumerate(entries):
                    fen_before = _normalize_fen(board_before.fen())
                    # Compute fen_after by playing the move on a fresh copy of
                    # board_before — node.board() already gave us the pre-move
                    # state, so we don't want to mutate it.
                    board_after = board_before.copy(stack=False)
                    try:
                        san = board_after.san(move)
                    except Exception as e:
                        raise ValueError(
                            f"Move at ply {ply} is not legal in its position: {e}"
                        ) from e
                    board_after.push(move)
                    fen_after = _normalize_fen(board_after.fen())
                    parent_db = idx_to_db_id[parent_idx] if parent_idx is not None else None
                    cur = con.execute(
                        """
                        INSERT INTO book_moves
                            (line_id, parent_id, ply, fen_before, fen_after,
                             san, uci, comment, nag, is_mainline)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            line_id, parent_db, ply, fen_before, fen_after,
                            san, move.uci(), comment or None, nag or None, is_main,
                        ),
                    )
                    idx_to_db_id[idx] = cur.lastrowid
                con.commit()
            finally:
                con.close()
        return {"id": line_id, "name": name, "move_count": len(entries)}

    def create_line_from_sans(
        self,
        name: str,
        san_moves: list[str],
        color: Optional[str] = None,
        source: str = "manual",
        source_url: Optional[str] = None,
        notes: Optional[str] = None,
        comments: Optional[list[Optional[str]]] = None,
        nags: Optional[list[Optional[str]]] = None,
        starting_fen: Optional[str] = None,
    ) -> dict:
        """Create a linear (no branches) line from a list of SAN moves.
        Each move can have an optional comment and NAG glyph at the same
        index in `comments` / `nags`. Pass `starting_fen` to root the line
        somewhere other than the standard initial position (useful when
        ingesting from a Chessable screenshot that starts mid-game)."""
        name = (name or "").strip()
        if not name:
            raise ValueError("Line name is required.")
        if not san_moves:
            raise ValueError("At least one move is required.")

        board = chess.Board(starting_fen) if starting_fen else chess.Board()
        # Validate & resolve moves up front so we don't half-insert on error.
        prepared: list[tuple[int, str, str, str, str, str, str]] = []  # (ply, fen_before, fen_after, san_normalized, uci, comment, nag)
        for i, san in enumerate(san_moves):
            try:
                move = board.parse_san(san)
            except ValueError as exc:
                raise ValueError(f"Move {i + 1} ({san!r}) is not legal: {exc}") from exc
            fen_before = _normalize_fen(board.fen())
            san_norm = board.san(move)
            uci = move.uci()
            board.push(move)
            fen_after = _normalize_fen(board.fen())
            cmt = (comments[i] if comments and i < len(comments) else None) or ""
            ng  = (nags[i]     if nags     and i < len(nags)     else None) or ""
            prepared.append((i + 1, fen_before, fen_after, san_norm, uci, cmt, ng))

        created_at = _now_iso()
        with self._lock:
            con = self._connect()
            try:
                cur = con.execute(
                    """
                    INSERT INTO book_lines (name, color, source, source_url, notes, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (name, color, source, source_url, notes, created_at),
                )
                line_id = cur.lastrowid
                prev_id: Optional[int] = None
                for ply, fen_before, fen_after, san, uci, cmt, ng in prepared:
                    cur = con.execute(
                        """
                        INSERT INTO book_moves
                            (line_id, parent_id, ply, fen_before, fen_after,
                             san, uci, comment, nag, is_mainline)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                        """,
                        (
                            line_id, prev_id, ply, fen_before, fen_after,
                            san, uci, cmt or None, ng or None,
                        ),
                    )
                    prev_id = cur.lastrowid
                con.commit()
            finally:
                con.close()
        return {"id": line_id, "name": name, "move_count": len(prepared)}

    # ------------------------------------------------------------------ append

    def append_move(
        self,
        line_id: int,
        san: str,
        parent_move_id: Optional[int] = None,
        comment: Optional[str] = None,
        nag: Optional[str] = None,
    ) -> dict:
        """Append a single SAN move to a line, either as a child of an
        existing node (parent_move_id) or as the next move on the line root.
        Returns the inserted move row.

        Validates legality by replaying the line up to the parent node and
        re-deriving fen_before/fen_after, so callers can't insert garbage."""
        with self._lock:
            con = self._connect()
            try:
                line_row = con.execute(
                    "SELECT id FROM book_lines WHERE id = ?", (line_id,)
                ).fetchone()
                if not line_row:
                    raise ValueError(f"Line {line_id} not found.")

                if parent_move_id is None:
                    # New move at root of line (ply 1).
                    parent_fen_after = None
                    parent_ply = 0
                    parent_db = None
                else:
                    p = con.execute(
                        "SELECT fen_after, ply FROM book_moves WHERE id = ? AND line_id = ?",
                        (parent_move_id, line_id),
                    ).fetchone()
                    if not p:
                        raise ValueError(f"Parent move {parent_move_id} not found in line {line_id}.")
                    parent_fen_after = p["fen_after"]
                    parent_ply = p["ply"]
                    parent_db = parent_move_id

                # Reconstruct the board at the parent's fen_after. The FEN
                # we stored is normalized (no halfmove/fullmove counters);
                # python-chess accepts it and just sets those to 0/1.
                board = chess.Board(parent_fen_after) if parent_fen_after else chess.Board()
                try:
                    move = board.parse_san(san)
                except ValueError as exc:
                    raise ValueError(f"Move {san!r} is not legal here: {exc}") from exc
                fen_before = _normalize_fen(board.fen())
                san_norm = board.san(move)
                uci = move.uci()
                board.push(move)
                fen_after = _normalize_fen(board.fen())

                # Sibling check: an identical move at the same parent already
                # exists → don't duplicate, return the existing row.
                existing = con.execute(
                    """
                    SELECT id FROM book_moves
                    WHERE line_id = ? AND COALESCE(parent_id, -1) = COALESCE(?, -1)
                      AND uci = ?
                    """,
                    (line_id, parent_db, uci),
                ).fetchone()
                if existing:
                    row = con.execute(
                        "SELECT * FROM book_moves WHERE id = ?", (existing["id"],)
                    ).fetchone()
                    return dict(row)

                # First sibling at this parent is mainline; subsequent are not.
                sibling_count = con.execute(
                    """
                    SELECT COUNT(*) FROM book_moves
                    WHERE line_id = ? AND COALESCE(parent_id, -1) = COALESCE(?, -1)
                    """,
                    (line_id, parent_db),
                ).fetchone()[0]
                is_mainline = 1 if sibling_count == 0 else 0

                cur = con.execute(
                    """
                    INSERT INTO book_moves
                        (line_id, parent_id, ply, fen_before, fen_after,
                         san, uci, comment, nag, is_mainline)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        line_id, parent_db, parent_ply + 1, fen_before, fen_after,
                        san_norm, uci, (comment or None), (nag or None), is_mainline,
                    ),
                )
                new_id = cur.lastrowid
                con.commit()
                row = con.execute(
                    "SELECT * FROM book_moves WHERE id = ?", (new_id,)
                ).fetchone()
                return dict(row)
            finally:
                con.close()

    # ------------------------------------------------------------------ lookup

    def lookup(self, fen: str) -> list[dict]:
        """Return all book moves recommended at the given position, across
        all lines. Each result is a flat dict with the move + its line's
        name/color so the frontend can render a chip per recommendation.
        Deduped by (line_id, uci) — the same line shouldn't suggest the
        same move twice at the same FEN, but if a position recurs in
        multiple branches we collapse to one row per line."""
        fen_norm = _normalize_fen(fen)
        with self._lock:
            con = self._connect()
            try:
                rows = con.execute(
                    """
                    SELECT
                        m.id, m.line_id, m.parent_id, m.ply,
                        m.san, m.uci, m.comment, m.nag, m.is_mainline,
                        m.fen_before, m.fen_after,
                        l.name AS line_name, l.color AS line_color,
                        l.source AS line_source, l.source_url AS line_source_url
                    FROM book_moves m
                    JOIN book_lines l ON l.id = m.line_id
                    WHERE m.fen_before = ?
                    ORDER BY m.is_mainline DESC, l.name COLLATE NOCASE, m.ply
                    """,
                    (fen_norm,),
                ).fetchall()
            finally:
                con.close()
        # Dedupe: keep the first (mainline-preferred) row per (line_id, uci).
        seen: set[tuple[int, str]] = set()
        out: list[dict] = []
        for r in rows:
            key = (r["line_id"], r["uci"])
            if key in seen:
                continue
            seen.add(key)
            out.append(dict(r))
        return out

    def lookup_batch(self, fens: Iterable[str]) -> dict[str, list[dict]]:
        """Bulk lookup. Returns { fen_norm: [moves...] }. The frontend uses
        this when prefetching book info for every move of a loaded game."""
        # Run as a single SQL query for efficiency.
        fens_norm = list({_normalize_fen(f) for f in fens if f})
        if not fens_norm:
            return {}
        placeholders = ",".join("?" * len(fens_norm))
        with self._lock:
            con = self._connect()
            try:
                rows = con.execute(
                    f"""
                    SELECT
                        m.id, m.line_id, m.parent_id, m.ply,
                        m.san, m.uci, m.comment, m.nag, m.is_mainline,
                        m.fen_before, m.fen_after,
                        l.name AS line_name, l.color AS line_color,
                        l.source AS line_source, l.source_url AS line_source_url
                    FROM book_moves m
                    JOIN book_lines l ON l.id = m.line_id
                    WHERE m.fen_before IN ({placeholders})
                    ORDER BY m.is_mainline DESC, l.name COLLATE NOCASE, m.ply
                    """,
                    fens_norm,
                ).fetchall()
            finally:
                con.close()
        out: dict[str, list[dict]] = {f: [] for f in fens_norm}
        seen: set[tuple[str, int, str]] = set()
        for r in rows:
            key = (r["fen_before"], r["line_id"], r["uci"])
            if key in seen:
                continue
            seen.add(key)
            out[r["fen_before"]].append(dict(r))
        return out

    # ------------------------------------------------------------------ stats

    def stats(self) -> dict:
        with self._lock:
            con = self._connect()
            try:
                lines = con.execute("SELECT COUNT(*) FROM book_lines").fetchone()[0]
                moves = con.execute("SELECT COUNT(*) FROM book_moves").fetchone()[0]
                positions = con.execute(
                    "SELECT COUNT(DISTINCT fen_before) FROM book_moves"
                ).fetchone()[0]
            finally:
                con.close()
        return {"lines": lines, "moves": moves, "positions": positions}
