"""
Lc0 (Leela Chess Zero) integration for Chess Coach.

Lc0 is run as a native subprocess via python-chess. The user is expected to
have installed it themselves (e.g. `brew install lc0` on macOS) and to have
a network weights file available — Lc0 won't start without one.

The Lc0Engine class owns a persistent subprocess. Analyses are serialized
under a lock because UCI engines are inherently single-tenant. The engine
process is started lazily on first use so the server boots fast even if
Lc0 isn't installed.
"""

from __future__ import annotations

import os
import shutil
import threading
from pathlib import Path
from typing import Optional

import chess
import chess.engine


# Default places to look for a weights file. The user can override with the
# LC0_NETWORK env var. We avoid auto-downloading networks because (a) they're
# big, (b) the "right" net depends on hardware, and (c) Lc0's own readme has
# the canonical list.
_DEFAULT_NETWORK_LOCATIONS = [
    "~/.local/share/lc0/weights.pb.gz",
    "~/Library/Application Support/lc0/weights.pb.gz",
    "/opt/homebrew/share/lc0/weights.pb.gz",
    "/usr/local/share/lc0/weights.pb.gz",
    "./weights.pb.gz",
    "./lc0_network.pb.gz",
]


def find_lc0_binary() -> Optional[str]:
    """Return the path to the lc0 binary, or None if not installed."""
    # Explicit override
    override = os.environ.get("LC0_BINARY")
    if override and Path(override).is_file() and os.access(override, os.X_OK):
        return override
    # PATH lookup (works for Homebrew on both Intel and Apple Silicon)
    return shutil.which("lc0")


def find_lc0_network() -> Optional[str]:
    """Return the path to a usable Lc0 network file, or None."""
    override = os.environ.get("LC0_NETWORK")
    if override:
        p = Path(os.path.expanduser(override))
        if p.is_file():
            return str(p)
        return None
    for loc in _DEFAULT_NETWORK_LOCATIONS:
        p = Path(os.path.expanduser(loc))
        if p.is_file():
            return str(p)
    return None


class Lc0Engine:
    """Lazy-started, thread-safe wrapper around a persistent Lc0 UCI process."""

    def __init__(self, binary: str, network: Optional[str]):
        self.binary = binary
        self.network = network
        self._engine: Optional[chess.engine.SimpleEngine] = None
        self._lock = threading.Lock()
        self.last_error: Optional[str] = None

    def _ensure_started(self) -> chess.engine.SimpleEngine:
        if self._engine is not None:
            return self._engine
        # Start lc0 with NO extra args — modern lc0 (0.32+) does not accept
        # `--weights PATH` as space-separated CLI tokens. The portable way to
        # configure the weights file is via the UCI option `WeightsFile`.
        # (We also let lc0 auto-select a backend, which picks Metal on Apple
        # Silicon and Eigen elsewhere.)
        try:
            self._engine = chess.engine.SimpleEngine.popen_uci([self.binary])
        except Exception as e:
            self.last_error = f"failed to start lc0: {e}"
            raise

        if self.network:
            try:
                self._engine.configure({"WeightsFile": self.network})
            except Exception as e:
                # If WeightsFile isn't a known UCI option on this build of lc0
                # (very unusual), surface a clear error rather than analyzing
                # with an unconfigured engine.
                self.last_error = (
                    f"failed to set WeightsFile via UCI: {e}. "
                    f"Try setting LC0_NETWORK to the absolute path of a valid "
                    f".pb.gz network, or place one at ~/.local/share/lc0/weights.pb.gz."
                )
                try:
                    self._engine.quit()
                finally:
                    self._engine = None
                raise
        self.last_error = None
        return self._engine

    def info(self) -> dict:
        return {
            "binary": self.binary,
            "network": self.network,
            "running": self._engine is not None,
            "last_error": self.last_error,
        }

    def analyze(
        self,
        fen: str,
        *,
        nodes: Optional[int] = None,
        movetime_ms: Optional[int] = None,
        depth: Optional[int] = None,
        multipv: int = 4,
    ) -> dict:
        """Analyze a FEN. Returns a dict shaped like the frontend's Stockfish
        result: { cp?, mate?, bestMove (UCI), pv: [uci...], depth, nodes,
                  candidates: [ {...same fields...} ] }.

        With multipv > 1 the result includes a `candidates` array of length up
        to `multipv`, sorted best-first. The top-level fields mirror
        candidates[0] for convenience.

        Eval values are from the side-to-move's perspective, matching what the
        in-browser Stockfish worker emits.
        """
        board = chess.Board(fen)
        if nodes is not None:
            limit = chess.engine.Limit(nodes=nodes)
        elif movetime_ms is not None:
            limit = chess.engine.Limit(time=movetime_ms / 1000.0)
        elif depth is not None:
            limit = chess.engine.Limit(depth=depth)
        else:
            limit = chess.engine.Limit(nodes=20000)

        with self._lock:
            eng = self._ensure_started()
            infos = eng.analyse(board, limit, multipv=multipv, info=chess.engine.INFO_ALL)

        if not isinstance(infos, list):
            infos = [infos]

        def info_to_cand(info: dict) -> dict:
            score = info.get("score")
            pv = info.get("pv") or []
            pv_uci = [m.uci() for m in pv]
            cand: dict = {
                "bestMove": pv_uci[0] if pv_uci else None,
                "pv": pv_uci,
                "depth": info.get("depth"),
                "nodes": info.get("nodes"),
            }
            if score is not None:
                pov = score.pov(board.turn)
                if pov.is_mate():
                    cand["mate"] = pov.mate()
                else:
                    cp = pov.score()
                    if cp is not None:
                        cand["cp"] = int(cp)
            return cand

        candidates = [info_to_cand(i) for i in infos]
        primary = candidates[0] if candidates else {}
        return {**primary, "candidates": candidates}

    def close(self) -> None:
        with self._lock:
            if self._engine is not None:
                try:
                    self._engine.quit()
                finally:
                    self._engine = None


def setup_lc0() -> tuple[Optional[Lc0Engine], dict]:
    """Detect lc0 + network and return (engine_or_None, status_dict).

    Never raises. If anything is missing, the status dict carries a helpful
    `reason` and `hint` that we surface via /healthz.
    """
    binary = find_lc0_binary()
    network = find_lc0_network()
    status: dict = {
        "binary": binary,
        "network": network,
        "available": False,
        "reason": None,
        "hint": None,
    }
    if not binary:
        status["reason"] = "lc0 binary not found"
        status["hint"] = (
            "Install Lc0 — on macOS run `brew install lc0`, then download a "
            "network weights file from https://lczero.org/play/networks/bestnets/ "
            "and save it to ~/.local/share/lc0/weights.pb.gz "
            "(or set LC0_NETWORK to its path)."
        )
        return None, status
    if not network:
        status["reason"] = "lc0 network weights file not found"
        status["hint"] = (
            "Download a network from https://lczero.org/play/networks/bestnets/ "
            "and save it to ~/.local/share/lc0/weights.pb.gz, "
            "or set LC0_NETWORK to its path."
        )
        return None, status
    status["available"] = True
    return Lc0Engine(binary=binary, network=network), status
