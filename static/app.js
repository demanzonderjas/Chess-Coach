/* Chess Coach — frontend app
 *
 * Responsibilities:
 *   1. Parse the pasted PGN with chess.js, build a list of positions.
 *   2. Render a chess board (chessboard.js) and let the user navigate moves.
 *   3. Drive a Stockfish Web Worker via the UCI protocol to evaluate positions.
 *   4. Classify each move (best / good / inaccuracy / mistake / blunder).
 *   5. Send the current move's context to the Flask /api/coach endpoint,
 *      which proxies the question to Claude for natural-language coaching.
 */

(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const els = {
    pgn: $("pgnInput"),
    load: $("loadBtn"),
    newGame: $("newGameBtn"),
    sample: $("loadSampleBtn"),
    analyzeAll: $("analyzeAllBtn"),
    depth: $("depthInput"),
    board: $("board"),
    navStart: $("navStart"),
    navPrev: $("navPrev"),
    navNext: $("navNext"),
    navEnd: $("navEnd"),
    flip: $("flipBtn"),
    status: $("engineStatus"),
    moveList: $("moveList"),
    curMove: $("curMove"),
    sideToMove: $("sideToMove"),
    classification: $("classification"),

    // Eval bar (top-of-board readout)
    evalNum: $("evalNum"),
    evalMeta: $("evalMeta"),
    evalBarFill: $("evalBarFill"),
    evalLoading: $("evalLoading"),

    // Move-info panels per engine
    sfBlock: $("sfBlock"),
    sfEvalText: $("sfEvalText"),
    sfEvalDepth: $("sfEvalDepth"),
    sfBestMove: $("sfBestMove"),
    sfBestLine: $("sfBestLine"),
    sfMoveLabel: $("sfMoveLabel"),
    sfLineLabel: $("sfLineLabel"),
    sfSacBadge: $("sfSacBadge"),
    sfAltBlock: $("sfAltBlock"),
    sfAltMove: $("sfAltMove"),
    sfAltEval: $("sfAltEval"),
    sfStatus: $("sfStatus"),
    lc0Block: $("lc0Block"),
    lc0EvalText: $("lc0EvalText"),
    lc0EvalDepth: $("lc0EvalDepth"),
    lc0BestMove: $("lc0BestMove"),
    lc0BestLine: $("lc0BestLine"),
    lc0MoveLabel: $("lc0MoveLabel"),
    lc0LineLabel: $("lc0LineLabel"),
    lc0SacBadge: $("lc0SacBadge"),
    lc0AltBlock: $("lc0AltBlock"),
    lc0AltMove: $("lc0AltMove"),
    lc0AltEval: $("lc0AltEval"),
    lc0Status: $("lc0Status"),
    sfCandidates: $("sfCandidates"),
    sfCandidatesRows: $("sfCandidatesRows"),
    lc0Candidates: $("lc0Candidates"),
    lc0CandidatesRows: $("lc0CandidatesRows"),
    creativeToggle: $("creativeMode"),
    creativeThreshold: $("creativeThreshold"),
    plansToggle: $("plansToggle"),
    plansPlies: $("plansPlies"),
    planArrows: $("planArrows"),
    boardArrowWrap: null, // set after board is built
    deepDive: $("deepDiveBtn"),
    chaosToggle: $("chaosMode"),
    chaosThreshold: $("chaosThreshold"),

    // Library panel
    libraryBtn: $("libraryBtn"),
    libraryPanel: $("libraryPanel"),
    libraryCloseBtn: $("libraryCloseBtn"),
    libraryGamesList: $("libraryGamesList"),
    libraryGamesEmpty: $("libraryGamesEmpty"),
    libraryOpeningsList: $("libraryOpeningsList"),
    libraryOpeningsEmpty: $("libraryOpeningsEmpty"),
    addOpeningToggle: $("addOpeningToggle"),
    addOpeningForm: $("addOpeningForm"),
    addOpeningCancel: $("addOpeningCancel"),
    newOpeningName: $("newOpeningName"),
    newOpeningMoves: $("newOpeningMoves"),
    addOpeningError: $("addOpeningError"),
    openingChipRow: $("openingChipRow"),
    openingChip: $("openingChip"),

    // Lichess import
    lichessImportToggle: $("lichessImportToggle"),
    lichessImportForm: $("lichessImportForm"),
    lichessImportCancel: $("lichessImportCancel"),
    lichessImportSubmit: $("lichessImportSubmit"),
    lichessImportStatus: $("lichessImportStatus"),
    lichessUsername: $("lichessUsername"),
    lichessMax: $("lichessMax"),
    lichessPerf: $("lichessPerf"),
    lichessRated: $("lichessRated"),
    lichessGameUrl: $("lichessGameUrl"),
    lichessImportGameSubmit: $("lichessImportGameSubmit"),

    // Engine selector
    engineOptLc0: $("engineOptLc0"),
    engineOptBoth: $("engineOptBoth"),

    // Variation banner
    variationBanner: $("variationBanner"),
    variationBannerText: $("variationBannerText"),
    exitVariationBtn: $("exitVariationBtn"),

    // Coach
    chat: $("chat"),
    suggestions: $("suggestions"),
    questionInput: $("questionInput"),
    ask: $("askBtn"),
    coachModel: $("coachModel"),

    // Eval chart
    evalChart: $("evalChart"),
    evalChartWrap: $("evalChartWrap"),
    evalChartTip: $("evalChartTip"),
  };

  // ---------- State ----------
  // analyses[i] is now an OBJECT keyed by engine: { sf?: result, lc0?: result }
  // loading[i] is a Set of engine names currently being analyzed at ply i.
  const STATE = {
    game: new Chess(),
    positions: [new Chess().fen()],
    moves: [],
    analyses: [{}],     // per-ply, per-engine results
    loading: [new Set()], // per-ply: set of "sf" | "lc0" currently in-flight
    ply: 0,
    orientation: "white",
    boardObj: null,
    engine: null,
    engineReady: false,
    // cancels[ply] = { sf?: cancelFn, lc0?: cancelFn } — handles for in-flight
    // analyses, used by goToPly to abort searches that are no longer relevant.
    cancels: [{}],
    engineMode: "stockfish",    // "stockfish" | "lc0" | "both"
    lc0Available: false,
    lc0Reason: null,
    // variation: when non-null, the board shows a variation rather than
    // the actual game position. Shape:
    //   { basePly, moves: [uci...], fenAfter, engine, source }
    // For user-source sidelines we additionally carry:
    //   currentPly      — display tip (0..moves.length; 0 = base position)
    //   tipAnalysis,    tipLoading,    tipCancel    — SF on the displayed FEN
    //   tipOppAnalysis, tipOppLoading, tipOppCancel — SF on the null-move FEN
    variation: null,
    // The user's sideline persists across "exit to main line" so they can
    // switch back and forth via the sideline row in the move list. When
    // STATE.variation is null we're showing the main game; when it's
    // non-null and === savedSideline we're viewing the sideline.
    savedSideline: null,
    // Creative mode: when on, prefer engine candidates that sacrifice
    // material (within `creativeThresholdCp` of top eval) as the displayed
    // primary line. Threshold is user-configurable via the loader bar.
    creativeMode: true,
    creativeThresholdCp: 90,
    // Plan-arrow overlay: when on, draw arrows on the board for the
    // side-to-move's planned line AND the opponent's planned line
    // (computed via a "null-move" FEN that swaps the side-to-move).
    showPlans: true,
    planPlies: 4,
    // Opponent-plan analyses run on the null-move-FEN. Parallel to
    // STATE.analyses / loading / cancels.
    opponentAnalyses: [{}],
    opponentLoading:  [new Set()],
    opponentCancels:  [{}],
    // Chaos mode: a more aggressive cousin of creative mode. Picks moves
    // that maximize OPPONENT DIFFICULTY (captures, checks, material
    // swings) within a wider eval tolerance — practical fighting chances
    // over objective evaluation. Requires MultiPV=12 to have enough
    // candidates to find a chaos-worthy non-top line.
    chaosMode: false,
    chaosThresholdCp: 150,
    // True after a PGN has been loaded — affects what happens on a manual
    // mid-game move. With PGN loaded: branch into a user sideline so the
    // PGN is preserved. Explorer mode (no PGN): truncate as before so the
    // user can freely revise their own position.
    pgnLoaded: false,
    // Background analyze-all queue. When the user clicks "Analyze All",
    // we populate this with all missing-analysis plies and chew through
    // it in the background. Navigation cancellations re-queue cancelled
    // plies at the END of the queue — so every ply eventually gets
    // analyzed regardless of how the user navigates.
    bgQueue: [],
    bgRunning: false,
    // Library: the currently loaded game's detected opening (if any) and
    // its game-row id, set by auto-save after loadPgn. Used to render
    // the "Opening: …" chip in the move-info panel.
    currentOpening: null,    // { id, name } or null
    currentLibraryGameId: null,
    // When true, the next loadPgn was triggered by re-opening a library
    // game — skip the auto-save round-trip so we don't end up POSTing
    // the same game we just GET'd.
    suppressNextAutoSave: false,
  };

  /** Side at the bottom of the board — the side the user is most likely
   *  playing (and the only side they can actually act on). Drives the
   *  user-side restriction for chaos/creative picks. */
  function userSide() { return STATE.orientation === "white" ? "w" : "b"; }
  function sideOfFen(fen) { return fen ? fen.split(" ")[1] : null; }

  /** Should chaos/creative picks apply to an analysis whose root FEN has
   *  this side-to-move? Only for user-side analyses — we're not trying to
   *  suggest off-top moves for the opponent (they'll play what they play).
   *  This restriction lets us drop MultiPV to 4 on opponent-side positions
   *  even when chaos is on, halving the search overhead. */
  function chaosAppliesTo(fen) {
    return STATE.chaosMode && sideOfFen(fen) === userSide();
  }

  /** MultiPV count to request from SF for a given FEN — wider only when
   *  chaos is on AND the side-to-move is the user's side. Anything else
   *  doesn't need the extra candidates. */
  function sfMultiPv(fen) { return chaosAppliesTo(fen) ? 12 : 4; }

  // --- Sideline / variation helpers --------------------------------------
  //
  // When a user-source variation is active, much of the rendering pipeline
  // should look at the sideline TIP's analysis instead of the current
  // ply's main-line analysis. These small helpers centralize that
  // routing so renderEngineBlock / renderPlanArrows / etc. don't have to
  // sprinkle in-sideline checks.

  /** True when the active variation is a user sideline. Engine variations
   *  (read-only PV previews) are not "user sidelines". */
  function inUserSideline() {
    return !!(STATE.variation && STATE.variation.source === "user");
  }

  /** The FEN the user is currently looking at — sideline tip or main ply. */
  function currentDisplayedFen() {
    return inUserSideline()
      ? STATE.variation.fenAfter
      : STATE.positions[STATE.ply];
  }

  /** Side-to-move of the currently displayed position. */
  function currentSideToMove() {
    return sideOfFen(currentDisplayedFen());
  }

  function engineList() {
    if (STATE.engineMode === "stockfish") return ["sf"];
    if (STATE.engineMode === "lc0")       return ["lc0"];
    if (STATE.engineMode === "both")      return ["sf", "lc0"];
    return ["sf"];
  }

  // ---------- Utilities ----------

  /** "Null-move" the FEN: swap side-to-move so we can ask the engine
   *  "what would the OPPONENT play if it were their turn here?". This is the
   *  same trick engines use internally for null-move pruning.
   *
   *  Returns null if the resulting position is illegal — specifically when
   *  the side that ORIGINALLY had the move is in check. (In that case
   *  pretending it's the opponent's turn would leave the original mover's
   *  king en prise, which engines reject.)
   *
   *  We also clear the en-passant target square (no longer valid after a
   *  notional pass) and zero out the halfmove clock. Castling rights are
   *  preserved as-is. */
  function nullMoveFen(fen) {
    if (!fen) return null;
    const parts = fen.split(" ");
    if (parts.length < 4) return null;
    const c = new Chess(fen);
    // If the side currently to move is in check, we cannot legally hand the
    // turn to the opponent (the original mover would still be in check
    // without addressing it). Skip in that case.
    if (c.in_check()) return null;
    parts[1] = parts[1] === "w" ? "b" : "w";
    parts[3] = "-"; // no en-passant after a null move
    if (parts.length >= 5) parts[4] = "0";
    return parts.join(" ");
  }

  function evalFromWhite(an, sideToMove) {
    // an.cp / an.mate are reported from side-to-move's perspective.
    // Convert to "centipawns from White's perspective" so signs are consistent.
    if (!an) return null;
    const sign = sideToMove === "w" ? 1 : -1;
    if (an.mate !== undefined && an.mate !== null) {
      // mate score: large magnitude that decays with distance; clamp to ±1000 cp for display
      const m = an.mate;
      const cp = (m > 0 ? 10000 - m : -10000 - m) * sign;
      return { cp, mate: m * sign };
    }
    if (an.cp === undefined || an.cp === null) return null;
    return { cp: an.cp * sign };
  }

  function fmtEval(whiteEval) {
    if (!whiteEval) return "—";
    if (whiteEval.mate !== undefined) {
      return whiteEval.mate > 0 ? `M${whiteEval.mate}` : `-M${Math.abs(whiteEval.mate)}`;
    }
    const p = whiteEval.cp / 100;
    return (p >= 0 ? "+" : "") + p.toFixed(2);
  }

  function classifyMove(prevEvalWhite, nextEvalWhite, sideThatMoved, wasBestMove) {
    // Returns one of: "best", "good", "inacc", "mistake", "blunder", or null.
    if (!prevEvalWhite || !nextEvalWhite) return null;

    // Convert mate-side-of-the-board to a big cp for diff math
    const cpA = prevEvalWhite.cp;
    const cpB = nextEvalWhite.cp;

    // Loss in centipawns from the moving side's perspective (positive = bad for them).
    const loss = sideThatMoved === "w" ? (cpA - cpB) : (cpB - cpA);

    if (wasBestMove && loss < 30) return "best";
    if (loss < 30) return "good";
    if (loss < 80)  return "inacc";    // 30–79cp — subtle, no annotation chip
    if (loss < 250) return "mistake";  // 80–249cp — annotation only at tipping points
    return "blunder";
  }

  function classificationLabel(c) {
    return ({
      best: "Best move",
      good: "Good move",
      inacc: "Inaccuracy",
      mistake: "Mistake",
      blunder: "Blunder",
    })[c] || "";
  }

  // Material count helpers — used to spot "creative" candidate lines where
  // the moving side gives up material in exchange for activity/initiative.
  // Values use the standard scaled-pawn approximation (knights/bishops ≈ 3+,
  // rooks 5, queen 9). King = 0.
  const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  function netMaterialFromFen(fen) {
    // Returns { white, black } total material in centipawns from the board only.
    const board = fen.split(" ")[0];
    let white = 0, black = 0;
    for (const ch of board) {
      const v = PIECE_VALUES[ch.toLowerCase()];
      if (v === undefined) continue;
      if (ch === ch.toUpperCase()) white += v;
      else black += v;
    }
    return { white, black };
  }

  function materialFor(fen, sideToMove) {
    const m = netMaterialFromFen(fen);
    return sideToMove === "w" ? m.white - m.black : m.black - m.white;
  }

  /** Walk a candidate's PV from `fromFen` and return two material deltas
   *  from the moving side's perspective:
   *    - earlyMin: the most negative material balance seen within the FIRST
   *                `earlyPlies` plies of the PV (the "near-future" window
   *                where a sacrifice has to be visible to be understandable)
   *    - endDelta: the material balance at the END of the full PV (where the
   *                engine's eval applies — the "settled" position).
   *  Negative = moving side has less material than they started with. */
  function materialPathStats(fromFen, pvUci, earlyPlies = 6, maxPlies = 24) {
    const moverSide = fromFen.split(" ")[1];
    const before = materialFor(fromFen, moverSide);
    const c = new Chess(fromFen);
    let earlyMin = 0;
    let endDelta = 0;
    const cap = Math.min(pvUci.length, maxPlies);
    for (let i = 0; i < cap; i++) {
      const u = pvUci[i];
      if (!u || u.length < 4) break;
      const ok = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!ok) break;
      const cur = materialFor(c.fen(), moverSide) - before;
      if (i < earlyPlies && cur < earlyMin) earlyMin = cur;
      endDelta = cur;
    }
    return { earlyMin, endDelta };
  }

  /** Given an engine analysis and the source FEN, pick a "creative" candidate
   *  if one exists: a non-top line where the moving side
   *    (a) noticeably gives up material WITHIN THE FIRST 6 PLIES — so the
   *        sacrifice is concrete enough to follow as a human, not a deep
   *        positional commitment that only manifests 8+ plies in,
   *    (b) is STILL down material at the end of the engine's full PV — so
   *        we don't flag transient exchanges that recapture cleanly,
   *    (c) is within `thresholdCp` centipawns of the top eval — so the
   *        sacrifice is "sound enough" rather than just hopeful.
   *  Returns { candidate, materialDelta } where materialDelta is the net
   *  end-of-PV cost (used for the badge), or null if nothing qualifies. */
  function pickCreativeCandidate(an, fen, thresholdCp) {
    if (!an || !an.candidates || an.candidates.length < 2) return null;
    const top = an.candidates[0];
    if (top.mate !== undefined) return null; // skip in mate-bound positions
    if (top.cp === undefined) return null;

    const MIN_SAC_CP   = 20;  // ≥ 0.2 pawns to count as a "real" sacrifice
    const EARLY_PLIES  = 6;   // sacrifice must be visible within 3 full moves
    let best = null;
    let bestCost = -MIN_SAC_CP;

    for (let i = 1; i < an.candidates.length; i++) {
      const c = an.candidates[i];
      if (c.mate !== undefined) continue;
      if (c.cp === undefined) continue;
      if (top.cp - c.cp > thresholdCp) continue; // outside soundness window

      const stats = materialPathStats(fen, c.pv, EARLY_PLIES);
      if (stats.earlyMin > -MIN_SAC_CP) continue;       // not visible early
      if (stats.endDelta > -MIN_SAC_CP) continue;       // just a transient exchange
      if (stats.endDelta >= bestCost) continue;          // not the biggest net sac

      bestCost = stats.endDelta;
      best = { candidate: c, materialDelta: stats.endDelta };
    }
    return best;
  }

  /** Walk a UCI PV and tally the "tactical density" signals we use for
   *  chaos scoring: captures, checks landed on the opponent, and total
   *  plies actually playable. Limited to 16 plies to keep the cost bounded
   *  on deep PVs. Returns {captures, checks, plies}. */
  function countCheckCapture(fromFen, pvUci, maxPlies = 16) {
    let captures = 0, checks = 0, plies = 0;
    const c = new Chess(fromFen);
    const cap = Math.min(pvUci.length, maxPlies);
    for (let i = 0; i < cap; i++) {
      const u = pvUci[i];
      if (!u || u.length < 4) break;
      const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      if (!mv) break;
      plies++;
      if (mv.captured) captures++;
      if (c.in_check()) checks++; // post-move: side-to-move (= opponent) is in check
    }
    return { captures, checks, plies };
  }

  /** Score each non-top candidate by "chaos index" — a heuristic for
   *  practical opponent difficulty: captures+checks bias, material swings,
   *  PV length, with a soundness penalty per cp lost vs top. We require a
   *  minimum tactical pulse (≥2 captures OR ≥1 check OR ≥50cp material
   *  swing) so we don't pick a quiet long-PV move and call it chaos.
   *
   *  Skip mate-bound positions (mate is already "forced", not "chaotic")
   *  and skip the top candidate (chaos is by definition the off-top pick). */
  function pickChaosCandidate(an, fen, thresholdCp) {
    if (!an || !an.candidates || an.candidates.length < 2) return null;
    const top = an.candidates[0];
    if (top.mate !== undefined) return null;
    if (top.cp === undefined) return null;

    let best = null;
    let bestScore = -Infinity;
    for (let i = 1; i < an.candidates.length; i++) {
      const c = an.candidates[i];
      if (c.mate !== undefined) continue;
      if (c.cp === undefined) continue;
      const cpLoss = top.cp - c.cp;
      if (cpLoss > thresholdCp) continue;

      const stats = materialPathStats(fen, c.pv);
      const cc = countCheckCapture(fen, c.pv);
      const swing = Math.max(Math.abs(stats.earlyMin), Math.abs(stats.endDelta));

      // Minimum tactical pulse — otherwise it's just a long PV, not chaos.
      const hasChaos = cc.captures >= 2 || cc.checks >= 1 || swing >= 50;
      if (!hasChaos) continue;

      const score =
        cc.captures * 3 +
        cc.checks   * 4 +
        Math.abs(stats.earlyMin) * 0.04 +
        Math.abs(stats.endDelta) * 0.02 +
        cc.plies * 0.5 -
        cpLoss * 0.05;

      if (score > bestScore) {
        bestScore = score;
        best = {
          candidate: c,
          score,
          captures: cc.captures,
          checks: cc.checks,
          materialDelta: stats.endDelta,
          cpLoss,
        };
      }
    }
    // Require a non-trivial total — otherwise the "chaos" isn't worth the
    // soundness trade.
    if (!best || bestScore < 8) return null;
    return best;
  }

  function uciLineToSan(fromFen, uciMoves) {
    return uciLineToMoves(fromFen, uciMoves).map((m) => m.san);
  }

  /** Convert a UCI PV into a sequence of { uci, san, fenAfter } records.
   *  We need the post-move FENs so clicking a move in the PV can jump the
   *  board straight to that hypothetical position. */
  function uciLineToMoves(fromFen, uciMoves) {
    const c = new Chess(fromFen);
    const out = [];
    for (const u of uciMoves) {
      if (!u || u.length < 4) break;
      const from = u.slice(0, 2);
      const to = u.slice(2, 4);
      const promo = u.length > 4 ? u[4] : undefined;
      const m = c.move({ from, to, promotion: promo });
      if (!m) break;
      out.push({ uci: u, san: m.san, fenAfter: c.fen() });
    }
    return out;
  }

  function setStatus(text) {
    els.status.textContent = "Engine: " + text;
  }

  // ---------- Stockfish UCI wrapper ----------

  class StockfishEngine {
    constructor(workerUrl) {
      this.worker = new Worker(workerUrl);
      this.handlers = new Set();
      this.worker.onmessage = (e) => {
        const line = typeof e.data === "string" ? e.data : (e.data && e.data.line) || "";
        if (!line) return;
        for (const h of [...this.handlers]) {
          try { h(line); } catch (err) { console.error(err); }
        }
      };
      this.worker.onerror = (e) => console.error("Stockfish error:", e);
      // Supersede-pattern state. See analyze() below for details.
      this._busy = false;        // a search is currently being executed
      this._activeCancel = null; // cancels the executing search (sends UCI stop)
      this._pending = null;      // newest queued target { fen, depth, resolve, reject }
    }

    send(cmd) { this.worker.postMessage(cmd); }

    on(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }

    init(timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const onErr = (e) => {
          if (settled) return;
          settled = true;
          reject(new Error("Stockfish worker failed to load. Did /static/stockfish.js download? See server log."));
        };
        this.worker.addEventListener("error", onErr);

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error("Stockfish did not respond to 'uci' within " + (timeoutMs/1000) + "s."));
        }, timeoutMs);

        const off = this.on((line) => {
          if (line.includes("uciok")) {
            off();
            this.send("setoption name Threads value 1");
            this.send("setoption name Hash value 32");
            this.send("ucinewgame");
            this.send("isready");
            const off2 = this.on((l2) => {
              if (l2.includes("readyok")) {
                off2();
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
              }
            });
          }
        });
        this.send("uci");
      });
    }

    /**
     * Analyze a FEN to a given depth using a "supersede" pattern:
     *
     *   - At most ONE search runs at the worker at a time.
     *   - If analyze() is called while another is in flight, the in-flight
     *     job is signalled to stop (via UCI `stop`) and the new request is
     *     queued as the "pending" target.
     *   - If yet another analyze() arrives before the worker finishes
     *     stopping, the previously-pending request is rejected as
     *     "superseded" and replaced.
     *
     * This guarantees no race between an old job's `bestmove` arriving and
     * a new job's handler — by the time we register a new handler, the
     * worker is fully idle (the previous bestmove has been processed).
     */
    analyze(fen, depth, multipv) {
      return new Promise((resolve, reject) => {
        if (this._pending) {
          // Replace the queued target; the old caller is no longer interested.
          this._pending.reject(new Error("superseded"));
        }
        this._pending = { fen, depth, multipv, resolve, reject };
        this._kick();
      });
    }

    _kick() {
      if (this._busy) {
        // Worker is mid-search. Signal cancellation; we'll pick up the
        // pending target from the `finally` in _runOnce below.
        if (this._activeCancel) {
          try { this._activeCancel(); } catch (_) {}
        }
        return;
      }
      if (!this._pending) return;
      const job = this._pending;
      this._pending = null;
      this._busy = true;
      this._runOnce(job.fen, job.depth, job.multipv)
        .then((res) => job.resolve(res), (err) => job.reject(err))
        .finally(() => {
          this._busy = false;
          this._kick(); // pick up any newer pending target
        });
    }

    _runOnce(fen, depth, multipv) {
      return new Promise((resolve, reject) => {
        let cancelled = false;
        // MultiPV: track the latest info per multipv index (1..N).
        const byMpv = new Map();

        const off = this.on((line) => {
          if (line.startsWith("info ")) {
            const parsed = parseInfo(line);
            if (parsed && parsed.depth !== undefined) {
              const mpv = parsed.multipv || 1;
              const cur = byMpv.get(mpv);
              if (!cur || parsed.depth >= cur.depth) {
                byMpv.set(mpv, {
                  depth: parsed.depth,
                  cp: parsed.cp,
                  mate: parsed.mate,
                  pv: parsed.pv || (cur && cur.pv) || [],
                });
              }
            }
          } else if (line.startsWith("bestmove")) {
            off();
            this._activeCancel = null;
            if (cancelled) return reject(new Error("cancelled"));

            const candidates = [...byMpv.keys()].sort((a, b) => a - b).map((k) => {
              const c = byMpv.get(k);
              return {
                bestMove: c.pv[0],
                pv: c.pv,
                cp: c.cp,
                mate: c.mate,
                depth: c.depth,
              };
            });
            const primary = candidates[0] || { depth: 0, pv: [] };
            resolve({ ...primary, candidates });
          }
        });

        this._activeCancel = () => {
          cancelled = true;
          this.send("stop");
        };

        // Re-sending MultiPV before each search is fine. Caller picks the
        // width: 4 for normal use; 12 when chaos mode wants a richer
        // candidate pool to score for opponent-difficulty.
        const mpv = multipv && multipv > 0 ? multipv : 4;
        this.send("setoption name MultiPV value " + mpv);
        this.send("position fen " + fen);
        this.send("go depth " + depth);
      });
    }

    /** External cancel: abort the current search AND discard any pending. */
    cancel() {
      if (this._pending) {
        this._pending.reject(new Error("cancelled"));
        this._pending = null;
      }
      if (this._activeCancel) {
        try { this._activeCancel(); } catch (_) {}
      }
    }
  }

  function parseInfo(line) {
    // Example:
    // info depth 14 seldepth 20 multipv 1 score cp 31 nodes 1234 nps 50000 time 250 pv e2e4 e7e5 g1f3
    const out = {};
    let m;
    if ((m = /depth (\d+)/.exec(line))) out.depth = +m[1];
    if ((m = /\bmultipv (\d+)/.exec(line))) out.multipv = +m[1];
    if ((m = /score cp (-?\d+)/.exec(line))) out.cp = +m[1];
    if ((m = /score mate (-?\d+)/.exec(line))) out.mate = +m[1];
    const idx = line.indexOf(" pv ");
    if (idx > -1) {
      out.pv = line.slice(idx + 4).trim().split(/\s+/);
    }
    return out;
  }

  // ---------- Board ----------

  function buildBoard() {
    STATE.boardObj = Chessboard("board", {
      draggable: true,
      pieceTheme: "/static/img/chesspieces/wikipedia/{piece}.png",
      position: STATE.positions[0],
      orientation: STATE.orientation,
      onDragStart: onBoardDragStart,
      onDrop: onBoardDrop,
      onSnapEnd: onBoardSnapEnd,
    });
    // Cache the wrap element used as the coordinate space for the SVG
    // arrow overlay.
    els.boardArrowWrap = document.querySelector(".board-arrow-wrap");
    window.addEventListener("resize", () => {
      if (STATE.boardObj) STATE.boardObj.resize();
      renderPlanArrows();
      renderEvalChart();
    });
  }

  // -- Explorer mode: piece-drag handlers --

  function onBoardDragStart(source, piece) {
    // Engine variations are pre-defined study lines — read-only.
    if (STATE.variation && STATE.variation.source !== "user") return false;
    // For user sidelines, drag against the variation's tip fen so further
    // moves extend the sideline. Otherwise drag against the real ply fen.
    const fen = STATE.variation ? STATE.variation.fenAfter : STATE.positions[STATE.ply];
    if (!fen) return false;
    const sideToMove = fen.split(" ")[1];
    if ((sideToMove === "w" && piece.startsWith("b")) ||
        (sideToMove === "b" && piece.startsWith("w"))) {
      return false;
    }
    return true;
  }

  function onBoardDrop(source, target) {
    if (source === target) return "snapback";
    // From-fen: tip of the active user sideline if we're inside one,
    // else the current real ply.
    const fromFen = STATE.variation && STATE.variation.source === "user"
      ? STATE.variation.fenAfter
      : STATE.positions[STATE.ply];
    const c = new Chess(fromFen);
    // Auto-queen promotion. (Adding a picker is a TODO; >99% of human play
    // chooses queen anyway.)
    const move = c.move({ from: source, to: target, promotion: "q" });
    if (!move) return "snapback";
    const uci = move.from + move.to + (move.promotion || "");

    // CASE A: extending an existing user sideline. If the user has
    // navigated back into the sideline (currentPly < moves.length),
    // truncate the tail and branch from here.
    if (STATE.variation && STATE.variation.source === "user") {
      const v = STATE.variation;
      v.moves.length = v.currentPly;     // truncate (no-op when at tip)
      v.moves.push(uci);
      v.currentPly = v.moves.length;
      v.fenAfter = c.fen();
      updateVariationBanner();
      renderMoveInfo();
      renderMoveList();                  // refresh sideline row
      analyzeSidelineTip();
      return;
    }

    // CASE B: at the END of a loaded game (or an empty/explorer game) —
    // nothing to preserve, just append to the main line as before.
    if (STATE.ply === STATE.moves.length) {
      appendMove(move, c.fen());
      renderMoveList();
      STATE.ply = STATE.positions.length - 1;
      highlightCurrentMove();
      renderMoveInfo();
      cancelStaleAnalyses(STATE.ply);
      analyzeCurrent();
      return;
    }

    // CASE C: ply is mid-game. Behavior depends on whether a PGN is loaded:
    //   - PGN loaded → start a user sideline so the loaded game is
    //     preserved (Esc returns to PGN intact, just like engine variations).
    //   - Explorer mode → truncate-and-append as before, since the user
    //     owns the move history and probably wants to revise it.
    if (STATE.pgnLoaded) {
      enterUserVariation(STATE.ply, uci);
      return;
    }
    truncateGameAt(STATE.ply);
    appendMove(move, c.fen());
    renderMoveList();
    STATE.ply = STATE.positions.length - 1;
    highlightCurrentMove();
    renderMoveInfo();
    cancelStaleAnalyses(STATE.ply);
    analyzeCurrent();
  }

  /** Start a user-driven sideline from the current real ply. The loaded
   *  PGN's moves/positions/analyses are NOT touched — the sideline is a
   *  preview overlay. Further drag-drops extend STATE.variation.moves. */
  function enterUserVariation(basePly, firstUci) {
    const baseFen = STATE.positions[basePly];
    const c = new Chess(baseFen);
    const ok = c.move({
      from: firstUci.slice(0, 2),
      to: firstUci.slice(2, 4),
      promotion: firstUci[4],
    });
    if (!ok) return;
    // Drop any previous sideline (we only keep one per session — starting
    // a new one from a different ply replaces the prior).
    if (STATE.savedSideline && STATE.savedSideline !== STATE.variation) {
      // Already orphaned; nothing to cancel.
    }
    const sideline = {
      basePly,
      moves: [firstUci],
      fenAfter: c.fen(),
      engine: null,
      source: "user",
      currentPly: 1,
      tipAnalysis: null, tipLoading: false, tipCancel: null,
      tipOppAnalysis: null, tipOppLoading: false, tipOppCancel: null,
    };
    STATE.variation = sideline;
    STATE.savedSideline = sideline;
    STATE.boardObj.position(c.fen(), true);
    document.getElementById("board").classList.add("in-variation");
    els.variationBanner.classList.remove("hidden");
    updateVariationBanner();
    renderMoveInfo();
    renderMoveList();        // refresh so the sideline row appears
    analyzeSidelineTip();    // kick off SF on the new tip
  }

  /** Refresh the variation banner text from STATE.variation. Used both
   *  when entering and when extending a sideline (drag-drop) so the
   *  "last move shown" segment stays accurate. */
  function updateVariationBanner() {
    const v = STATE.variation;
    if (!v) return;
    const baseMoveNum = Math.ceil(v.basePly / 2);
    const sideAtBase = sideOfFen(STATE.positions[v.basePly]);
    const baseLabel = v.basePly === 0
      ? "starting position"
      : `${baseMoveNum}${sideAtBase === "w" ? "…" : "."} (move ${v.basePly})`;
    const sourceLabel = v.source === "user"
      ? "your sideline"
      : (v.engine === "lc0" ? "Lc0 variation"
         : v.engine === "sf" ? "SF18 variation"
         : "engine variation");
    // Convert all moves to SAN for the trailing "last move" segment.
    // currentPly may be 0 (showing the base position) — handle that.
    const displayUci = v.moves.slice(0, v.currentPly);
    const moves = uciLineToMoves(STATE.positions[v.basePly], displayUci);
    const lastSan = moves.length ? moves[moves.length - 1].san : "(base)";
    const plies = moves.length;
    const tail = ` — ${plies}/${v.moves.length} ply${v.moves.length === 1 ? "" : "ies"}, last: ${lastSan}`;
    els.variationBannerText.textContent =
      `Viewing ${sourceLabel} from ${baseLabel}${tail}`;
  }

  function onBoardSnapEnd() {
    if (!STATE.boardObj) return;
    // While in a user sideline, the board's authoritative fen is the
    // sideline tip — otherwise it's the current ply's real position.
    const fen = STATE.variation && STATE.variation.source === "user"
      ? STATE.variation.fenAfter
      : STATE.positions[STATE.ply];
    STATE.boardObj.position(fen, false);
  }

  // Cancel and drop all per-ply state past `plyIndex` (exclusive). Used when
  // the user makes a branching move from the middle of a loaded game.
  function truncateGameAt(plyIndex) {
    for (let i = plyIndex + 1; i < STATE.cancels.length; i++) {
      const handles = STATE.cancels[i] || {};
      for (const k of Object.keys(handles)) {
        try { handles[k](); } catch (_) {}
      }
      const oppHandles = STATE.opponentCancels[i] || {};
      for (const k of Object.keys(oppHandles)) {
        try { oppHandles[k](); } catch (_) {}
      }
    }
    STATE.positions         = STATE.positions.slice(0, plyIndex + 1);
    STATE.moves             = STATE.moves.slice(0, plyIndex);
    STATE.analyses          = STATE.analyses.slice(0, plyIndex + 1);
    STATE.loading           = STATE.loading.slice(0, plyIndex + 1);
    STATE.cancels           = STATE.cancels.slice(0, plyIndex + 1);
    STATE.opponentAnalyses  = STATE.opponentAnalyses.slice(0, plyIndex + 1);
    STATE.opponentLoading   = STATE.opponentLoading.slice(0, plyIndex + 1);
    STATE.opponentCancels   = STATE.opponentCancels.slice(0, plyIndex + 1);
    // Drop now-invalid plies from the bg queue.
    STATE.bgQueue = STATE.bgQueue.filter((i) => i <= plyIndex);
    // If the saved sideline's basePly was sliced off, discard it too.
    if (STATE.savedSideline && STATE.savedSideline.basePly > plyIndex) {
      STATE.savedSideline = null;
    }
  }

  function appendMove(verboseMove, newFen) {
    STATE.moves.push(verboseMove);
    STATE.positions.push(newFen);
    STATE.analyses.push({});
    STATE.loading.push(new Set());
    STATE.cancels.push({});
    STATE.opponentAnalyses.push({});
    STATE.opponentLoading.push(new Set());
    STATE.opponentCancels.push({});
  }

  function startNewGame() {
    // Cancel any in-flight analyses (real + opponent-plan).
    for (let i = 0; i < STATE.cancels.length; i++) {
      const handles = STATE.cancels[i] || {};
      for (const k of Object.keys(handles)) {
        try { handles[k](); } catch (_) {}
      }
      const oppHandles = STATE.opponentCancels[i] || {};
      for (const k of Object.keys(oppHandles)) {
        try { oppHandles[k](); } catch (_) {}
      }
    }
    const startFen = new Chess().fen();
    STATE.positions = [startFen];
    STATE.moves     = [];
    STATE.analyses  = [{}];
    STATE.loading   = [new Set()];
    STATE.cancels   = [{}];
    STATE.opponentAnalyses = [{}];
    STATE.opponentLoading  = [new Set()];
    STATE.opponentCancels  = [{}];
    STATE.ply       = 0;
    STATE.pgnLoaded = false;
    STATE.bgQueue   = []; // discard pending bg work for the old game
    STATE.currentOpening = null;
    STATE.currentLibraryGameId = null;
    STATE.savedSideline = null;
    updateOpeningChip();
    if (STATE.variation) {
      STATE.variation = null;
      els.variationBanner.classList.add("hidden");
      document.getElementById("board").classList.remove("in-variation");
    }
    renderMoveList();
    goToPly(0);
    appendChat("system", "New game started — drag pieces to make moves. The engine will analyze each position live.");
  }

  // ---------- PGN loading ----------

  function loadPgn(pgn) {
    const game = new Chess();
    const ok = game.load_pgn(pgn, { sloppy: true });
    if (!ok) {
      const stripped = pgn.replace(/\{[^}]*\}/g, "").replace(/\([^)]*\)/g, "");
      if (!game.load_pgn(stripped, { sloppy: true })) {
        alert("Could not parse this PGN. Make sure it's standard format.");
        return false;
      }
    }
    const history = game.history({ verbose: true });

    const replay = new Chess();
    const positions = [replay.fen()];
    const moves = [];
    for (const mv of history) {
      replay.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      positions.push(replay.fen());
      moves.push(mv);
    }

    STATE.game = game;
    STATE.positions = positions;
    STATE.moves = moves;
    STATE.analyses          = Array.from({ length: positions.length }, () => ({}));
    STATE.loading           = Array.from({ length: positions.length }, () => new Set());
    STATE.cancels           = Array.from({ length: positions.length }, () => ({}));
    STATE.opponentAnalyses  = Array.from({ length: positions.length }, () => ({}));
    STATE.opponentLoading   = Array.from({ length: positions.length }, () => new Set());
    STATE.opponentCancels   = Array.from({ length: positions.length }, () => ({}));
    STATE.ply = 0;
    STATE.pgnLoaded = true;
    STATE.bgQueue   = []; // fresh game — discard any bg work from a prior load
    STATE.savedSideline = null; // sidelines are tied to the prior game's plies

    renderMoveList();
    goToPly(0);
    appendChat("system", `Loaded ${moves.length} half-moves. Click a move or use ← / → to navigate. Analyzing the position you're on…`);
    analyzeCurrent();
    prefetchCachedEvals(); // populate move-list evals from the SQLite cache
    // Persist to the library (skipped automatically when re-opening from
    // a library row — see autoSaveCurrentPgn). Don't await — the load
    // shouldn't block on a network round-trip.
    autoSaveCurrentPgn(pgn);
    return true;
  }

  /** Batch-fetch the analysis cache for every position in the current game
   *  so the move list can show evals immediately for previously-analyzed
   *  positions, before the live engine has a chance to re-evaluate them. */
  async function prefetchCachedEvals() {
    if (!STATE.positions || STATE.positions.length < 2) return;
    const depth = clampDepth(+els.depth.value || 16);
    const lc0Movetime = Math.min(7000, Math.round((depth - 7) * 350));

    // Which engines is the user looking at? Prefetch each.
    const want = engineList().filter((k) => k !== "lc0" || STATE.lc0Available);
    for (const engineKey of want) {
      const engineId = engineKey === "sf" ? "sf18" : "lc0";
      const limit_type  = engineKey === "sf" ? "depth" : "movetime";
      const limit_value = engineKey === "sf" ? depth : lc0Movetime;
      try {
        const res = await fetch("/api/cache/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            engine: engineId,
            fens: STATE.positions,
            limit_type, limit_value,
            // Prefetch always uses multipv=4 — the batch endpoint takes a
            // single value, and the chaos picks (which want 12) will fill
            // in via live analysis as the user navigates. Cache treats
            // higher multipv as stronger so existing MultiPV=12 entries
            // will still satisfy this request.
            multipv: 4,
          }),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const results = (data && data.results) || [];
        results.forEach((result, i) => {
          if (!result) return;
          if (!STATE.analyses[i][engineKey]) {
            STATE.analyses[i][engineKey] = { ...result, cached: true };
          }
        });
      } catch (_) {
        // Cache disabled or network error — silently ignore; analyses will
        // run live.
      }
    }
    // Refresh the move list eval labels + classifications. Live analyses
    // go through maybeUpdateNeighborClassifications when each result
    // lands; this is the equivalent batch pass for cache-prefetched
    // results so a fully-cached PGN shows its tipping-point marks
    // immediately instead of only after the user navigates to each move.
    for (let i = 1; i < STATE.positions.length; i++) {
      updateMoveListEval(i);
      const cls = computeClassification(i);
      if (cls) applyClassificationToMoveEl(i, cls);
      else     updateMoveListAnnotation(i, null);
    }
    renderMoveInfo();
  }

  // ---------- Rendering ----------

  function renderMoveList() {
    els.moveList.innerHTML = "";
    // Group moves into pairs (white, black) by full move number.
    const pairs = [];
    for (let i = 0; i < STATE.moves.length; i += 2) {
      pairs.push([STATE.moves[i], STATE.moves[i + 1] || null]);
    }
    // If a saved sideline branches from the starting position, render
    // the row above all pairs.
    const sideline = STATE.savedSideline;
    if (sideline && sideline.basePly === 0) {
      const row = buildSidelineRow(sideline);
      if (row) els.moveList.appendChild(row);
    }
    pairs.forEach((pair, idx) => {
      const li = document.createElement("li");
      const numEl = document.createElement("span");
      numEl.className = "num";
      numEl.textContent = (idx + 1) + ".";
      li.appendChild(numEl);

      const [w, b] = pair;
      li.appendChild(makeMoveEl(w, idx * 2 + 1));
      if (b) li.appendChild(makeMoveEl(b, idx * 2 + 2));
      else li.appendChild(document.createElement("span"));

      els.moveList.appendChild(li);

      // If a saved sideline branches from a ply WITHIN this pair, render
      // the sideline row immediately below. Plies 1 (after white's move)
      // and 2 (after black's move) both belong to pair index 0; in
      // general, basePly P (1..N) lives in pair index ceil(P/2)-1.
      if (sideline && sideline.basePly > 0) {
        const pairIdx = Math.ceil(sideline.basePly / 2) - 1;
        if (pairIdx === idx) {
          const row = buildSidelineRow(sideline);
          if (row) els.moveList.appendChild(row);
        }
      }
    });
    // Rebuilding the DOM wiped the classification classes/annotations.
    // Re-apply them so navigation/sideline-toggling don't lose them.
    for (let i = 1; i < STATE.positions.length; i++) {
      const cls = computeClassification(i);
      if (cls) applyClassificationToMoveEl(i, cls);
      else     updateMoveListAnnotation(i, null);
    }
    highlightCurrentMove();
    renderEvalChart();
  }

  // ---------- Eval timeline chart ----------
  //
  // SVG line chart of White-perspective cp across the game. Lives under
  // the board, full-width of board-col. Markers ("??", "?", "!!") are
  // drawn at tipping-point mistakes/blunders and brilliant sacrifices —
  // same rules as the move-list annotations. Click anywhere to jump to
  // the closest ply; hover updates the tip text in the header.
  const EC_CLAMP_CP = 1000;        // y-axis clamp (±10 pawns)
  const EC_PAD = { top: 14, right: 8, bottom: 14, left: 8 };
  const SVG_NS = "http://www.w3.org/2000/svg";

  function ecMakeNode(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k in attrs) el.setAttribute(k, attrs[k]);
    }
    return el;
  }

  function ecEvalAtPly(ply) {
    // Prefer SF; fall back to Lc0 if only that's present.
    const entry = STATE.analyses[ply];
    if (!entry) return null;
    const an = entry.sf || entry.lc0;
    if (!an) return null;
    return evalFromWhite(an, sideOfFen(STATE.positions[ply]));
  }

  function ecClampCp(cp) {
    if (cp > EC_CLAMP_CP) return EC_CLAMP_CP;
    if (cp < -EC_CLAMP_CP) return -EC_CLAMP_CP;
    return cp;
  }

  function ecMarkerAt(plyAfter) {
    // Returns { mark, cls } or null — same rules as the move-list chips.
    if (plyAfter < 1) return null;
    const cls = computeClassification(plyAfter);
    if (cls === "best" && wasBrilliantSacrifice(plyAfter))
      return { mark: "!!", cls: "brilliant" };
    if (!isTippingPoint(plyAfter)) return null;
    if (cls === "blunder") return { mark: "??", cls: "blunder" };
    if (cls === "mistake") return { mark: "?",  cls: "mistake" };
    return null;
  }

  function renderEvalChart() {
    const svg = els.evalChart;
    if (!svg) return;
    // Clear previous render.
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const N = STATE.positions.length;
    // Pixel-space drawing — read the SVG's actual rendered size and
    // mirror it into viewBox so dots/text stay crisp regardless of
    // window width.
    const W = Math.max(200, svg.clientWidth || svg.parentElement.clientWidth || 600);
    const H = Math.max(60,  svg.clientHeight || 120);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);

    const x0 = EC_PAD.left;
    const y0 = EC_PAD.top;
    const innerW = W - EC_PAD.left - EC_PAD.right;
    const innerH = H - EC_PAD.top - EC_PAD.bottom;
    const yMid = y0 + innerH / 2;

    // Background halves — subtle white bias top, dark bias bottom.
    svg.appendChild(ecMakeNode("rect", {
      class: "ec-bg-white", x: x0, y: y0, width: innerW, height: innerH / 2,
    }));
    svg.appendChild(ecMakeNode("rect", {
      class: "ec-bg-black", x: x0, y: yMid, width: innerW, height: innerH / 2,
    }));

    if (N < 2) {
      // Nothing to plot — render a placeholder so the panel still reads as
      // "this is where the eval timeline will appear".
      const txt = ecMakeNode("text", {
        class: "ec-empty", x: W / 2, y: H / 2,
      });
      txt.textContent = "Load a PGN or play some moves to see the eval timeline";
      svg.appendChild(txt);
      return;
    }

    const xAt = (ply) => x0 + (ply / (N - 1)) * innerW;
    const yAt = (cp)  => yMid - (ecClampCp(cp) / EC_CLAMP_CP) * (innerH / 2);

    // Gridlines at ±2 / ±5 pawns for a visual yardstick.
    [200, -200, 500, -500].forEach((cp) => {
      svg.appendChild(ecMakeNode("line", {
        class: "ec-grid",
        x1: x0, x2: x0 + innerW,
        y1: yAt(cp), y2: yAt(cp),
      }));
    });

    // Zero line.
    svg.appendChild(ecMakeNode("line", {
      class: "ec-zero",
      x1: x0, x2: x0 + innerW,
      y1: yMid, y2: yMid,
    }));

    // Collect data points. Ply 0 always anchors at 0 cp (theoretical start)
    // so the line has a sensible left edge even before analysis is in.
    const pts = [];
    for (let p = 0; p < N; p++) {
      let cp = null;
      if (p === 0) {
        const e = ecEvalAtPly(0);
        cp = e ? e.cp : 0;
      } else {
        const e = ecEvalAtPly(p);
        if (e) cp = e.cp;
      }
      if (cp !== null) pts.push({ ply: p, cp });
    }

    if (pts.length >= 2) {
      // Filled area under the line — gives the chart a "weight" feel and
      // makes the side currently winning visually obvious.
      const areaD =
        `M ${xAt(pts[0].ply)} ${yMid} ` +
        pts.map(p => `L ${xAt(p.ply)} ${yAt(p.cp)}`).join(" ") +
        ` L ${xAt(pts[pts.length - 1].ply)} ${yMid} Z`;
      svg.appendChild(ecMakeNode("path", { class: "ec-area", d: areaD }));

      // Eval line itself.
      const lineD =
        `M ${xAt(pts[0].ply)} ${yAt(pts[0].cp)} ` +
        pts.slice(1).map(p => `L ${xAt(p.ply)} ${yAt(p.cp)}`).join(" ");
      svg.appendChild(ecMakeNode("path", { class: "ec-line", d: lineD }));
    }

    // Per-ply dots + classification class. Skip ply 0 (no move yet).
    pts.forEach((p) => {
      if (p.ply === 0) return;
      const marker = ecMarkerAt(p.ply);
      const cls = marker ? marker.cls : null;
      const dot = ecMakeNode("circle", {
        class: "ec-dot" + (cls ? " cls-" + cls : "")
                       + (p.ply === STATE.ply ? " active" : ""),
        cx: xAt(p.ply), cy: yAt(p.cp), r: p.ply === STATE.ply ? 5 : 3,
        "data-ply": p.ply,
      });
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        goToPly(p.ply);
      });
      svg.appendChild(dot);
    });

    // Markers ("??", "?", "!!") drawn ABOVE or BELOW the line depending
    // on which side made the move — keeps them out of the line's way.
    pts.forEach((p) => {
      const marker = ecMarkerAt(p.ply);
      if (!marker) return;
      // White moved on odd plies; their badge floats above the line.
      // Black moved on even plies; their badge floats below.
      const above = (p.ply % 2 === 1);
      const dotY = yAt(p.cp);
      const offset = 14;
      const by = above ? dotY - offset : dotY + offset;
      // Clamp inside the inner area.
      const cy = Math.max(y0 + 8, Math.min(y0 + innerH - 8, by));
      const cx = xAt(p.ply);

      svg.appendChild(ecMakeNode("circle", {
        class: "ec-mark-bg cls-" + marker.cls,
        cx, cy, r: 8,
      }));
      const txt = ecMakeNode("text", {
        class: "ec-mark-text cls-" + marker.cls,
        x: cx, y: cy + 0.5,
      });
      txt.textContent = marker.mark;
      svg.appendChild(txt);
    });

    // Invisible overlay capturing chart-wide hover/click. Lets users
    // click anywhere on the chart (not just dots) to jump to the
    // nearest ply, and drives the tooltip text.
    const hit = ecMakeNode("rect", {
      class: "ec-hit",
      x: x0, y: y0, width: innerW, height: innerH,
    });
    const plyFromX = (px) => {
      const t = Math.max(0, Math.min(1, (px - x0) / innerW));
      return Math.round(t * (N - 1));
    };
    hit.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (W / rect.width);
      const ply = plyFromX(px);
      ecUpdateTip(ply);
    });
    hit.addEventListener("mouseleave", () => ecUpdateTip(null));
    hit.addEventListener("click", (e) => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (W / rect.width);
      goToPly(plyFromX(px));
    });
    svg.appendChild(hit);
  }

  function ecUpdateTip(ply) {
    if (!els.evalChartTip) return;
    if (ply === null || ply === undefined || ply < 0) {
      els.evalChartTip.textContent = "";
      return;
    }
    const ev = ecEvalAtPly(ply);
    const evalStr = ev ? fmtEval(ev) : "—";
    if (ply === 0) {
      els.evalChartTip.textContent = `Start · ${evalStr}`;
      return;
    }
    const mv = STATE.moves[ply - 1];
    const moveNum = Math.ceil(ply / 2);
    const dot = (ply % 2 === 1) ? "." : "…";
    const san = mv ? mv.san : "—";
    els.evalChartTip.textContent = `${moveNum}${dot} ${san} · ${evalStr}`;
  }

  /** Build the sideline `<li>` for the move list. Shows each ply as a
   *  clickable SAN chip. The currently-displayed ply (when the user is
   *  viewing the sideline) is highlighted; if the user is on the main
   *  line, none is highlighted and clicking re-enters the sideline. */
  function buildSidelineRow(sideline) {
    if (!sideline || !sideline.moves || !sideline.moves.length) return null;
    const li = document.createElement("li");
    li.className = "sideline-row";

    const label = document.createElement("span");
    label.className = "sideline-label";
    label.textContent = "Your line";
    label.title = "Session-only sideline — click any move to jump there";
    li.appendChild(label);

    const movesEl = document.createElement("span");
    movesEl.className = "sideline-moves";

    // Convert UCIs to SAN with the right move-number prefixes.
    const baseFen = STATE.positions[sideline.basePly];
    const moves = uciLineToMoves(baseFen, sideline.moves);
    const baseSide = sideOfFen(baseFen); // side-to-move at base position
    const baseFullMove = Math.floor(sideline.basePly / 2) + 1;
    const isActive = STATE.variation === sideline;

    moves.forEach((m, i) => {
      // Determine if THIS move is white's or black's, and add move number
      // prefixes (white moves get "N.", first-move-is-black gets "N...").
      const moverIsWhite = (baseSide === "w") ? (i % 2 === 0) : (i % 2 === 1);
      if (moverIsWhite) {
        const num = document.createElement("span");
        num.className = "sideline-num";
        const moveNum = baseFullMove + Math.floor(((baseSide === "w" ? 0 : 1) + i) / 2);
        num.textContent = `${moveNum}.`;
        movesEl.appendChild(num);
      } else if (i === 0) {
        // Black-to-move at the base position → first sideline ply is
        // black's; prefix with "N..." to make it scan as a black move.
        const num = document.createElement("span");
        num.className = "sideline-num";
        num.textContent = `${baseFullMove}…`;
        movesEl.appendChild(num);
      }
      const moveSpan = document.createElement("span");
      moveSpan.className = "sideline-move";
      moveSpan.textContent = m.san;
      moveSpan.dataset.ply = i + 1;
      if (isActive && sideline.currentPly === i + 1) {
        moveSpan.classList.add("active");
      }
      moveSpan.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isActive) {
          // Already viewing — just jump within the sideline.
          goToSidelinePly(i + 1);
        } else {
          // Re-enter the saved sideline at this ply.
          reenterSavedSideline(i + 1);
        }
      });
      movesEl.appendChild(moveSpan);
      movesEl.appendChild(document.createTextNode(" "));
    });

    li.appendChild(movesEl);

    // Small × to discard the sideline entirely.
    const closeBtn = document.createElement("button");
    closeBtn.className = "sideline-close";
    closeBtn.textContent = "×";
    closeBtn.title = "Discard this sideline";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearSavedSideline();
    });
    li.appendChild(closeBtn);

    return li;
  }

  /** Discard the saved sideline (session-only — no DB to clean). Used by
   *  the × button in the sideline row and by new-game / load-PGN. */
  function clearSavedSideline() {
    if (STATE.variation && STATE.variation === STATE.savedSideline) {
      // Currently viewing the sideline — exit first so the board returns
      // to the main game.
      exitVariation();
    }
    STATE.savedSideline = null;
    renderMoveList();
  }

  function makeMoveEl(mv, plyAfter) {
    // plyAfter is the ply *after* this move, i.e. index into positions.
    const span = document.createElement("span");
    span.className = "move";
    span.dataset.ply = plyAfter;
    span.addEventListener("click", () => goToPly(plyAfter));

    const sanEl = document.createElement("span");
    sanEl.className = "move-san";
    sanEl.textContent = mv.san;
    span.appendChild(sanEl);

    // Eval label (small grey) — populated by updateMoveListEval whenever an
    // analysis arrives for this ply, either from cache prefetch or live.
    const evalEl = document.createElement("span");
    evalEl.className = "move-eval";
    span.appendChild(evalEl);
    updateMoveListEval(plyAfter, span);

    return span;
  }

  /** Write the cached/live eval into the move-list row for `plyAfter`.
   *  Looks up the primary analysis (SF preferred, Lc0 fallback) and renders
   *  a compact "+0.42" / "−1.20" / "M3" label. Call this whenever an analysis
   *  result lands so the list updates live. */
  function updateMoveListEval(plyAfter, rowEl) {
    if (plyAfter <= 0) return;
    const row = rowEl || document.querySelector(`.move-list .move[data-ply="${plyAfter}"]`);
    if (!row) return;
    const evalEl = row.querySelector(".move-eval");
    if (!evalEl) return;
    const an = primaryAnalysisFor(plyAfter);
    if (!an) { evalEl.textContent = ""; return; }
    const fen = STATE.positions[plyAfter];
    const sideToMove = fen.split(" ")[1];
    const we = evalFromWhite(an, sideToMove);
    if (!we) { evalEl.textContent = ""; return; }
    evalEl.textContent = fmtEval(we);
  }

  function highlightCurrentMove() {
    document.querySelectorAll(".move-list .move").forEach((el) => {
      el.classList.toggle("active", +el.dataset.ply === STATE.ply);
    });
  }

  function applyClassificationToMoveEl(plyAfter, cls) {
    const el = document.querySelector(`.move-list .move[data-ply="${plyAfter}"]`);
    if (!el) return;
    el.classList.remove("best", "good", "inacc", "mistake", "blunder", "brilliant");
    // Only mark the move-list row when this is a tipping point or a
    // brilliant — matching the annotation-chip rule. Keeps the list
    // clean for at-a-glance scanning; the eyes go straight to the few
    // moves that matter.
    if ((cls === "mistake" || cls === "blunder") && isTippingPoint(plyAfter)) {
      el.classList.add(cls);
    } else if (cls === "best" && wasBrilliantSacrifice(plyAfter)) {
      el.classList.add("brilliant");
    }
    updateMoveListAnnotation(plyAfter, cls);
  }

  /** Brilliant-move detection — fires the "!! 🔥" annotation.
   *
   *  Daan's intuition: "you offer a piece, and if taken the opponent is
   *  in big trouble all of a sudden." We translate that to three checks
   *  that all have to hold:
   *
   *    1. The piece sitting on the destination square (after the move)
   *       is at least a minor (knight/bishop/rook/queen). No pawn
   *       sacrifices — those feel like positional offerings, not
   *       brilliances.
   *
   *    2. The piece is en prise: the opponent has a legal capture of
   *       it. (We don't check "is it defended" directly — step 3 does
   *       that better, since "defended" is really a question of what
   *       the engine says happens after taking.)
   *
   *    3. Stockfish, analyzing from the opponent's POV after the
   *       sacrifice, rates the capture substantially worse than the
   *       top reply — i.e., the engine itself sees that taking puts
   *       opponent in big trouble. Threshold: ≥200cp gap (or capture
   *       isn't in the post-sac MultiPV at all — even stronger signal).
   *
   *  Returns true only when all three hold. The pre-sac eval doesn't
   *  matter — a brilliant sac in a winning position is still brilliant. */
  function wasBrilliantSacrifice(plyAfter) {
    if (plyAfter < 1) return false;

    const mv = STATE.moves[plyAfter - 1];
    if (!mv) return false;

    // 1. Piece on destination square is ≥ minor.
    const post = new Chess(STATE.positions[plyAfter]);
    const piece = post.get(mv.to);
    if (!piece) return false;
    const PIECE_VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
    if ((PIECE_VAL[piece.type] || 0) < 300) return false;

    // 2. Opponent has a legal capture of it.
    const oppMoves = post.moves({ verbose: true });
    const captureMove = oppMoves.find((m) => m.to === mv.to);
    if (!captureMove) return false;
    const captureUci4 = captureMove.from + captureMove.to;

    // 3. Engine verdict from opponent's POV at the post-sac position.
    const postAn = (STATE.analyses[plyAfter] || {}).sf;
    if (!postAn || !postAn.candidates || !postAn.candidates.length) return false;
    const topReply = postAn.candidates[0];
    if (!topReply || topReply.cp === undefined) return false;

    const captureCand = postAn.candidates.find((c) =>
      c.pv && c.pv[0] && c.pv[0].slice(0, 4) === captureUci4
    );

    // Capture isn't even in opponent's top MultiPV — engine considers it
    // too bad to rank. Strong "if taken, big trouble" signal.
    if (!captureCand) return true;
    if (captureCand.cp === undefined) return false;

    // Both evals are opponent-perspective (opponent is to move at postFen).
    // Top reply > capture means declining is meaningfully better than taking.
    const gap = topReply.cp - captureCand.cp;
    return gap >= 200;
  }

  // Tipping-point detection — annotation logic in the move list uses this
  // to filter "?"/"??" to only critical moments. A move is a tipping point
  // when (1) it loses ≥80cp AND (2) the eval crosses a "bucket" boundary
  // from the moving side's perspective — i.e., the practical outlook of
  // the position shifted (winning → equal, equal → losing, etc.), not
  // just "the engine number went down a bit." Targets ~2-4 marks per game.
  const TIPPING_LOSS_CP = 80;
  const BUCKET_BOUNDARY_CP = 100; // ±1.00 separates "advantage" from "equal"

  function evalBucket(whiteCp) {
    if (whiteCp >=  BUCKET_BOUNDARY_CP) return 1;
    if (whiteCp <= -BUCKET_BOUNDARY_CP) return -1;
    return 0;
  }

  function isTippingPoint(plyAfter) {
    if (plyAfter < 1) return false;
    const prev = (STATE.analyses[plyAfter - 1] || {}).sf;
    const cur  = (STATE.analyses[plyAfter]     || {}).sf;
    if (!prev || !cur) return false;
    const prevSide = sideOfFen(STATE.positions[plyAfter - 1]);
    const curSide  = sideOfFen(STATE.positions[plyAfter]);
    const prevW = evalFromWhite(prev, prevSide);
    const curW  = evalFromWhite(cur,  curSide);
    if (!prevW || !curW) return false;
    const sideThatMoved = prevSide;
    const loss = sideThatMoved === "w" ? (prevW.cp - curW.cp) : (curW.cp - prevW.cp);
    if (loss < TIPPING_LOSS_CP) return false;
    const b1 = evalBucket(prevW.cp);
    const b2 = evalBucket(curW.cp);
    // Bucket worsens for the side that just moved:
    //   - white moved: white's perspective bucket goes down → b2 < b1
    //   - black moved: white's perspective bucket goes up → b2 > b1
    return sideThatMoved === "w" ? b2 < b1 : b2 > b1;
  }

  /** Add or update the small annotation chip between the SAN and the eval
   *  for a move list row. Combines classification mark with the 🔥
   *  brilliant/sacrifice indicator when applicable. */
  function updateMoveListAnnotation(plyAfter, cls) {
    const el = document.querySelector(`.move-list .move[data-ply="${plyAfter}"]`);
    if (!el) return;
    let annotEl = el.querySelector(".move-annot");
    if (!annotEl) {
      annotEl = document.createElement("span");
      annotEl.className = "move-annot";
      const sanEl = el.querySelector(".move-san");
      if (sanEl && sanEl.nextSibling) {
        el.insertBefore(annotEl, sanEl.nextSibling);
      } else {
        el.appendChild(annotEl);
      }
    }
    const sac = wasBrilliantSacrifice(plyAfter);
    const tipping = isTippingPoint(plyAfter);

    // Annotation rule: show marks ONLY at tipping points or for brilliants.
    // Everything else relies on the subtle colored underline (best/inacc/
    // mistake/blunder) — present, unobtrusive, scannable without clutter.
    //   - "??" — blunder AT a tipping point (game outlook flipped)
    //   - "?"  — mistake AT a tipping point
    //   - "!!" — brilliant: engine-top move + ≥0.8-pawn sacrifice
    //   - 🔥   — only paired with "!!", never alone
    let mark = "";
    if (tipping && cls === "blunder")  mark = "??";
    else if (tipping && cls === "mistake") mark = "?";
    if (cls === "best" && sac) mark = "!!";

    annotEl.textContent = "";
    if (mark) {
      const markEl = document.createElement("span");
      markEl.className = "annot-mark";
      markEl.textContent = mark;
      annotEl.appendChild(markEl);
    }
    if (mark === "!!") {
      const fireEl = document.createElement("span");
      fireEl.className = "annot-fire";
      fireEl.textContent = "🔥";
      fireEl.title = "Brilliant — engine-top move with material sacrifice";
      annotEl.appendChild(fireEl);
    }
    annotEl.className = "move-annot" + (cls ? " " + cls : "");
  }

  function renderEvalBar(whiteEval, loading) {
    if (loading) {
      els.evalLoading.classList.remove("hidden");
    } else {
      els.evalLoading.classList.add("hidden");
    }

    if (!whiteEval) {
      els.evalBarFill.style.height = "50%";
      // Spinner overlay on the bar is the loading indicator — no text needed.
      els.evalNum.textContent = "—";
      els.evalNum.className = "eval-num";
      els.evalMeta.textContent = "";
      return;
    }
    const cp = whiteEval.cp;
    const clamped = Math.max(-1000, Math.min(1000, cp));
    const t = 1 / (1 + Math.exp(-clamped / 250)); // 0..1
    const pct = Math.round(t * 100);
    els.evalBarFill.style.height = pct + "%";

    const text = fmtEval(whiteEval);
    els.evalNum.textContent = text;
    let cls = "eval-num";
    if (whiteEval.mate !== undefined) cls += " mate";
    else if (cp >= 0) cls += " positive";
    else cls += " negative";
    els.evalNum.className = cls;
  }

  function renderEngineBlock(engineKey, ply, fen, sideToMove) {
    // engineKey: "sf" | "lc0"
    const isVisible = STATE.engineMode === "both"
      || (STATE.engineMode === "stockfish" && engineKey === "sf")
      || (STATE.engineMode === "lc0" && engineKey === "lc0");
    const block = engineKey === "sf" ? els.sfBlock : els.lc0Block;
    // In a user sideline, only SF analyzes the tip. Hide the Lc0 block
    // entirely so we don't show stale main-ply Lc0 data alongside the
    // sideline tip's SF result.
    const hidden = !isVisible || (inUserSideline() && engineKey === "lc0");
    block.classList.toggle("hidden", hidden);
    if (hidden) return;

    // Route analysis + loading to the sideline tip when applicable.
    let an, loading;
    if (inUserSideline() && engineKey === "sf") {
      an = STATE.variation.tipAnalysis;
      loading = !!STATE.variation.tipLoading;
    } else {
      an = STATE.analyses[ply] && STATE.analyses[ply][engineKey];
      loading = STATE.loading[ply] && STATE.loading[ply].has(engineKey);
    }
    // Eval bar / engine-head shows the engine's TOP eval (objective truth),
    // regardless of which line we elevate to "primary" in the body below.
    const we = evalFromWhite(an, sideToMove);

    const evalEl    = engineKey === "sf" ? els.sfEvalText  : els.lc0EvalText;
    const depthEl   = engineKey === "sf" ? els.sfEvalDepth : els.lc0EvalDepth;
    const bestEl    = engineKey === "sf" ? els.sfBestMove  : els.lc0BestMove;
    const lineEl    = engineKey === "sf" ? els.sfBestLine  : els.lc0BestLine;
    const statEl    = engineKey === "sf" ? els.sfStatus    : els.lc0Status;
    const moveLabel = engineKey === "sf" ? els.sfMoveLabel : els.lc0MoveLabel;
    const lineLabel = engineKey === "sf" ? els.sfLineLabel : els.lc0LineLabel;
    const sacBadge  = engineKey === "sf" ? els.sfSacBadge  : els.lc0SacBadge;
    const altBlock  = engineKey === "sf" ? els.sfAltBlock  : els.lc0AltBlock;
    const altMove   = engineKey === "sf" ? els.sfAltMove   : els.lc0AltMove;
    const altEval   = engineKey === "sf" ? els.sfAltEval   : els.lc0AltEval;

    evalEl.textContent = we ? fmtEval(we) : (loading ? "…" : "—");
    if (an && an.depth) {
      depthEl.textContent = `(d${an.depth}${an.nodes ? `, ${an.nodes.toLocaleString()}n` : ""})`;
    } else if (an && an.nodes) {
      depthEl.textContent = `(${an.nodes.toLocaleString()} nodes)`;
    } else {
      depthEl.textContent = "";
    }
    statEl.className = "engine-status" + (loading ? " analyzing" : "");
    statEl.textContent = "";
    statEl.setAttribute("aria-label", loading ? "Analyzing" : "");

    // Decide which line is the "primary" display.
    // Priority: chaos > creative > top.
    //   - chaos wins because it's the more aggressive mode (deliberately
    //     unsound for practical fighting chances)
    //   - creative is next (sound sacrifice within tighter tolerance)
    //   - top is the engine's objective best when no pick fires
    // Off-top picks only apply when the side-to-move is the user's side —
    // we don't suggest creative/chaos moves for the opponent.
    const top = an && an.candidates && an.candidates[0];
    const forUser = sideOfFen(fen) === userSide();
    const chaos = (STATE.chaosMode && an && forUser)
      ? pickChaosCandidate(an, fen, STATE.chaosThresholdCp)
      : null;
    const creative = (!chaos && STATE.creativeMode && an && forUser)
      ? pickCreativeCandidate(an, fen, STATE.creativeThresholdCp)
      : null;
    const usingChaos    = !!chaos;
    const usingCreative = !!creative;
    const primary = usingChaos ? chaos.candidate
                  : usingCreative ? creative.candidate
                  : top;

    // Label / badge / highlight class
    block.classList.toggle("creative", usingCreative);
    block.classList.toggle("chaos",    usingChaos);
    if (usingChaos) {
      moveLabel.textContent = "Chaos move:";
      lineLabel.textContent = "Chaos line:";
    } else if (usingCreative) {
      moveLabel.textContent = "Creative move:";
      lineLabel.textContent = "Creative line:";
    } else {
      moveLabel.textContent = "Best move:";
      lineLabel.textContent = "Best line:";
    }
    if (usingChaos) {
      // Compact breakdown badge: "3✕ 2+ −0.6♟ (−40cp)" =
      // 3 captures, 2 checks, ~0.6 pawn sacrifice in PV, 40cp eval cost.
      const parts = [];
      if (chaos.captures) parts.push(`${chaos.captures}✕`);
      if (chaos.checks)   parts.push(`${chaos.checks}+`);
      if (chaos.materialDelta < -20) {
        const pawns = Math.abs(chaos.materialDelta) / 100;
        parts.push(`−${pawns.toFixed(pawns >= 1 ? 1 : 2)}♟`);
      }
      if (chaos.cpLoss > 5) parts.push(`−${Math.round(chaos.cpLoss)}cp`);
      sacBadge.textContent = parts.join(" ");
      sacBadge.classList.remove("hidden");
    } else if (usingCreative) {
      const pawns = Math.abs(creative.materialDelta) / 100;
      sacBadge.textContent = `sacrifices ${pawns.toFixed(pawns >= 1 ? 1 : 2)}♟`;
      sacBadge.classList.remove("hidden");
    } else {
      sacBadge.classList.add("hidden");
    }

    // Render primary best-move + best-line as clickable PVs
    renderClickablePV(bestEl, fen, primary && primary.bestMove ? [primary.bestMove] : null, ply, engineKey, loading);
    renderClickablePV(lineEl, fen, primary && primary.pv && primary.pv.length ? primary.pv.slice(0, 8) : null, ply, engineKey, loading);

    // Alt block: when chaos OR creative is the primary, show the engine's
    // TOP line below so the user can compare the off-axis pick against the
    // objective best.
    if ((usingChaos || usingCreative) && top) {
      altBlock.classList.remove("hidden");
      renderClickablePV(altMove, fen, top.bestMove ? [top.bestMove] : null, ply, engineKey, false);
      const topW = evalFromWhite(top, sideToMove);
      altEval.textContent = topW ? `(${fmtEval(topW)})` : "";
    } else {
      altBlock.classList.add("hidden");
    }

    // Candidate alternatives — up to 3 non-primary candidates with their
    // eval and clickable PV. Helps the user compare lines without
    // toggling modes.
    renderCandidatesList(engineKey, ply, fen, sideToMove, an, primary);
  }

  /** Render the compact list of alternative candidate lines under the
   *  primary "Best line:" display. Skips the primary itself, caps at 3
   *  rows (4 lines total in view when including primary), and shows ~6
   *  plies of each PV via the existing clickable-PV machinery so each
   *  move is a board-jumpable chip. */
  function renderCandidatesList(engineKey, ply, fen, sideToMove, an, primary) {
    const wrap = engineKey === "sf" ? els.sfCandidates    : els.lc0Candidates;
    const list = engineKey === "sf" ? els.sfCandidatesRows : els.lc0CandidatesRows;
    if (!wrap || !list) return;
    list.innerHTML = "";

    const candidates = (an && an.candidates) || [];
    if (candidates.length < 2 || !primary || !primary.bestMove) {
      wrap.classList.add("hidden");
      return;
    }
    // Filter to non-primary candidates and cap at 3.
    const primaryUci = primary.bestMove;
    const others = candidates.filter((c) => c.bestMove && c.bestMove !== primaryUci).slice(0, 3);
    if (!others.length) {
      wrap.classList.add("hidden");
      return;
    }

    others.forEach((c, idx) => {
      const li = document.createElement("li");
      li.className = "cand-row";

      // Rank chip — actual position in the engine's MultiPV ranking
      // (not the index in `others`, which skipped the primary).
      const origRank = candidates.indexOf(c) + 1;
      const rankEl = document.createElement("span");
      rankEl.className = "cand-rank";
      rankEl.textContent = `#${origRank}`;
      li.appendChild(rankEl);

      // Eval chip — White-perspective so the sign matches the eval bar.
      const we = evalFromWhite(c, sideToMove);
      const evalEl = document.createElement("span");
      evalEl.className = "cand-eval";
      if (we) {
        evalEl.textContent = fmtEval(we);
        if (we.mate !== undefined)      evalEl.classList.add("mate");
        else if (we.cp >= 0)             evalEl.classList.add("positive");
        else                              evalEl.classList.add("negative");
      } else {
        evalEl.textContent = "—";
      }
      li.appendChild(evalEl);

      // PV — clickable chips, capped at 6 plies for compactness.
      const lineEl = document.createElement("span");
      lineEl.className = "cand-line";
      renderClickablePV(lineEl, fen, c.pv ? c.pv.slice(0, 6) : null, ply, engineKey, false);
      li.appendChild(lineEl);

      list.appendChild(li);
    });
    wrap.classList.remove("hidden");
  }

  /** Render a PV as a sequence of clickable .pv-move spans. Clicking a move
   *  jumps the board to the hypothetical position after that move. The move
   *  currently being previewed (if any) is highlighted with .active. */
  function renderClickablePV(el, fen, uciMoves, basePly, engineKey, loading) {
    el.innerHTML = "";
    el.classList.add("pv-line");
    if (!uciMoves || !uciMoves.length) {
      el.textContent = loading ? "…" : "—";
      return;
    }
    const moves = uciLineToMoves(fen, uciMoves);
    if (!moves.length) {
      el.textContent = "—";
      return;
    }
    const active = STATE.variation;
    const fullPvUci = moves.map((x) => x.uci);
    moves.forEach((m, idx) => {
      const span = document.createElement("span");
      span.className = "pv-move";
      span.textContent = m.san;
      // Highlight this move if the current variation is displaying it —
      // the variation's currentPly matches this move's position in the PV
      // AND the variation's first currentPly UCIs match this PV's prefix.
      // Comparing the prefix (not the whole stored PV) makes the highlight
      // robust if the user is viewing a partial advancement of a longer PV.
      if (
        active
        && active.basePly === basePly
        && active.currentPly === idx + 1
        && active.moves.length >= idx + 1
        && fullPvUci.slice(0, idx + 1).every((u, i) => u === active.moves[i])
      ) {
        span.classList.add("active");
      }
      span.addEventListener("click", () => {
        // Enter the FULL PV (so arrow keys can step further), but display
        // up to the move the user actually clicked.
        enterVariation(basePly, fullPvUci, engineKey, idx + 1);
      });
      el.appendChild(span);
      if (idx < moves.length - 1) el.appendChild(document.createTextNode(" "));
    });
  }

  /** Show a hypothetical position derived from playing `uciMoves` from
   *  STATE.positions[basePly]. Board updates; the actual game state isn't
   *  changed — STATE.ply stays where it is.
   *
   *  `uciMoves` is the FULL line (PV) for the variation. `currentPly` —
   *  optional, defaults to the end — controls which point along the line
   *  is initially displayed. Keeping the full line in STATE.variation lets
   *  arrow keys step forward and backward through it without exiting. */
  function enterVariation(basePly, uciMoves, engineKey, currentPly) {
    if (!uciMoves || !uciMoves.length) return;
    const moves = uciLineToMoves(STATE.positions[basePly], uciMoves);
    if (!moves.length) return;
    const cp = Math.max(1, Math.min(moves.length,
      typeof currentPly === "number" ? currentPly : moves.length));
    STATE.variation = {
      basePly,
      moves: moves.map((m) => m.uci),
      currentPly: cp,
      fenAfter: moves[cp - 1].fenAfter,
      engine: engineKey || null,
      source: "engine",
    };
    STATE.boardObj.position(STATE.variation.fenAfter, true);
    els.variationBanner.classList.remove("hidden");
    document.getElementById("board").classList.add("in-variation");
    updateVariationBanner();
    // Re-render so the active PV move highlights.
    renderMoveInfo();
  }

  function exitVariation() {
    if (!STATE.variation) return;
    const wasUser = STATE.variation.source === "user";
    // Cancel any in-flight sideline tip analyses so they don't supersede
    // the main-ply analysis we're about to re-trigger.
    if (wasUser) {
      const v = STATE.variation;
      if (v.tipCancel)    { try { v.tipCancel();    } catch (_) {} }
      if (v.tipOppCancel) { try { v.tipOppCancel(); } catch (_) {} }
    }
    // STATE.savedSideline intentionally stays — the user can re-enter
    // their sideline via the move-list row.
    STATE.variation = null;
    els.variationBanner.classList.add("hidden");
    document.getElementById("board").classList.remove("in-variation");
    STATE.boardObj.position(STATE.positions[STATE.ply], true);
    renderMoveInfo();
    renderMoveList(); // refresh — sideline row stays but no longer "active"
    // Sideline tip analysis preempted the main-ply analysis when we
    // entered it. Retrigger so the main ply gets re-analyzed if needed.
    if (wasUser) analyzeCurrent();
  }

  // ---------- Plan-arrow overlay ----------
  //
  // Color by PLAN-OWNER (not move-maker), so a cluster of same-colored arrows
  // visually reads as "this is White's plan" or "this is Black's plan".
  // Within each cluster, numbered badges (1..N) show ply order — and later
  // plies fade so the immediate plan stands out.
  const PLAN_COLORS = {
    white: "#f97316", // orange-500
    black: "#0ea5e9", // sky-500
  };
  const SVG_NS = "http://www.w3.org/2000/svg";

  /** Pixel coordinates of the center of a board square (e.g. "e4"),
   *  relative to .board-arrow-wrap so they line up with the SVG overlay.
   *  Returns null if the square element doesn't exist yet (e.g. during
   *  initial board build). Also returns the square pixel size for scaling. */
  function squareCenter(square) {
    if (!els.boardArrowWrap) return null;
    const sqEl = els.boardArrowWrap.querySelector(`.square-${square}`);
    if (!sqEl) return null;
    const sqRect = sqEl.getBoundingClientRect();
    const wrapRect = els.boardArrowWrap.getBoundingClientRect();
    return {
      x: sqRect.left - wrapRect.left + sqRect.width / 2,
      y: sqRect.top  - wrapRect.top  + sqRect.height / 2,
      sz: sqRect.width,
    };
  }

  // Mate-sequence color overrides — gold when delivering, red when being mated.
  const MATE_COLOR_DELIVERING = "#fbbf24";
  const MATE_COLOR_LOSING     = "#ef4444";
  const MATE_PLY_CAP          = 8;

  /** Draw arrows for the first N plies of a PV starting from `fromFen`.
   *  `plannerSide` ("white" | "black") drives the color — used both as
   *  semantic ("this is X's plan") and visual identity.
   *  `opts.creative` switches the visual to "sacrifice line": dashed stem
   *  + the first-ply badge becomes 🔥 instead of "1".
   *  `opts.mate` (signed integer, plies until mate from planner's POV) puts
   *  the cluster into "mate sequence" mode: all plies drawn (defender's
   *  moves are forced and informative), gold/red recolor, last badge "#". */
  function drawPlanArrows(svg, fromFen, uciPv, plannerSide, opts) {
    const baseColor = PLAN_COLORS[plannerSide];
    const creative = !!(opts && opts.creative);
    const chaos    = !!(opts && opts.chaos);
    const mateScore = opts && opts.mate;
    const isMate = mateScore != null && mateScore !== 0;
    // Pick the rendering color:
    //   - mate delivering → gold
    //   - mate being received → red
    //   - non-mate → planner's team color
    const color = isMate
      ? (mateScore > 0 ? MATE_COLOR_DELIVERING : MATE_COLOR_LOSING)
      : baseColor;
    const moves = uciLineToMoves(fromFen, uciPv);

    // PV iteration mode:
    //   - Mate: every ply is forced and worth drawing (both sides).
    //   - Otherwise: only the PLANNER's own moves (even-indexed plies).
    //     Opponent replies live in the OTHER cluster from the null-move PV.
    let displayed;
    let cap;
    if (isMate) {
      displayed = moves;
      cap = Math.min(moves.length, MATE_PLY_CAP);
    } else {
      const ownMoves = [];
      for (let j = 0; j < moves.length; j += 2) ownMoves.push(moves[j]);
      displayed = ownMoves;
      cap = Math.min(ownMoves.length, STATE.planPlies);
    }
    const n = cap;
    for (let i = 0; i < n; i++) {
      const uci = displayed[i].uci;
      const a = squareCenter(uci.slice(0, 2));
      const b = squareCenter(uci.slice(2, 4));
      if (!a || !b) continue;

      // Direction + geometry
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const ux = dx / len, uy = dy / len;

      // Pull back the arrow's end so the head doesn't bury into the
      // destination piece. ~35% of one square works well visually.
      const back = a.sz * 0.30;
      const endX = b.x - ux * back;
      const endY = b.y - uy * back;

      // Fade later plies: ply 1 = 1.0, ply 2 = 0.78, ply 3 = 0.6, ply 4 = 0.46
      const opacity = Math.max(0.35, 1 - i * 0.22);
      const strokeW = Math.max(5, a.sz * 0.13);

      // Stem — dashed for creative/sacrifice lines so they read as "non-
      // objective, risky path" at a glance, distinct from solid top-PV arrows.
      // For mate sequences we bump stroke a bit thicker to communicate
      // "this is a force, not a plan".
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", a.x);
      line.setAttribute("y1", a.y);
      line.setAttribute("x2", endX);
      line.setAttribute("y2", endY);
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", isMate ? strokeW * 1.1 : strokeW);
      line.setAttribute("opacity", opacity * (isMate ? 0.95 : 0.85));
      line.setAttribute("class", "arrow-path");
      if (chaos && !isMate) {
        // Denser, more irregular dot-dash pattern for chaos — visually
        // distinct from creative's clean long-dash pattern.
        line.setAttribute("stroke-dasharray",
          `${strokeW * 0.6} ${strokeW * 0.55} ${strokeW * 1.4} ${strokeW * 0.55}`);
      } else if (creative && !isMate) {
        // Dash length / gap scale with stroke so the pattern reads at any zoom.
        line.setAttribute("stroke-dasharray", `${strokeW * 1.8} ${strokeW * 0.95}`);
      }
      svg.appendChild(line);

      // Arrowhead: filled triangle pointing at the destination square.
      const headLen = strokeW * 1.9;
      const headHalfWidth = strokeW * 1.1;
      const tipX = endX + ux * (headLen * 0.6);
      const tipY = endY + uy * (headLen * 0.6);
      const baseX = endX - ux * (headLen * 0.4);
      const baseY = endY - uy * (headLen * 0.4);
      const px = -uy, py = ux; // perpendicular unit vector
      const leftX  = baseX + px * headHalfWidth;
      const leftY  = baseY + py * headHalfWidth;
      const rightX = baseX - px * headHalfWidth;
      const rightY = baseY - py * headHalfWidth;
      const tri = document.createElementNS(SVG_NS, "polygon");
      tri.setAttribute("points",
        `${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`);
      tri.setAttribute("fill", color);
      tri.setAttribute("opacity", opacity * 0.95);
      svg.appendChild(tri);

      // Numbered badge — placed ~28% along the arrow from the source so it
      // sits in open air rather than over the piece on the source square.
      const t = 0.30;
      const bx = a.x + dx * t;
      const by = a.y + dy * t;
      const r = Math.max(8, a.sz * 0.17);
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", bx);
      circle.setAttribute("cy", by);
      circle.setAttribute("r", r);
      circle.setAttribute("fill", color);
      circle.setAttribute("class", "arrow-badge-circle");
      circle.setAttribute("opacity", opacity);
      svg.appendChild(circle);

      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", bx);
      text.setAttribute("y", by);
      text.setAttribute("opacity", opacity);
      // Badge content priority (decreasing):
      //   1. Mate sequence's final ply → "#" (checkmate notation)
      //   2. Chaos line's first ply → 🌀 (deliberately unsound, hard to defend)
      //   3. Creative line's first ply → 🔥 (sound sacrifice)
      //   4. Default → sequence number 1..N
      const isLastMatePly = isMate && i === n - 1;
      if (isLastMatePly) {
        text.setAttribute("font-size", String(r * 1.5));
        text.setAttribute("class", "arrow-badge-text");
        text.textContent = "#";
      } else if (chaos && i === 0) {
        text.setAttribute("font-size", String(r * 1.4));
        text.setAttribute("class", "arrow-badge-emoji");
        text.textContent = "🌀";
      } else if (creative && i === 0) {
        text.setAttribute("font-size", String(r * 1.4));
        text.setAttribute("class", "arrow-badge-emoji");
        text.textContent = "🔥";
      } else {
        text.setAttribute("font-size", String(r * 1.25));
        text.setAttribute("class", "arrow-badge-text");
        text.textContent = String(i + 1);
      }
      svg.appendChild(text);
    }
  }

  /** Top-level render for the plan arrow overlay. Clears the SVG, sizes it
   *  to the board, then draws each side's plan. Safe to call repeatedly. */
  function renderPlanArrows() {
    const svg = els.planArrows;
    if (!svg || !els.boardArrowWrap) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const wrapRect = els.boardArrowWrap.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${wrapRect.width} ${wrapRect.height}`);
    svg.setAttribute("width",  wrapRect.width);
    svg.setAttribute("height", wrapRect.height);

    // Engine variations (read-only PV previews) hide plan arrows entirely —
    // the displayed board doesn't have its own analysis. User sidelines
    // DO have their own tip analysis, so arrows are drawn for those. The
    // annotation overlay (drawn at the end of this function) doesn't share
    // these constraints — it's tied to the actual game ply, not to plans.
    const drawPlans =
      STATE.showPlans
      && !(STATE.variation && STATE.variation.source !== "user");
    if (!drawPlans) {
      drawAnnotationOverlay(svg);
      return;
    }

    const ply = STATE.ply;
    const fen = currentDisplayedFen();
    if (!fen) return;
    const sideToMove = sideOfFen(fen) === "w" ? "white" : "black";
    const oppSide    = sideToMove === "white" ? "black" : "white";

    // Pick the PV to draw for a given analysis, prioritizing chaos →
    // creative → top, matching renderEngineBlock's primary-line choice.
    // Off-top picks (chaos/creative) only fire for the USER's side — for
    // the opponent we just show the top PV. Returns { pv, mate, creative, chaos }.
    function chooseClusterLine(an, fromFen) {
      let pv = an.pv;
      let mate = an.mate;
      let creative = false, chaos = false;
      const forUser = sideOfFen(fromFen) === userSide();
      if (forUser) {
        if (STATE.chaosMode) {
          const pick = pickChaosCandidate(an, fromFen, STATE.chaosThresholdCp);
          if (pick) {
            pv = pick.candidate.pv;
            mate = pick.candidate.mate;
            chaos = true;
          }
        }
        if (!chaos && STATE.creativeMode) {
          const pick = pickCreativeCandidate(an, fromFen, STATE.creativeThresholdCp);
          if (pick) {
            pv = pick.candidate.pv;
            mate = pick.candidate.mate;
            creative = true;
          }
        }
      }
      return { pv, mate, creative, chaos };
    }

    // Source the analyses from the sideline tip when in a user
    // sideline, otherwise from the main-ply analysis arrays.
    const myAn = inUserSideline()
      ? STATE.variation.tipAnalysis
      : (STATE.analyses[ply] && STATE.analyses[ply].sf);
    const oppAn = inUserSideline()
      ? STATE.variation.tipOppAnalysis
      : (STATE.opponentAnalyses[ply] && STATE.opponentAnalyses[ply].sf);

    if (myAn && myAn.pv && myAn.pv.length) {
      const choice = chooseClusterLine(myAn, fen);
      drawPlanArrows(svg, fen, choice.pv, sideToMove, choice);
    }
    if (oppAn && oppAn.pv && oppAn.pv.length) {
      const nmFen = nullMoveFen(fen);
      if (nmFen) {
        const choice = chooseClusterLine(oppAn, nmFen);
        drawPlanArrows(svg, nmFen, choice.pv, oppSide, choice);
      }
    }

    // Annotation overlay drawn LAST so it sits on top of any plan arrows.
    drawAnnotationOverlay(svg);
  }

  /** Annotation overlay — when viewing a real game ply that has a notable
   *  mark (??/?/!!) in the move list, mirror the mark on the board so it's
   *  obvious WHICH piece the notation refers to. For mistake/blunder marks
   *  we additionally draw a teal "should-have-played" arrow from the
   *  engine's best move at the predecessor position. */
  function drawAnnotationOverlay(svg) {
    // Only meaningful when we're on a real game ply. Engine PV previews
    // and user sidelines show hypothetical positions, so a "current move
    // was good/bad" verdict doesn't apply.
    if (STATE.variation) return;
    const ply = STATE.ply;
    if (ply < 1) return;
    const mv = STATE.moves[ply - 1];
    if (!mv) return;

    const info = computeAnnotationMark(ply);
    if (!info) return;

    // "Should-have-played" arrow — only for mistake/blunder, only when we
    // have a predecessor-position best move to point at, and only when
    // the engine's best move differs from the move actually played
    // (otherwise the arrow would just retrace the move we're annotating).
    if (info.cls === "mistake" || info.cls === "blunder") {
      const prevEntry = STATE.analyses[ply - 1] || {};
      const prevAn = prevEntry.sf || prevEntry.lc0;
      if (prevAn && prevAn.bestMove) {
        const bestUci = prevAn.bestMove;
        const playedUci = mv.from + mv.to + (mv.promotion || "");
        if (bestUci.slice(0, 4) !== playedUci.slice(0, 4)) {
          const a = squareCenter(bestUci.slice(0, 2));
          const b = squareCenter(bestUci.slice(2, 4));
          if (a && b) drawShouldHaveArrow(svg, a, b);
        }
      }
    }

    // Annotation badge on the destination of the move that was played.
    const dst = squareCenter(mv.to);
    if (dst) drawAnnotationBadge(svg, dst, info);
  }

  /** Same rules as updateMoveListAnnotation, factored out so the on-board
   *  badge stays in lockstep with the move-list chip. Returns
   *  { mark, cls, brilliant } or null. */
  function computeAnnotationMark(plyAfter) {
    if (plyAfter < 1) return null;
    const cls = computeClassification(plyAfter);
    if (!cls) return null;
    const sac = wasBrilliantSacrifice(plyAfter);
    const tipping = isTippingPoint(plyAfter);
    if (cls === "best" && sac) return { mark: "!!", cls: "best", brilliant: true };
    if (tipping && cls === "blunder")  return { mark: "??", cls: "blunder" };
    if (tipping && cls === "mistake")  return { mark: "?",  cls: "mistake" };
    return null;
  }

  // Annotation badge colors — match the move-list chip palette so the two
  // indicators read as "the same mark, on two surfaces."
  const ANNOT_BADGE_COLOR = {
    blunder: "#ef4444",   // var(--bad)
    mistake: "#ff9a4a",
    best:    "#7ed3a4",   // var(--good) — brilliants
  };
  const SHOULD_HAVE_COLOR = "#14b8a6"; // teal — distinct from plan-arrow palette

  /** Draw the small "??" / "?" / "!!" badge in the top-right corner of the
   *  destination square. Lichess places these in the same spot so the
   *  visual idiom is familiar. The piece on the square remains fully
   *  visible — the badge only covers a corner. */
  function drawAnnotationBadge(svg, center, info) {
    const sz = center.sz;
    // Anchor in the top-right corner of the square. y is screen-space
    // (down is positive), so "top" means subtract.
    const cx = center.x + sz * 0.30;
    const cy = center.y - sz * 0.30;
    const r  = sz * 0.20;
    const color = ANNOT_BADGE_COLOR[info.cls] || "#94a3b8";

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "annot-overlay");

    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r",  String(r));
    circle.setAttribute("fill", color);
    circle.setAttribute("stroke", "rgba(15, 17, 21, 0.85)");
    circle.setAttribute("stroke-width", "1.5");
    g.appendChild(circle);

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(cx));
    text.setAttribute("y", String(cy));
    // "??" / "?" / "!!" — letter-spacing tightens "??" so it doesn't bleed
    // outside the circle. Bigger font for single-char "?" looks cleaner.
    const fontPx = info.mark.length > 1 ? r * 1.3 : r * 1.6;
    text.setAttribute("font-size", String(fontPx));
    text.setAttribute("fill", "#0f1115");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("font-weight", "800");
    text.textContent = info.mark;
    g.appendChild(text);

    // 🔥 to the right of the circle for brilliant moves — matches the
    // move-list rendering. Sits outside the circle so the "!!" stays
    // legible.
    if (info.brilliant) {
      const fire = document.createElementNS(SVG_NS, "text");
      fire.setAttribute("x", String(cx + r * 1.8));
      fire.setAttribute("y", String(cy));
      fire.setAttribute("font-size", String(r * 1.7));
      fire.setAttribute("text-anchor", "middle");
      fire.setAttribute("dominant-baseline", "central");
      fire.textContent = "🔥";
      g.appendChild(fire);
    }
    svg.appendChild(g);
  }

  /** Teal arrow from the engine's preferred move (predecessor position).
   *  Sits on top of any plan arrows so the "what to play instead" cue
   *  isn't obscured. Also drops a soft ring on the destination square to
   *  highlight the target piece. */
  function drawShouldHaveArrow(svg, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const ux = dx / len, uy = dy / len;
    const sz = a.sz;
    // Pull the line back from the destination center so the arrowhead
    // sits clear of the piece.
    const pullBack = sz * 0.40;
    const endX = b.x - ux * pullBack;
    const endY = b.y - uy * pullBack;
    const w = Math.max(6, sz * 0.14);

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "annot-should-have");

    // Destination ring — highlights the piece that should have moved/gone.
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", String(b.x));
    ring.setAttribute("cy", String(b.y));
    ring.setAttribute("r", String(sz * 0.42));
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", SHOULD_HAVE_COLOR);
    ring.setAttribute("stroke-width", "3");
    ring.setAttribute("opacity", "0.75");
    g.appendChild(ring);

    // Arrow shaft.
    const line = document.createElementNS(SVG_NS, "path");
    line.setAttribute("d", `M ${a.x} ${a.y} L ${endX} ${endY}`);
    line.setAttribute("stroke", SHOULD_HAVE_COLOR);
    line.setAttribute("stroke-width", String(w));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("fill", "none");
    line.setAttribute("opacity", "0.85");
    g.appendChild(line);

    // Arrowhead.
    const headSize = w * 2.0;
    const angle = Math.atan2(uy, ux);
    const p1x = b.x - ux * (sz * 0.18);
    const p1y = b.y - uy * (sz * 0.18);
    const p2x = p1x - headSize * Math.cos(angle - Math.PI / 6);
    const p2y = p1y - headSize * Math.sin(angle - Math.PI / 6);
    const p3x = p1x - headSize * Math.cos(angle + Math.PI / 6);
    const p3y = p1y - headSize * Math.sin(angle + Math.PI / 6);
    const head = document.createElementNS(SVG_NS, "polygon");
    head.setAttribute("points", `${p1x},${p1y} ${p2x},${p2y} ${p3x},${p3y}`);
    head.setAttribute("fill", SHOULD_HAVE_COLOR);
    head.setAttribute("opacity", "0.95");
    g.appendChild(head);

    svg.appendChild(g);
  }

  /** Drive the Deep dive button label / enabled state. Three modes:
   *    - Hidden: SF isn't in the active engine list, or engine isn't ready.
   *    - "🔍 Deep dive" enabled: current SF analysis exists but is below the
   *      deep depth, OR no analysis yet but engine is ready.
   *    - "✓ Deep" disabled: SF analysis for this ply is already at deep
   *      depth (no further analysis would change anything). */
  function updateDeepDiveButton() {
    if (!els.deepDive) return;
    const sfActive = STATE.engineReady && engineList().includes("sf");
    // Hide while in a user sideline — Deep Dive's classification-pairing
    // logic depends on a chain of main-ply analyses we don't have in
    // sideline mode.
    if (!sfActive || inUserSideline()) {
      els.deepDive.classList.add("hidden");
      return;
    }
    els.deepDive.classList.remove("hidden");
    const base = clampDepth(+els.depth.value || 16);
    const deepDepth = deepDepthFor(base);
    const an = STATE.analyses[STATE.ply] && STATE.analyses[STATE.ply].sf;
    const loadingNow = STATE.loading[STATE.ply] && STATE.loading[STATE.ply].has("sf");
    if (an && an.depth >= deepDepth) {
      els.deepDive.disabled = true;
      els.deepDive.classList.add("is-deep");
      els.deepDive.textContent = `✓ d${an.depth}`;
    } else if (loadingNow) {
      els.deepDive.disabled = true;
      els.deepDive.classList.remove("is-deep");
      els.deepDive.textContent = "Analyzing…";
    } else {
      els.deepDive.disabled = false;
      els.deepDive.classList.remove("is-deep");
      els.deepDive.textContent = `🔍 Deep dive (d${deepDepth})`;
    }
  }

  function primaryAnalysisFor(ply) {
    // Used for eval bar + move classification. Prefer SF; fall back to Lc0.
    // When the user is viewing a sideline, the eval bar should reflect the
    // SIDELINE TIP, not the main ply — Lc0 isn't analyzed in sidelines so
    // we just return the SF tip analysis (which may be null while loading).
    if (inUserSideline()) return STATE.variation.tipAnalysis || null;
    const a = STATE.analyses[ply];
    if (!a) return null;
    return a.sf || a.lc0 || null;
  }

  function renderMoveInfo() {
    const ply = STATE.ply;
    // In a user sideline the displayed position is the sideline tip.
    const fen = currentDisplayedFen();
    const sideToMove = sideOfFen(fen);
    els.sideToMove.textContent = sideToMove === "w" ? "White" : "Black";

    if (STATE.variation) {
      const v = STATE.variation;
      const label = v.source === "user" ? "Sideline" : "Engine line";
      els.curMove.textContent = `${label} ply ${v.currentPly}/${v.moves.length}`;
    } else if (ply === 0) {
      els.curMove.textContent = "Starting position";
    } else {
      const mv = STATE.moves[ply - 1];
      const fullMoveNum = Math.ceil(ply / 2);
      const dots = mv.color === "w" ? "" : "…";
      els.curMove.textContent = `${fullMoveNum}${dots} ${mv.san}`;
    }

    // Eval bar reflects the displayed position. In sideline mode the
    // loading flag comes from the sideline tip's analyzer; otherwise
    // from the per-ply loading set.
    const primary = primaryAnalysisFor(ply);
    const we = evalFromWhite(primary, sideToMove);
    const anyLoading = inUserSideline()
      ? !!STATE.variation.tipLoading
      : (STATE.loading[ply] && STATE.loading[ply].size > 0);
    renderEvalBar(we, !primary && anyLoading);

    renderEngineBlock("sf", ply, fen, sideToMove);
    renderEngineBlock("lc0", ply, fen, sideToMove);
    renderPlanArrows();
    updateDeepDiveButton();

    // Classification (uses SF if available, else Lc0). Suppressed while
    // viewing a sideline — we don't have a chain of sideline-ply analyses
    // to compute eval-loss against.
    els.classification.className = "line classification";
    els.classification.textContent = "";
    if (!inUserSideline() && ply > 0) {
      const cls = computeClassification(ply);
      if (cls) {
        els.classification.classList.add(cls);
        els.classification.textContent = classificationLabel(cls);
        applyClassificationToMoveEl(ply, cls);
      }
    }

    // Eval timeline updates alongside the rest of the move-info panel —
    // active-dot tracking, newly-arrived analyses, classification marks.
    renderEvalChart();
  }

  function computeClassification(plyAfter) {
    // Pick the same engine for both ply-1 and plyAfter (SF preferred).
    const prev = STATE.analyses[plyAfter - 1] || {};
    const cur  = STATE.analyses[plyAfter] || {};
    let engineKey = null;
    if (prev.sf && cur.sf) engineKey = "sf";
    else if (prev.lc0 && cur.lc0) engineKey = "lc0";
    if (!engineKey) return null;
    const prevAn = prev[engineKey];
    const curAn  = cur[engineKey];
    const prevFen = STATE.positions[plyAfter - 1];
    const curFen  = STATE.positions[plyAfter];
    const prevSide = prevFen.split(" ")[1];
    const curSide  = curFen.split(" ")[1];
    const prevWhite = evalFromWhite(prevAn, prevSide);
    const curWhite  = evalFromWhite(curAn, curSide);
    const wasBest = movesEqual(prevAn.bestMove, STATE.moves[plyAfter - 1]);
    return classifyMove(prevWhite, curWhite, prevSide, wasBest);
  }

  function movesEqual(uci, verboseMove) {
    if (!uci || !verboseMove) return false;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci.length > 4 ? uci[4] : undefined;
    return verboseMove.from === from
      && verboseMove.to === to
      && (verboseMove.promotion || undefined) === promo;
  }

  // ---------- Navigation ----------

  function goToPly(ply) {
    ply = Math.max(0, Math.min(STATE.positions.length - 1, ply));
    // Any "navigate to a real ply" exits any active variation preview.
    // Engine variations are discarded; user sidelines stay alive in
    // STATE.savedSideline (the sideline row in the move list remains
    // clickable to re-enter).
    if (STATE.variation) {
      if (STATE.variation.source === "user") {
        // Cancel in-flight tip analyses so they don't supersede the
        // main-ply analysis we're about to re-trigger.
        const v = STATE.variation;
        if (v.tipCancel)    { try { v.tipCancel();    } catch (_) {} }
        if (v.tipOppCancel) { try { v.tipOppCancel(); } catch (_) {} }
      }
      STATE.variation = null;
      els.variationBanner.classList.add("hidden");
      document.getElementById("board").classList.remove("in-variation");
    }
    STATE.ply = ply;
    STATE.boardObj.position(STATE.positions[ply], true);
    highlightCurrentMove();
    renderMoveInfo();
    renderMoveList(); // refresh so the saved sideline row's active state clears
    cancelStaleAnalyses(ply);
    analyzeCurrent();
  }

  // ---------- Analysis driver ----------

  // Absolute clamp covers both the user knob (HTML max=22) and the
  // deep-dive override (up to base+6, capped at 28).
  function clampDepth(d) { return Math.max(8, Math.min(28, d | 0)); }

  // Deep-dive parameters: re-analyze critical positions at base depth + 6,
  // capped at 24 to keep the wait reasonable (~5–15s for most positions at
  // d24). Bumping further hits diminishing returns + long user-wait.
  const DEEP_BONUS = 6;
  const DEEP_CAP = 24;
  function deepDepthFor(base) {
    return Math.min(DEEP_CAP, clampDepth(base) + DEEP_BONUS);
  }

  // Stockfish: check the server-side analysis cache first; if the position
  // has been analyzed at >= this depth before, return the cached result
  // immediately. Otherwise run the worker, then asynchronously persist the
  // result to the cache so future visits to this position are free.
  //
  // depthOverride: pass an explicit depth (used by the deep-dive button) to
  // bypass the user-controlled base depth knob. Cache key naturally
  // includes depth, so deeper requests miss the shallower cached entry and
  // write a new deeper one — and future visits to the same FEN benefit.
  function startSfAnalysis(fen, depthOverride) {
    const depth = depthOverride != null
      ? clampDepth(depthOverride)
      : clampDepth(+els.depth.value || 16);
    // Dynamic MultiPV: wider candidate net only when chaos mode is on AND
    // this position's side-to-move is the user's side. Cache keys on
    // multipv so switching modes either hits (mode→narrower) or misses
    // (mode→wider).
    const multipv = sfMultiPv(fen);
    let cancelled = false;
    const promise = (async () => {
      // 1. Try cache
      try {
        const params = new URLSearchParams({
          engine: "sf18", fen, limit_type: "depth",
          limit_value: String(depth), multipv: String(multipv),
        });
        const res = await fetch("/api/cache?" + params.toString());
        if (cancelled) throw new Error("cancelled");
        if (res.ok) {
          const data = await res.json();
          if (data && data.hit && data.result) {
            return { ...data.result, cached: true };
          }
        }
      } catch (e) {
        if (cancelled) throw e;
        // Cache lookup failed — fall through to running the worker.
      }
      // 2. Cache miss → run the worker (at the requested MultiPV width).
      const result = await STATE.engine.analyze(fen, depth, multipv);
      // 3. Fire-and-forget cache write (don't block the UI on this)
      fetch("/api/cache", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: "sf18", fen, limit_type: "depth",
          limit_value: depth, multipv,
          result,
        }),
      }).catch(() => {});
      return result;
    })();
    return {
      promise,
      cancel: () => {
        cancelled = true;
        STATE.engine.cancel();
      },
    };
  }

  // Lc0 (server-side): use AbortController for both the timeout and external
  // cancellation (e.g. user navigated to a different ply). Returns
  // { promise, cancel } so the caller can interrupt mid-flight.
  function startLc0Analysis(fen) {
    const depth = clampDepth(+els.depth.value || 16);
    // SF depth knob → Lc0 thinktime. Tuned for "click + wait" UX:
    //   depth 8 → 0.5s, 12 → 1.5s, 16 → 3.0s (default), 20 → 5.5s, 22 → 7s (capped)
    const movetime_ms = Math.min(7000, Math.round((depth - 7) * 350));

    const controller = new AbortController();
    // Hard timeout in case the server hangs.
    const timer = setTimeout(() => controller.abort("timeout"), movetime_ms * 2 + 5000);

    const promise = (async () => {
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fen, engine: "lc0", movetime_ms }),
          signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      } finally {
        clearTimeout(timer);
      }
    })();

    return { promise, cancel: () => controller.abort("cancelled") };
  }

  function isAbortError(e) {
    if (!e) return false;
    if (e.name === "AbortError") return true;
    const msg = e.message || String(e);
    return msg === "cancelled" || msg === "superseded" || msg === "timeout";
  }

  function startAnalysisFor(ply, engineKey, opts) {
    // Returns a promise that resolves once this ply/engine analysis is stored.
    // opts.depthOverride: pin the SF search to a specific depth (used by
    // the Deep dive button). Lc0 ignores it — its budget is the movetime
    // derived from the depth knob; deepening Lc0 isn't built yet.
    const fen = STATE.positions[ply];
    if (STATE.analyses[ply][engineKey]) return Promise.resolve();
    if (STATE.loading[ply].has(engineKey)) return Promise.resolve();

    STATE.loading[ply].add(engineKey);
    if (STATE.ply === ply) renderMoveInfo();

    const depthOverride = opts && opts.depthOverride;
    const { promise, cancel } = engineKey === "sf"
      ? startSfAnalysis(fen, depthOverride)
      : startLc0Analysis(fen);
    STATE.cancels[ply][engineKey] = cancel;

    return promise.then((result) => {
      STATE.analyses[ply][engineKey] = result;
      STATE.loading[ply].delete(engineKey);
      delete STATE.cancels[ply][engineKey];
      if (STATE.ply === ply) renderMoveInfo();
      updateMoveListEval(ply);
      maybeUpdateNeighborClassifications(ply);
    }).catch((e) => {
      STATE.loading[ply].delete(engineKey);
      delete STATE.cancels[ply][engineKey];
      if (STATE.ply === ply) renderMoveInfo();
      // Aborts/cancellations/timeouts are expected when the user navigates
      // away. Don't surface them as errors.
      if (isAbortError(e)) return;
      const tag = engineKey === "sf" ? "Stockfish" : "Lc0";
      setStatus(`${tag} error: ${e.message || e}`);
    });
  }

  /** Cancel all in-flight analyses (main + opponent-plan) for plies other
   *  than `keepPly`. */
  function cancelStaleAnalyses(keepPly) {
    for (let i = 0; i < STATE.cancels.length; i++) {
      if (i === keepPly) continue;
      const handles = STATE.cancels[i];
      if (handles) {
        for (const k of Object.keys(handles)) {
          try { handles[k](); } catch (_) {}
        }
      }
      const oppHandles = STATE.opponentCancels[i];
      if (oppHandles) {
        for (const k of Object.keys(oppHandles)) {
          try { oppHandles[k](); } catch (_) {}
        }
      }
    }
  }

  /** Run an SF analysis on the null-move FEN at `ply` so we can visualize
   *  what the OPPONENT would play if it were their turn — the visualization
   *  of their "active plan" in the current position. Only Stockfish for
   *  now; Lc0 would double the per-position cost on the server.
   *
   *  Returns a promise that resolves when the analysis is stored (or
   *  immediately if the null-move position is illegal / already cached).
   *  Re-renders the arrow overlay when STATE.ply matches. */
  function startOpponentAnalysisFor(ply, engineKey, opts) {
    if (engineKey !== "sf") return Promise.resolve();
    const fen = STATE.positions[ply];
    const nm = nullMoveFen(fen);
    if (!nm) {
      // Side-to-move is in check — opponent-plan is undefined here.
      return Promise.resolve();
    }
    if (STATE.opponentAnalyses[ply][engineKey]) return Promise.resolve();
    if (STATE.opponentLoading[ply].has(engineKey)) return Promise.resolve();

    STATE.opponentLoading[ply].add(engineKey);
    if (STATE.ply === ply) renderPlanArrows();

    const depthOverride = opts && opts.depthOverride;
    const { promise, cancel } = startSfAnalysis(nm, depthOverride);
    STATE.opponentCancels[ply][engineKey] = cancel;

    return promise.then((result) => {
      STATE.opponentAnalyses[ply][engineKey] = result;
      STATE.opponentLoading[ply].delete(engineKey);
      delete STATE.opponentCancels[ply][engineKey];
      if (STATE.ply === ply) renderPlanArrows();
    }).catch((e) => {
      STATE.opponentLoading[ply].delete(engineKey);
      delete STATE.opponentCancels[ply][engineKey];
      if (STATE.ply === ply) renderPlanArrows();
      if (isAbortError(e)) return;
      // Opponent-plan failures are non-fatal — just log.
      console.warn("Opponent-plan analysis error:", e);
    });
  }

  /** Analyze the sideline TIP (real + null-move FENs) with SF and stash
   *  the results on STATE.variation. The tip moves whenever the user
   *  navigates within the sideline or extends it, so we always cancel
   *  whatever was in flight first.
   *
   *  Lc0 is not analyzed in sidelines — the engine block hides for Lc0
   *  while a user sideline is active to avoid showing stale main-ply
   *  data alongside the sideline tip's SF result. */
  async function analyzeSidelineTip() {
    const v = STATE.variation;
    if (!v || v.source !== "user") return;
    if (!STATE.engineReady) return;

    // Cancel any in-flight tip analyses (real + opponent).
    if (v.tipCancel)    { try { v.tipCancel();    } catch (_) {} v.tipCancel = null; }
    if (v.tipOppCancel) { try { v.tipOppCancel(); } catch (_) {} v.tipOppCancel = null; }
    v.tipAnalysis    = null;
    v.tipOppAnalysis = null;
    v.tipLoading     = true;
    v.tipOppLoading  = false;
    renderMoveInfo();

    const fen = v.fenAfter;
    const sf = startSfAnalysis(fen);
    v.tipCancel = sf.cancel;
    try {
      const result = await sf.promise;
      // Bail if the variation went away or the tip moved while we waited.
      if (STATE.variation !== v || v.fenAfter !== fen) return;
      v.tipAnalysis = result;
      v.tipLoading = false;
      v.tipCancel = null;
      renderMoveInfo();
    } catch (e) {
      if (STATE.variation === v) {
        v.tipLoading = false;
        renderMoveInfo();
      }
      if (!isAbortError(e)) console.warn("sideline tip analysis failed:", e);
      return;
    }

    // Opponent plan on the null-move FEN — only when Plans is on and
    // the position is legal to null-move (side-to-move not in check).
    if (STATE.variation !== v || v.fenAfter !== fen) return;
    if (!STATE.showPlans) return;
    const nm = nullMoveFen(fen);
    if (!nm) return;

    v.tipOppLoading = true;
    renderPlanArrows();
    const opp = startSfAnalysis(nm);
    v.tipOppCancel = opp.cancel;
    try {
      const result = await opp.promise;
      if (STATE.variation !== v || v.fenAfter !== fen) return;
      v.tipOppAnalysis = result;
      v.tipOppLoading = false;
      v.tipOppCancel = null;
      renderPlanArrows();
    } catch (e) {
      if (STATE.variation === v) {
        v.tipOppLoading = false;
        renderPlanArrows();
      }
      if (!isAbortError(e)) console.warn("sideline opponent-tip analysis failed:", e);
    }
  }

  /** Navigate within the active variation (engine or user) to ply N
   *  (0..moves.length). Does NOT exit the variation. Drives arrow-key
   *  and nav-button navigation while a variation is being viewed, and
   *  also handles sideline move-list clicks. */
  function goToVariationPly(targetPly) {
    const v = STATE.variation;
    if (!v) return;
    targetPly = Math.max(0, Math.min(v.moves.length, targetPly));
    if (targetPly === v.currentPly) return;
    v.currentPly = targetPly;
    // Replay the first `currentPly` moves from the base position to get
    // the displayed FEN. Cheap — variations are typically a few plies long.
    const c = new Chess(STATE.positions[v.basePly]);
    for (let i = 0; i < targetPly; i++) {
      const u = v.moves[i];
      if (!c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })) break;
    }
    v.fenAfter = c.fen();
    STATE.boardObj.position(v.fenAfter, true);
    updateVariationBanner();
    renderMoveInfo();
    renderMoveList();
    // Only user sidelines get tip-analysis kicked off — engine variations
    // are read-only previews of an existing analysis.
    if (v.source === "user") analyzeSidelineTip();
  }

  // Back-compat alias for the older name used by the sideline-row click
  // handler. Routes through the unified variation navigator.
  function goToSidelinePly(targetPly) {
    const v = STATE.variation;
    if (!v || v.source !== "user") return;
    goToVariationPly(targetPly);
  }

  /** "Back one step" while a variation is active. Handles the edge case
   *  of stepping past the base of the variation — at currentPly=0 the
   *  user is already viewing the base position, so the next back-step
   *  exits the variation and continues stepping back through the main
   *  line. Without this, Left arrow would silently no-op at the base. */
  function navVariationPrev() {
    const v = STATE.variation;
    if (!v) return;
    if (v.currentPly > 0) {
      goToVariationPly(v.currentPly - 1);
    } else {
      // Already at the base — exit and step back on the main line.
      const basePly = v.basePly;
      exitVariation();
      if (basePly > 0) goToPly(basePly - 1);
    }
  }

  /** Re-enter the saved sideline (after the user clicked a main-line move
   *  that left the variation). targetPly defaults to the previous tip so
   *  the user lands where they left off. */
  function reenterSavedSideline(targetPly) {
    const saved = STATE.savedSideline;
    if (!saved) return;
    // Activate by pointing STATE.variation back at the saved object.
    STATE.variation = saved;
    if (typeof targetPly === "number") {
      saved.currentPly = Math.max(0, Math.min(saved.moves.length, targetPly));
    }
    // Recompute fenAfter for the new currentPly.
    const c = new Chess(STATE.positions[saved.basePly]);
    for (let i = 0; i < saved.currentPly; i++) {
      const u = saved.moves[i];
      if (!c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })) break;
    }
    saved.fenAfter = c.fen();
    STATE.boardObj.position(saved.fenAfter, true);
    document.getElementById("board").classList.add("in-variation");
    els.variationBanner.classList.remove("hidden");
    updateVariationBanner();
    renderMoveInfo();
    renderMoveList();
    analyzeSidelineTip();
  }

  /** Re-analyze the current position (and its predecessor) at base depth + 6.
   *  Used by the Deep dive button when the user wants extra confidence on a
   *  critical position. Predecessor is included so move classification
   *  compares apples-to-apples deepened evals — otherwise a deeper d22 on
   *  ply N vs a d16 on ply N-1 can shift the classification noisily.
   *
   *  The SF cache is keyed by (fen, depth), so deep dives miss the d16
   *  entry, run fresh at the deeper depth, and write a new entry that
   *  future visits will hit immediately. */
  async function deepDiveCurrentPosition() {
    if (!STATE.engineReady) return;
    if (!engineList().includes("sf")) return;
    const startingPly = STATE.ply;
    const base = clampDepth(+els.depth.value || 16);
    const deepDepth = deepDepthFor(base);
    if (deepDepth <= base) return; // already at cap

    // Reset SF state for a ply so the next startAnalysisFor actually re-runs
    // (it currently early-returns when STATE.analyses[ply].sf exists).
    const reset = (p, includeOpponent) => {
      const handles = STATE.cancels[p] || {};
      for (const k of Object.keys(handles)) {
        try { handles[k](); } catch (_) {}
      }
      delete STATE.cancels[p].sf;
      delete STATE.analyses[p].sf;
      STATE.loading[p].delete("sf");
      if (includeOpponent) {
        const oppHandles = STATE.opponentCancels[p] || {};
        for (const k of Object.keys(oppHandles)) {
          try { oppHandles[k](); } catch (_) {}
        }
        delete STATE.opponentCancels[p].sf;
        delete STATE.opponentAnalyses[p].sf;
        STATE.opponentLoading[p].delete("sf");
      }
    };

    // 1. Current ply — main SF analysis at deep depth.
    reset(startingPly, true);
    renderMoveInfo();
    setStatus(`deep dive d${deepDepth} on ply ${startingPly}…`);
    await startAnalysisFor(startingPly, "sf", { depthOverride: deepDepth });
    if (STATE.ply !== startingPly) { setStatus("ready"); return; }

    // 2. Current ply — opponent plan, if plans are showing.
    if (STATE.showPlans) {
      await startOpponentAnalysisFor(startingPly, "sf", { depthOverride: deepDepth });
      if (STATE.ply !== startingPly) { setStatus("ready"); return; }
    }

    // 3. Predecessor — main SF only (opponent plan only matters for the
    // ply the user is looking at). Skip at ply 0 (no predecessor).
    if (startingPly > 0) {
      setStatus(`deep dive d${deepDepth} on ply ${startingPly - 1}…`);
      reset(startingPly - 1, false);
      // Re-render to flicker the prev ply's loading state in the move list.
      if (STATE.ply === startingPly) renderMoveInfo();
      await startAnalysisFor(startingPly - 1, "sf", { depthOverride: deepDepth });
    }
    setStatus("ready");
  }

  /** When chaos is enabled or the board is flipped, the set of positions
   *  that need MultiPV=12 changes (only user-side analyses get the wide
   *  net). For the current ply, drop any cached SF analyses that don't
   *  meet the now-required width, then kick analyzeCurrent so the live
   *  worker re-runs at the new MultiPV.
   *
   *  Safe to call when chaos is off — it's a no-op then (sfMultiPv = 4
   *  for everything, so existing analyses are always wide enough). */
  function maybeRerunForChaos() {
    if (!STATE.engineReady) return;
    const ply = STATE.ply;
    const fen = STATE.positions[ply];
    if (!fen) return;
    const nmFen = nullMoveFen(fen);
    let triggered = false;

    // Main analysis — required width depends on main FEN's side-to-move.
    const wantedMain = sfMultiPv(fen);
    const an = STATE.analyses[ply] && STATE.analyses[ply].sf;
    if (wantedMain > 4 && (!an || !an.candidates || an.candidates.length < wantedMain)) {
      const handles = STATE.cancels[ply] || {};
      for (const k of Object.keys(handles)) {
        try { handles[k](); } catch (_) {}
      }
      delete STATE.analyses[ply].sf;
      STATE.loading[ply].delete("sf");
      triggered = true;
    }

    // Opponent (null-move) analysis — required width depends on the
    // null-move FEN's side-to-move, which is the opposite of the real one.
    if (nmFen) {
      const wantedOpp = sfMultiPv(nmFen);
      const oppAn = STATE.opponentAnalyses[ply] && STATE.opponentAnalyses[ply].sf;
      if (wantedOpp > 4 && (!oppAn || !oppAn.candidates || oppAn.candidates.length < wantedOpp)) {
        const oppHandles = STATE.opponentCancels[ply] || {};
        for (const k of Object.keys(oppHandles)) {
          try { oppHandles[k](); } catch (_) {}
        }
        delete STATE.opponentAnalyses[ply].sf;
        STATE.opponentLoading[ply].delete("sf");
        triggered = true;
      }
    }

    if (triggered) analyzeCurrent();
  }

  async function analyzeCurrent() {
    if (!STATE.engineReady) return;
    const ply = STATE.ply;
    const want = engineList().filter((k) => k !== "lc0" || STATE.lc0Available);
    const promises = want.map((k) => startAnalysisFor(ply, k));
    setStatus(`analyzing ply ${ply} (${want.join("+")})`);
    await Promise.allSettled(promises);

    // After the main SF analysis completes, chain the opponent-plan
    // analysis on the SAME worker (it serializes searches via the supersede
    // pattern, so we can't parallelize on the worker side). Skip if the
    // user has navigated away or toggled plans off, or if the position is
    // not analyzable by SF (we're in Lc0-only mode).
    if (
      STATE.showPlans
      && want.includes("sf")
      && STATE.ply === ply
    ) {
      setStatus(`analyzing ply ${ply} (opponent plan)`);
      await startOpponentAnalysisFor(ply, "sf");
    }
    setStatus("ready");
  }

  function maybeUpdateNeighborClassifications(ply) {
    // For each affected row, prefer applying the full classification
    // (which includes the annotation). If classification can't be computed
    // yet (e.g., only one of the two flanking SF analyses is in), still
    // refresh the annotation so 🔥 can show as soon as we know the move
    // was a sacrifice — the sacrifice check only needs the PRIOR ply's
    // analysis, not the post-move one.
    if (ply > 0) {
      const cls = computeClassification(ply);
      if (cls) applyClassificationToMoveEl(ply, cls);
      else     updateMoveListAnnotation(ply, null);
    }
    if (ply + 1 < STATE.positions.length) {
      const cls = computeClassification(ply + 1);
      if (cls) applyClassificationToMoveEl(ply + 1, cls);
      else     updateMoveListAnnotation(ply + 1, null);
    }
  }

  /** Add every ply currently missing a wanted-engine analysis to the
   *  background queue (deduped). Safe to call multiple times. */
  function enqueueMissingPliesForBackground() {
    const want = engineList().filter((k) => k !== "lc0" || STATE.lc0Available);
    for (let i = 0; i < STATE.positions.length; i++) {
      if (STATE.bgQueue.includes(i)) continue;
      if (want.some((k) => !STATE.analyses[i][k])) STATE.bgQueue.push(i);
    }
  }

  /** "Analyze All" — runs as a BACKGROUND queue so it cooperates with
   *  navigation. The user can move through the game while this is
   *  running; any ply that gets cancelled by navigation is re-queued
   *  and picked up on the next pass. */
  async function analyzeAll() {
    if (!STATE.engineReady) return;
    enqueueMissingPliesForBackground();
    if (STATE.bgRunning) return; // already chewing through the queue
    STATE.bgRunning = true;
    els.analyzeAll.disabled = false; // stay clickable so the user can re-enqueue

    // Cap retries per ply so we never infinite-loop if a position is
    // somehow always-cancelled. 8 is generous — even rapid navigation
    // shouldn't burn 8 attempts before the user pauses.
    const MAX_ATTEMPTS = 8;
    const attempts = new Map();

    try {
      const want = engineList().filter((k) => k !== "lc0" || STATE.lc0Available);
      while (STATE.bgQueue.length > 0) {
        const i = STATE.bgQueue.shift();
        // Position may have vanished (truncate / new game). Skip silently.
        if (!STATE.positions[i]) continue;
        const missing = want.filter((k) => !STATE.analyses[i][k]);
        if (!missing.length) continue;

        const a = attempts.get(i) || 0;
        if (a >= MAX_ATTEMPTS) continue; // give up on this ply

        const total = STATE.positions.length;
        const remaining = STATE.bgQueue.length + 1; // +1 because we already shifted
        setStatus(`analyze-all · ply ${i + 1}/${total} · ${remaining} left`);

        await Promise.allSettled(missing.map((k) => startAnalysisFor(i, k)));

        // After the await, check whether the analysis ACTUALLY landed —
        // navigation may have cancelled it via cancelStaleAnalyses. If
        // it's still missing, re-queue at the end (so other plies get a
        // shot first) and pause briefly to avoid hammering when the user
        // is mid-flurry-of-clicks.
        const stillMissing = want.filter((k) => !STATE.analyses[i][k]);
        if (stillMissing.length > 0) {
          attempts.set(i, a + 1);
          STATE.bgQueue.push(i);
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }

        if (i > 0) maybeUpdateNeighborClassifications(i);
        if (STATE.ply === i) renderMoveInfo();
        // Even when the user has navigated away from `i`, the chart
        // should grow as background analyses land — that's the whole
        // point of being able to watch the timeline fill in.
        else renderEvalChart();
      }
      setStatus("analysis complete");
    } catch (e) {
      setStatus(`analyze-all error: ${e.message || e}`);
    } finally {
      STATE.bgRunning = false;
    }
  }

  // ---------- Coach (Claude) ----------

  function appendChat(role, text, ctx) {
    // Coach UI was removed from the layout — keep the function callable
    // (askCoach et al still reference it) but no-op when there's no chat.
    if (!els.chat) return;
    const div = document.createElement("div");
    div.className = "msg " + role;
    if (ctx) {
      const c = document.createElement("div");
      c.className = "ctx";
      c.textContent = ctx;
      div.appendChild(c);
    }
    const body = document.createElement("div");
    body.textContent = text;
    div.appendChild(body);
    els.chat.appendChild(div);
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  function engineCoachPayload(engineKey, ply, fen) {
    // Build the per-engine context block for the coach request.
    const prevAn = ply > 0 ? (STATE.analyses[ply - 1] || {})[engineKey] : null;
    const curAn  = (STATE.analyses[ply] || {})[engineKey];
    if (!prevAn && !curAn) return null;

    const prevSide = ply > 0 ? STATE.positions[ply - 1].split(" ")[1] : fen.split(" ")[1];
    const curSide  = fen.split(" ")[1];
    const evalBeforeW = evalFromWhite(prevAn, prevSide);
    const evalAfterW  = evalFromWhite(curAn,  curSide);

    const refFen  = STATE.positions[ply - 1] || fen;
    const refSide = refFen.split(" ")[1];

    const bestMoveUci = prevAn && prevAn.bestMove;
    const bestMoveSan = bestMoveUci
      ? uciLineToSan(refFen, [bestMoveUci])[0]
      : null;
    const bestLineSan = prevAn && prevAn.pv
      ? uciLineToSan(refFen, prevAn.pv.slice(0, 10))
      : (curAn && curAn.pv ? uciLineToSan(fen, curAn.pv.slice(0, 10)) : []);

    // Creative (sacrifice) alternative — based on candidates from `prevAn`
    // (the position the player faced when choosing their move).
    let creative = null;
    if (STATE.creativeMode && prevAn) {
      const c = pickCreativeCandidate(prevAn, refFen, STATE.creativeThresholdCp);
      if (c) {
        const creativeEvalW = evalFromWhite(c.candidate, refSide);
        creative = {
          moveSan: uciLineToSan(refFen, [c.candidate.bestMove])[0] || c.candidate.bestMove,
          line:    uciLineToSan(refFen, c.candidate.pv.slice(0, 10)),
          eval:    creativeEvalW ? { cp: creativeEvalW.cp, mate: creativeEvalW.mate } : null,
          materialDelta: c.materialDelta, // negative cp = material given up
        };
      }
    }

    // Chaos alternative — opponent-difficulty pick within a wider tolerance.
    // Distinct from creative: chaos is deliberately unsound by engine
    // standards, traded for practical fighting chances against a human.
    // The coach should frame it that way — useful against a strong human
    // tactician, not against an engine or 2400+ correspondence player.
    let chaos = null;
    if (STATE.chaosMode && prevAn) {
      const c = pickChaosCandidate(prevAn, refFen, STATE.chaosThresholdCp);
      if (c) {
        const chaosEvalW = evalFromWhite(c.candidate, refSide);
        chaos = {
          moveSan: uciLineToSan(refFen, [c.candidate.bestMove])[0] || c.candidate.bestMove,
          line:    uciLineToSan(refFen, c.candidate.pv.slice(0, 10)),
          eval:    chaosEvalW ? { cp: chaosEvalW.cp, mate: chaosEvalW.mate } : null,
          captures: c.captures,
          checks: c.checks,
          materialDelta: c.materialDelta,
          cpLoss: c.cpLoss, // how much objective eval is sacrificed vs top
        };
      }
    }

    return {
      evalBefore: evalBeforeW ? { cp: evalBeforeW.cp, mate: evalBeforeW.mate } : null,
      evalAfter:  evalAfterW  ? { cp: evalAfterW.cp,  mate: evalAfterW.mate  } : null,
      bestMoveSan,
      bestLine: bestLineSan,
      depth: prevAn ? prevAn.depth : (curAn ? curAn.depth : null),
      nodes: prevAn ? prevAn.nodes : (curAn ? curAn.nodes : null),
      creative,
      chaos,
    };
  }

  async function askCoach(question) {
    // Coach UI was removed — bail out early so the rest of the function
    // (which assumes els.chat / els.ask exist) doesn't blow up if someone
    // wires up another caller down the road.
    if (!els.chat || !els.ask) return;
    const ply = STATE.ply;
    if (ply === 0 && STATE.moves.length === 0) {
      appendChat("system", "Make a move on the board or load a PGN first.");
      return;
    }
    const fen = STATE.positions[ply];
    const sideToMove = fen.split(" ")[1] === "w" ? "white" : "black";
    const moveNumber = Math.ceil(ply / 2);
    let lastMoveSan = null, lastMoveBy = null;
    if (ply > 0) {
      lastMoveSan = STATE.moves[ply - 1].san;
      lastMoveBy = STATE.moves[ply - 1].color === "w" ? "white" : "black";
    }
    const upTo = new Chess();
    for (let i = 0; i < ply; i++) {
      const m = STATE.moves[i];
      upTo.move({ from: m.from, to: m.to, promotion: m.promotion });
    }
    const pgnSoFar = upTo.pgn();

    const sf  = engineCoachPayload("sf",  ply, fen);
    const lc0 = engineCoachPayload("lc0", ply, fen);

    const payload = {
      pgn: pgnSoFar,
      fen,
      sideToMove,
      moveNumber,
      lastMoveSan,
      lastMoveBy,
      stockfish: sf,
      lc0: lc0,
      question,
    };

    const ctxLine = lastMoveSan
      ? `On ${moveNumber}${lastMoveBy === "white" ? "." : "…"} ${lastMoveSan}`
      : `Starting position`;
    appendChat("user", question, ctxLine);
    els.ask.disabled = true;
    appendChat("coach", "Thinking…");
    const thinkingMsg = els.chat.lastChild;

    try {
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      thinkingMsg.remove();
      if (data.error) {
        appendChat("system", "Error: " + data.error);
      } else {
        appendChat("coach", data.reply || "(empty reply)");
        if (data.model) els.coachModel.textContent = " · " + data.model;
      }
    } catch (e) {
      thinkingMsg.remove();
      appendChat("system", "Network error: " + (e.message || e));
    } finally {
      els.ask.disabled = false;
    }
  }

  // ---------- Library ----------

  /** Open / close the library side panel. On open we always refresh
   *  both lists so the panel stays in sync with the backend. */
  function setLibraryOpen(open) {
    if (!els.libraryPanel) return;
    if (open) {
      els.libraryPanel.classList.remove("hidden");
      els.libraryPanel.setAttribute("aria-hidden", "false");
      refreshLibraryGames();
      refreshLibraryOpenings();
    } else {
      els.libraryPanel.classList.add("hidden");
      els.libraryPanel.setAttribute("aria-hidden", "true");
    }
  }

  function setLibraryTab(tabName) {
    document.querySelectorAll(".library-tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabName);
    });
    document.querySelectorAll(".library-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === tabName);
    });
  }

  async function refreshLibraryGames() {
    if (!els.libraryGamesList) return;
    try {
      // Pull the full archive (server-capped at 5000) so the chronological
      // grouping is meaningful.
      const res = await fetch("/api/library/games?limit=2000");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderLibraryGames(data.games || []);
    } catch (e) {
      console.warn("library: list games failed", e);
    }
  }

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  /** Extract a {year, month} pair from either a PGN-style "YYYY.MM.DD"
   *  date or an ISO timestamp "YYYY-MM-DDTHH:MM:SS+00:00". Returns null
   *  when the date is missing or unparseable (e.g., "????.??.??"). */
  function gameYearMonth(g) {
    const candidates = [g.played_date, g.created_at];
    for (const raw of candidates) {
      if (!raw) continue;
      const m = String(raw).match(/^(\d{4})[-.](\d{2})/);
      if (!m) continue;
      const year = +m[1];
      const month = +m[2];
      if (year < 1900 || month < 1 || month > 12) continue;
      return { year, month };
    }
    return null;
  }

  function renderLibraryGames(games) {
    els.libraryGamesList.innerHTML = "";
    els.libraryGamesEmpty.classList.toggle("hidden", games.length > 0);
    let lastKey = null;
    games.forEach((g) => {
      // Insert a month-section divider whenever the year-month changes.
      // Games already come back sorted DESC by played_date with
      // created_at fallback, so this is just a "did we cross a boundary"
      // check rather than a re-sort.
      const ym = gameYearMonth(g);
      const key = ym ? `${ym.year}-${ym.month}` : "unknown";
      if (key !== lastKey) {
        const header = document.createElement("li");
        header.className = "library-month-header";
        header.textContent = ym ? `${MONTH_NAMES[ym.month - 1]} ${ym.year}` : "Date unknown";
        els.libraryGamesList.appendChild(header);
        lastKey = key;
      }

      const li = document.createElement("li");
      li.dataset.id = g.id;
      const left = document.createElement("div");
      const title = document.createElement("div");
      title.className = "row-title";
      const w = g.white_name || "?";
      const b = g.black_name || "?";
      title.textContent = `${w} – ${b}  ${g.result || "*"}`;
      left.appendChild(title);
      const meta = document.createElement("div");
      meta.className = "row-meta";
      const parts = [];
      // User color badge (W/B) — only shown when known (set on Lichess import).
      if (g.user_color === "w" || g.user_color === "b") {
        parts.push(`<span class="row-color ${g.user_color}">${g.user_color === "w" ? "W" : "B"}</span>`);
      }
      if (g.opening) parts.push(`<span class="row-tag">${escapeHtml(g.opening.name)}</span>`);
      parts.push(`${g.move_count} plies`);
      if (g.played_date) parts.push(escapeHtml(g.played_date));
      meta.innerHTML = parts.join(" · ");
      left.appendChild(meta);
      li.appendChild(left);

      const del = document.createElement("button");
      del.className = "row-delete";
      del.textContent = "×";
      del.title = "Delete this game from the library";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("Remove this game from the library?")) return;
        fetch(`/api/library/games/${g.id}`, { method: "DELETE" })
          .then(() => refreshLibraryGames())
          .catch(() => {});
      });
      li.appendChild(del);

      li.addEventListener("click", () => loadGameFromLibrary(g.id));
      els.libraryGamesList.appendChild(li);
    });
  }

  async function loadGameFromLibrary(gameId) {
    try {
      const res = await fetch(`/api/library/games/${gameId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const game = await res.json();
      if (!game.pgn) return;
      // Suppress the auto-save round-trip — we're loading a row that
      // already exists in the library.
      STATE.suppressNextAutoSave = true;
      STATE.currentLibraryGameId = game.id;
      STATE.currentOpening = game.opening || null;
      els.pgn.value = game.pgn;
      if (loadPgn(game.pgn)) {
        setLibraryOpen(false);
      } else {
        STATE.suppressNextAutoSave = false;
      }
    } catch (e) {
      console.warn("library: load game failed", e);
    }
  }

  async function refreshLibraryOpenings() {
    if (!els.libraryOpeningsList) return;
    try {
      const res = await fetch("/api/library/openings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderLibraryOpenings(data.openings || []);
    } catch (e) {
      console.warn("library: list openings failed", e);
    }
  }

  function renderLibraryOpenings(openings) {
    els.libraryOpeningsList.innerHTML = "";
    els.libraryOpeningsEmpty.classList.toggle("hidden", openings.length > 0);
    openings.forEach((o) => {
      const li = document.createElement("li");
      const left = document.createElement("div");
      const title = document.createElement("div");
      title.className = "row-title";
      title.textContent = o.name;
      left.appendChild(title);
      const meta = document.createElement("div");
      meta.className = "row-meta";
      // Render the first 8 plies as SAN preview by replaying the UCI list
      // through chess.js, so the user can see what the opening looks like.
      let preview = "";
      try {
        const c = new Chess();
        const parts = [];
        const uciList = o.moves_uci || [];
        for (let i = 0; i < uciList.length && i < 8; i++) {
          const u = uciList[i];
          const mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
          if (!mv) break;
          if (i % 2 === 0) parts.push(`${(i / 2 | 0) + 1}.`);
          parts.push(mv.san);
        }
        preview = parts.join(" ");
      } catch (_) { /* ignore */ }
      meta.textContent = `${o.move_count} plies · ${o.game_count} games · ${preview}`;
      left.appendChild(meta);
      li.appendChild(left);

      const del = document.createElement("button");
      del.className = "row-delete";
      del.textContent = "×";
      del.title = "Delete this opening (games stay; they just lose the tag)";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`Delete the opening "${o.name}"?`)) return;
        fetch(`/api/library/openings/${o.id}`, { method: "DELETE" })
          .then(() => { refreshLibraryOpenings(); refreshLibraryGames(); })
          .catch(() => {});
      });
      li.appendChild(del);

      li.addEventListener("click", () => {
        // Filter games to those tagged with this opening.
        fetch(`/api/library/games?opening_id=${o.id}`)
          .then((r) => r.json())
          .then((data) => {
            setLibraryTab("games");
            renderLibraryGames(data.games || []);
          })
          .catch(() => {});
      });
      els.libraryOpeningsList.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[ch]
    );
  }

  /** Auto-save the current PGN to the library and update the opening chip.
   *  Called from loadPgn after a successful parse. */
  async function autoSaveCurrentPgn(pgnText) {
    if (STATE.suppressNextAutoSave) {
      STATE.suppressNextAutoSave = false;
      updateOpeningChip();
      return;
    }
    try {
      const res = await fetch("/api/library/games", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn: pgnText, source: "import" }),
      });
      if (!res.ok) {
        STATE.currentOpening = null;
        STATE.currentLibraryGameId = null;
        updateOpeningChip();
        return;
      }
      const data = await res.json();
      STATE.currentLibraryGameId = data.id || null;
      STATE.currentOpening = data.opening || null;
      updateOpeningChip();
      const tag = data.opening ? ` · Opening: ${data.opening.name}` : "";
      const dupNote = data.was_duplicate ? " (already saved)" : "";
      appendChat("system", `Saved to library${dupNote}${tag}`);
    } catch (e) {
      console.warn("library: auto-save failed", e);
    }
  }

  /** Show / hide / refresh the "Opening: …" chip in the move-info panel. */
  function updateOpeningChip() {
    if (!els.openingChip || !els.openingChipRow) return;
    if (STATE.currentOpening && STATE.currentOpening.name) {
      els.openingChip.textContent = STATE.currentOpening.name;
      els.openingChipRow.classList.remove("hidden");
    } else {
      els.openingChipRow.classList.add("hidden");
    }
  }

  /** Parse SAN string from the "Add Opening" form, validate with chess.js,
   *  and POST to /api/library/openings. */
  async function submitNewOpening(name, sanText) {
    // Tokenize: strip move numbers ("1.", "1...") so the user can paste
    // SAN directly from a PGN.
    const tokens = sanText
      .replace(/,/g, " ")
      .split(/\s+/)
      .filter((t) => t && !/^\d+\.+$/.test(t));
    if (!tokens.length) throw new Error("No moves provided.");
    // Client-side validation pass: try to replay with chess.js so we
    // catch obvious typos before the round-trip.
    const c = new Chess();
    for (let i = 0; i < tokens.length; i++) {
      const mv = c.move(tokens[i], { sloppy: true });
      if (!mv) throw new Error(`Move ${i + 1} ("${tokens[i]}") is not legal.`);
    }
    const res = await fetch("/api/library/openings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, san_moves: tokens }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- Wiring ----------

  function wireEvents() {
    els.load.addEventListener("click", () => loadPgn(els.pgn.value));
    els.sample.addEventListener("click", () => {
      els.pgn.value = SAMPLE_PGN;
      loadPgn(SAMPLE_PGN);
    });
    els.newGame.addEventListener("click", () => {
      if (STATE.moves.length > 0 && !confirm("Start a new game? This will clear the current game.")) return;
      startNewGame();
    });
    els.analyzeAll.addEventListener("click", analyzeAll);
    if (els.deepDive) {
      els.deepDive.addEventListener("click", () => {
        deepDiveCurrentPosition();
      });
    }
    // Keep the Deep dive label ("d22") in sync when the user adjusts the
    // base depth knob — no analysis kicks off, just a label refresh.
    if (els.depth) {
      const refreshDeepLabel = () => updateDeepDiveButton();
      els.depth.addEventListener("input", refreshDeepLabel);
      els.depth.addEventListener("change", refreshDeepLabel);
    }

    // Navigation buttons. When a variation is active, step WITHIN the
    // variation; otherwise navigate the main line. This mirrors the
    // arrow-key behavior below.
    els.navStart.addEventListener("click", () => {
      if (STATE.variation) goToVariationPly(0);
      else goToPly(0);
    });
    els.navPrev.addEventListener("click", () => {
      if (STATE.variation) navVariationPrev();
      else goToPly(STATE.ply - 1);
    });
    els.navNext.addEventListener("click", () => {
      if (STATE.variation) goToVariationPly(STATE.variation.currentPly + 1);
      else goToPly(STATE.ply + 1);
    });
    els.navEnd.addEventListener("click", () => {
      if (STATE.variation) goToVariationPly(STATE.variation.moves.length);
      else goToPly(STATE.positions.length - 1);
    });
    els.flip.addEventListener("click", () => {
      STATE.orientation = STATE.orientation === "white" ? "black" : "white";
      STATE.boardObj.orientation(STATE.orientation);
      // Square DOM positions change after a flip — redraw arrows.
      renderPlanArrows();
      // Flip changes which positions count as "user-side" → may need to
      // re-analyze the current ply at a different MultiPV.
      maybeRerunForChaos();
      // Picks for user vs opponent flip — re-render the engine block too.
      renderMoveInfo();
    });

    document.addEventListener("keydown", (e) => {
      if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return;
      if (e.key === "Escape" && STATE.variation) { e.preventDefault(); exitVariation(); return; }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (STATE.variation) navVariationPrev();
        else goToPly(STATE.ply - 1);
      }
      else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (STATE.variation) goToVariationPly(STATE.variation.currentPly + 1);
        else goToPly(STATE.ply + 1);
      }
      else if (e.key === "Home") {
        e.preventDefault();
        if (STATE.variation) goToVariationPly(0);
        else goToPly(0);
      }
      else if (e.key === "End") {
        e.preventDefault();
        if (STATE.variation) goToVariationPly(STATE.variation.moves.length);
        else goToPly(STATE.positions.length - 1);
      }
      else if (e.key === "f") { els.flip.click(); }
    });

    els.exitVariationBtn.addEventListener("click", exitVariation);

    // Creative-mode toggle + threshold
    if (els.creativeToggle) {
      els.creativeToggle.addEventListener("change", () => {
        STATE.creativeMode = els.creativeToggle.checked;
        renderMoveInfo();
      });
    }
    if (els.creativeThreshold) {
      // Seed the input from current state so HTML default + JS default stay in sync.
      els.creativeThreshold.value = STATE.creativeThresholdCp;
      const updateThreshold = () => {
        const v = parseInt(els.creativeThreshold.value, 10);
        if (Number.isFinite(v)) {
          STATE.creativeThresholdCp = Math.max(10, Math.min(300, v));
          renderMoveInfo();
        }
      };
      els.creativeThreshold.addEventListener("input", updateThreshold);
      els.creativeThreshold.addEventListener("change", updateThreshold);
    }

    // Chaos toggle + threshold. When enabling chaos OR flipping board
    // orientation (which changes which positions are "user-side"), some
    // analyses may need to re-run at MultiPV=12.
    if (els.chaosToggle) {
      els.chaosToggle.checked = STATE.chaosMode;
      els.chaosToggle.addEventListener("change", () => {
        STATE.chaosMode = els.chaosToggle.checked;
        maybeRerunForChaos();
        renderMoveInfo();
      });
    }
    if (els.chaosThreshold) {
      els.chaosThreshold.value = STATE.chaosThresholdCp;
      const updateChaosThreshold = () => {
        const v = parseInt(els.chaosThreshold.value, 10);
        if (Number.isFinite(v)) {
          STATE.chaosThresholdCp = Math.max(50, Math.min(400, v));
          renderMoveInfo();
        }
      };
      els.chaosThreshold.addEventListener("input", updateChaosThreshold);
      els.chaosThreshold.addEventListener("change", updateChaosThreshold);
    }

    // Plans toggle + plies count
    if (els.plansToggle) {
      els.plansToggle.checked = STATE.showPlans;
      els.plansToggle.addEventListener("change", () => {
        STATE.showPlans = els.plansToggle.checked;
        if (STATE.showPlans) {
          // Newly enabled — kick off opponent analysis for the current ply
          // if we haven't already computed it. (Main analysis is unaffected.)
          if (STATE.engineReady && engineList().includes("sf")) {
            startOpponentAnalysisFor(STATE.ply, "sf");
          }
        } else {
          // Newly disabled — cancel any in-flight opponent search at the
          // current ply so the SF worker is free for normal use.
          const handles = STATE.opponentCancels[STATE.ply] || {};
          for (const k of Object.keys(handles)) {
            try { handles[k](); } catch (_) {}
          }
        }
        renderPlanArrows();
      });
    }
    if (els.plansPlies) {
      els.plansPlies.value = STATE.planPlies;
      const updatePlies = () => {
        const v = parseInt(els.plansPlies.value, 10);
        if (Number.isFinite(v)) {
          STATE.planPlies = Math.max(1, Math.min(6, v));
          renderPlanArrows();
        }
      };
      els.plansPlies.addEventListener("input", updatePlies);
      els.plansPlies.addEventListener("change", updatePlies);
    }

    // Engine selector radios
    document.querySelectorAll('input[name="engine"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        if (!e.target.checked) return;
        const v = e.target.value;
        if (v === "lc0" && !STATE.lc0Available) { e.target.checked = false; return; }
        if (v === "both" && !STATE.lc0Available) { e.target.checked = false; return; }
        STATE.engineMode = v;
        renderMoveInfo();
        // Kick off analysis for newly-needed engines at the current ply.
        analyzeCurrent();
      });
    });

    // Coach UI (chat + ask + suggestions) was removed from the layout.
    // Listener setup only fires if those elements still exist, so the
    // app boots cleanly without them. Leave askCoach() intact for any
    // future re-enable.
    if (els.suggestions && els.questionInput && els.ask) {
      els.suggestions.querySelectorAll("button").forEach((b) => {
        b.addEventListener("click", () => {
          const q = b.dataset.q;
          els.questionInput.value = q;
          askCoach(q);
        });
      });
      els.ask.addEventListener("click", () => {
        const q = els.questionInput.value.trim();
        if (!q) return;
        askCoach(q);
        els.questionInput.value = "";
      });
      els.questionInput.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") els.ask.click();
      });
    }

    // Library panel wiring
    if (els.libraryBtn) {
      els.libraryBtn.addEventListener("click", () => {
        const open = els.libraryPanel.classList.contains("hidden");
        setLibraryOpen(open);
      });
    }
    if (els.libraryCloseBtn) {
      els.libraryCloseBtn.addEventListener("click", () => setLibraryOpen(false));
    }
    document.querySelectorAll(".library-tabs button").forEach((b) => {
      b.addEventListener("click", () => setLibraryTab(b.dataset.tab));
    });
    if (els.addOpeningToggle) {
      els.addOpeningToggle.addEventListener("click", () => {
        els.addOpeningForm.classList.toggle("hidden");
        if (!els.addOpeningForm.classList.contains("hidden")) {
          els.newOpeningName.focus();
          els.addOpeningError.textContent = "";
        }
      });
    }
    if (els.addOpeningCancel) {
      els.addOpeningCancel.addEventListener("click", () => {
        els.addOpeningForm.classList.add("hidden");
        els.newOpeningName.value = "";
        els.newOpeningMoves.value = "";
        els.addOpeningError.textContent = "";
      });
    }
    // Lichess import — username persisted in localStorage so users don't
    // have to re-type it each visit.
    if (els.lichessUsername) {
      try {
        const last = localStorage.getItem("ccLichessUsername");
        if (last) els.lichessUsername.value = last;
      } catch (_) {}
    }
    if (els.lichessImportToggle) {
      els.lichessImportToggle.addEventListener("click", () => {
        els.lichessImportForm.classList.toggle("hidden");
        if (!els.lichessImportForm.classList.contains("hidden")) {
          els.lichessUsername.focus();
          els.lichessImportStatus.textContent = "";
          els.lichessImportStatus.classList.remove("ok");
        }
      });
    }
    if (els.lichessImportCancel) {
      els.lichessImportCancel.addEventListener("click", () => {
        els.lichessImportForm.classList.add("hidden");
        els.lichessImportStatus.textContent = "";
        els.lichessImportStatus.classList.remove("ok");
      });
    }
    if (els.lichessImportForm) {
      els.lichessImportForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const username = (els.lichessUsername.value || "").trim();
        if (!username) return;
        try { localStorage.setItem("ccLichessUsername", username); } catch (_) {}
        const max = Math.max(1, Math.min(300, parseInt(els.lichessMax.value, 10) || 50));
        const perfType = els.lichessPerf.value || null;
        const rated = !!els.lichessRated.checked;
        els.lichessImportSubmit.disabled = true;
        els.lichessImportStatus.classList.remove("ok");
        els.lichessImportStatus.textContent = `Fetching ${max} games from Lichess…`;
        try {
          const res = await fetch("/api/library/import_lichess", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, max, perfType, rated }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            els.lichessImportStatus.textContent = data.error || `HTTP ${res.status}`;
            return;
          }
          const { imported, duplicates, skipped, total } = data;
          els.lichessImportStatus.classList.add("ok");
          els.lichessImportStatus.textContent =
            `Imported ${imported}/${total} (${duplicates} dup, ${skipped} skipped)`;
          await refreshLibraryGames();
          // Refresh openings too — game counts changed.
          refreshLibraryOpenings();
        } catch (err) {
          els.lichessImportStatus.textContent = err.message || String(err);
        } finally {
          els.lichessImportSubmit.disabled = false;
        }
      });
    }

    // Single-game import via Lichess URL or game ID. Hits Lichess's
    // /game/export/<id> endpoint which works immediately after a game
    // ends — bypasses the user-archive indexing delay.
    if (els.lichessImportGameSubmit) {
      els.lichessImportGameSubmit.addEventListener("click", async () => {
        const url = (els.lichessGameUrl.value || "").trim();
        if (!url) {
          els.lichessImportStatus.classList.remove("ok");
          els.lichessImportStatus.textContent = "Paste a Lichess game URL or ID first.";
          return;
        }
        const username = (els.lichessUsername.value || "").trim() || null;
        els.lichessImportGameSubmit.disabled = true;
        els.lichessImportStatus.classList.remove("ok");
        els.lichessImportStatus.textContent = "Fetching game…";
        try {
          const res = await fetch("/api/library/import_lichess_game", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, username }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            els.lichessImportStatus.textContent = data.error || `HTTP ${res.status}`;
            return;
          }
          els.lichessImportStatus.classList.add("ok");
          const tag = data.opening ? ` · ${data.opening.name}` : "";
          els.lichessImportStatus.textContent = data.was_duplicate
            ? `Already in library${tag}`
            : `Imported game ${data.game_id || ""}${tag}`;
          els.lichessGameUrl.value = "";
          await refreshLibraryGames();
          refreshLibraryOpenings();
        } catch (err) {
          els.lichessImportStatus.textContent = err.message || String(err);
        } finally {
          els.lichessImportGameSubmit.disabled = false;
        }
      });
    }

    if (els.addOpeningForm) {
      els.addOpeningForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        els.addOpeningError.textContent = "";
        try {
          await submitNewOpening(
            els.newOpeningName.value.trim(),
            els.newOpeningMoves.value.trim()
          );
          els.newOpeningName.value = "";
          els.newOpeningMoves.value = "";
          els.addOpeningForm.classList.add("hidden");
          refreshLibraryOpenings();
          refreshLibraryGames(); // game tags may have changed due to rescan
        } catch (err) {
          els.addOpeningError.textContent = err.message || String(err);
        }
      });
    }
  }

  // ---------- Startup ----------

  const SAMPLE_PGN = `[Event "Sample"]
[Site "?"]
[White "Player"]
[Black "Opponent"]
[Result "*"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6
8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. Nbd2 Bb7 12. Bc2 Re8 13. Nf1 Bf8 *`;

  function applyLc0Availability(h) {
    const lc0 = (h && h.lc0) || { available: false };
    STATE.lc0Available = !!lc0.available;
    STATE.lc0Reason    = lc0.reason || null;
    // Toggle the Lc0 / Both radio options in the UI.
    [els.engineOptLc0, els.engineOptBoth].forEach((el) => {
      if (!el) return;
      el.classList.toggle("disabled", !STATE.lc0Available);
      const input = el.querySelector("input");
      if (input) input.disabled = !STATE.lc0Available;
      el.title = STATE.lc0Available
        ? "Use Lc0 (Leela Chess Zero)"
        : (lc0.reason || "Lc0 not available")
          + (lc0.hint ? "\n\n" + lc0.hint : "");
    });
    if (!STATE.lc0Available && (STATE.engineMode === "lc0" || STATE.engineMode === "both")) {
      STATE.engineMode = "stockfish";
      const sfRadio = document.querySelector('input[name="engine"][value="stockfish"]');
      if (sfRadio) sfRadio.checked = true;
    }
  }

  async function main() {
    buildBoard();
    wireEvents();
    // Render the empty-state chart immediately so the panel reads as
    // "this is where the eval timeline will appear" before any analysis.
    renderEvalChart();
    setStatus("loading config…");

    const h = await fetch("/healthz").then(r => r.json()).catch(() => ({}));
    const engine = h.engine || { worker_url: "/static/stockfish.js", name: "Stockfish", flavor: "?", available: true };
    const workerUrl = engine.worker_url;

    applyLc0Availability(h);

    if (engine.available === false) {
      setStatus(`${engine.name} files missing — check server log`);
      appendChat("system",
        `${engine.name} (${engine.flavor}) wasn't downloaded on the server. ` +
        `Check the server log for the failed download URL, place the files in static/, and reload.`
      );
      return;
    }

    setStatus(`booting ${engine.name} (${engine.flavor})…`);
    STATE.engine = new StockfishEngine(workerUrl);
    try {
      await STATE.engine.init(60_000);
      STATE.engineReady = true;
      const lc0note = STATE.lc0Available ? " · Lc0 ready" : "";
      setStatus(`ready · ${engine.name} (${engine.flavor})${lc0note}`);

      if (!h.claude_configured) {
        appendChat("system",
          "Heads-up: ANTHROPIC_API_KEY is not set on the server, so the coach won't answer. " +
          "Add it to .env and restart the server."
        );
      }
      if (!STATE.lc0Available && STATE.lc0Reason) {
        appendChat("system",
          `Lc0 isn't enabled: ${STATE.lc0Reason}. ` +
          (h.lc0 && h.lc0.hint ? h.lc0.hint : "")
        );
      }
      // Kick off analysis of whatever position is currently displayed (the
      // starting position by default, so explorer-mode users see something
      // right away without having to make a move first).
      analyzeCurrent();
    } catch (e) {
      setStatus("failed to start engine: " + (e.message || e));
    }
  }

  main();
})();
