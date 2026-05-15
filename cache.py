"""
Local SQLite-backed analysis cache.

Engine analyses (both Stockfish in the browser and Lc0 server-side) are
keyed by (engine, FEN, limit_type, limit_value, multipv) and cached as
JSON blobs. Hitting an already-analyzed position is essentially free,
which makes scrubbing back through a game or revisiting old games much
faster.

FEN normalization: we strip the halfmove clock and fullmove number
(fields 5-6) because they don't affect the position the engine evaluates.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from typing import Optional


_DEFAULT_PATH = Path(__file__).parent / "analysis_cache.db"


class AnalysisCache:
    """Thread-safe SQLite cache. One row per (engine, position, limit, multipv)."""

    def __init__(self, db_path: Path = _DEFAULT_PATH):
        self.db_path = db_path
        self._lock = threading.Lock()
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        # autocommit=None puts SQLite in autocommit; we use explicit transactions
        # where needed. check_same_thread=False because we share the lock instead.
        return sqlite3.connect(str(self.db_path), check_same_thread=False)

    def _init_db(self) -> None:
        with self._lock:
            con = self._connect()
            try:
                con.execute("""
                    CREATE TABLE IF NOT EXISTS analysis (
                        engine       TEXT NOT NULL,
                        fen_norm     TEXT NOT NULL,
                        limit_type   TEXT NOT NULL,   -- 'depth' | 'movetime' | 'nodes'
                        limit_value  INTEGER NOT NULL,
                        multipv      INTEGER NOT NULL,
                        result_json  TEXT NOT NULL,
                        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (engine, fen_norm, limit_type, limit_value, multipv)
                    )
                """)
                con.execute("CREATE INDEX IF NOT EXISTS idx_engine_fen ON analysis (engine, fen_norm)")
                con.commit()
            finally:
                con.close()

    @staticmethod
    def normalize_fen(fen: str) -> str:
        """Drop the halfmove clock and fullmove number — they don't affect
        the position the engine analyzes."""
        parts = fen.strip().split()
        if len(parts) < 4:
            return fen.strip()
        return " ".join(parts[:4])

    def get(
        self,
        engine: str,
        fen: str,
        limit_type: str,
        limit_value: int,
        multipv: int,
    ) -> Optional[dict]:
        """Return a cached analysis result, or None on miss.

        Also returns cache hits for stronger analyses than requested:
        if the cache has the same position at the same engine/multipv but
        with a DEEPER depth (or longer movetime), we return that — a deeper
        analysis subsumes a shallower one.
        """
        fen_norm = self.normalize_fen(fen)
        with self._lock:
            con = self._connect()
            try:
                # Prefer an analysis that meets-or-exceeds the requested limit.
                row = con.execute(
                    """
                    SELECT result_json FROM analysis
                    WHERE engine = ? AND fen_norm = ? AND limit_type = ?
                          AND multipv >= ? AND limit_value >= ?
                    ORDER BY limit_value DESC, multipv DESC
                    LIMIT 1
                    """,
                    (engine, fen_norm, limit_type, multipv, limit_value),
                ).fetchone()
            finally:
                con.close()
        if row is None:
            return None
        try:
            return json.loads(row[0])
        except Exception:
            return None

    def put(
        self,
        engine: str,
        fen: str,
        limit_type: str,
        limit_value: int,
        multipv: int,
        result: dict,
    ) -> None:
        fen_norm = self.normalize_fen(fen)
        payload = json.dumps(result)
        with self._lock:
            con = self._connect()
            try:
                con.execute(
                    """
                    INSERT INTO analysis
                        (engine, fen_norm, limit_type, limit_value, multipv, result_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (engine, fen_norm, limit_type, limit_value, multipv)
                    DO UPDATE SET result_json = excluded.result_json,
                                  created_at  = CURRENT_TIMESTAMP
                    """,
                    (engine, fen_norm, limit_type, limit_value, multipv, payload),
                )
                con.commit()
            finally:
                con.close()

    def stats(self) -> dict:
        with self._lock:
            con = self._connect()
            try:
                total = con.execute("SELECT COUNT(*) FROM analysis").fetchone()[0]
                per_engine = dict(
                    con.execute(
                        "SELECT engine, COUNT(*) FROM analysis GROUP BY engine"
                    ).fetchall()
                )
            finally:
                con.close()
        return {"total": total, "per_engine": per_engine}

    def clear(self, engine: Optional[str] = None) -> int:
        """Drop all cache rows (or all for a specific engine). Returns rows removed."""
        with self._lock:
            con = self._connect()
            try:
                if engine:
                    cur = con.execute("DELETE FROM analysis WHERE engine = ?", (engine,))
                else:
                    cur = con.execute("DELETE FROM analysis")
                con.commit()
                return cur.rowcount or 0
            finally:
                con.close()
