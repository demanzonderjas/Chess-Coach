/* Chessable → Chess Coach book importer.
 *
 * USAGE:
 *   1. Restart your Chess Coach server (python server.py) so it picks up the
 *      new /api/book/import_chessable endpoint.
 *   2. Open any Chessable chapter page (e.g. https://www.chessable.com/course/59936/3/)
 *      while logged in.
 *   3. Open the browser console (Cmd+Opt+J on macOS / Ctrl+Shift+J on Linux/Win)
 *      and paste the entire contents of this file. The chapter is ingested
 *      directly into your local book.db.
 *   4. Refresh the Chess Coach app — book chips + 📖 board badges should
 *      appear when navigating positions that match a book line.
 *
 * Idempotent — re-running on the same chapter reports already-present lines
 * as "skipped" instead of duplicating them.
 *
 * Tunables (override BEFORE pasting this snippet if you want):
 *   window.__chessCoachUrl  = "http://127.0.0.1:5173";  // local server base
 *   window.__bookColor      = "w";                     // "w" | "b" | null
 *   window.__bookChapter    = "My Chapter Name";       // overrides auto-detect
 */
(async () => {
  const BASE = window.__chessCoachUrl || "http://127.0.0.1:5173";
  const COLOR = window.__bookColor ?? "w";

  // --- Extract chapter metadata + variation cards from the page DOM. -------
  // Chessable renders the course name + chapter as siblings inside
  // `.courseUI-header`:
  //   <div class="courseUI-bookName">Grandmaster Gambits: 1.e4 — Part 1</div>
  //   <h1 class="courseUI-bookChapter">
  //     <a href="/course/59936">Chapters</a>
  //     <i class="fa fa-caret-right"></i>
  //     Theory 1A1: 7... h6           ← trailing text node, the chapter
  //   </h1>
  const courseTitle = (document.querySelector(".courseUI-bookName")?.textContent || "").trim();
  // Pull the trailing text node of the chapter h1 (skips the "Chapters" link
  // and the caret icon). Fallback to stripping the "Chapters" prefix if the
  // markup ever changes.
  let chapterAuto = "";
  const chapterH1 = document.querySelector("h1.courseUI-bookChapter");
  if (chapterH1) {
    const last = chapterH1.lastChild;
    chapterAuto = (last && last.textContent ? last.textContent : "").trim();
    if (!chapterAuto) {
      chapterAuto = chapterH1.textContent.replace(/^Chapters\s*/, "").trim();
    }
  }
  const chapter = (window.__bookChapter || chapterAuto || "Untitled chapter").slice(0, 120);
  const sourceUrl = location.href.replace(/#.*$/, "");

  const cards = Array.from(document.querySelectorAll("li.variation-card")).map((card) => {
    const titleEl = card.querySelector(".variation-card__title, .variation-card__name");
    const movesEl = card.querySelector(".variation-card__moves");
    return {
      id: card.id || "",
      title: titleEl ? titleEl.textContent.trim() : "",
      moves: movesEl ? movesEl.textContent.replace(/\s+/g, " ").trim() : "",
    };
  }).filter((c) => c.title && c.moves);

  if (!cards.length) {
    console.error("[chess-coach] No variation cards found on this page. Is this a Chessable chapter page with variation cards?");
    return;
  }

  console.log(
    `%c[chess-coach] Ingesting ${cards.length} card(s)\n` +
    `  course:  ${courseTitle}\n` +
    `  chapter: ${chapter}\n` +
    `  source:  ${sourceUrl}\n` +
    `  color:   ${COLOR ?? "(unset)"}\n`,
    "color:#f5c060;font-weight:600"
  );

  // --- POST it. ------------------------------------------------------------
  let resp;
  try {
    resp = await fetch(`${BASE}/api/book/import_chessable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        course: courseTitle,
        chapter,
        source_url: sourceUrl,
        color: COLOR,
        cards,
      }),
    });
  } catch (e) {
    console.error(
      "[chess-coach] Could not reach the local Chess Coach server.\n" +
      `Make sure it's running at ${BASE} and that you've restarted it after\n` +
      "adding the /api/book/import_chessable endpoint.\n\nError:", e
    );
    return;
  }
  if (!resp.ok) {
    console.error(`[chess-coach] Server returned ${resp.status}:`, await resp.text());
    return;
  }
  const data = await resp.json();

  // --- Report results. -----------------------------------------------------
  console.log(
    `%c[chess-coach] Done — ${data.inserted.length}/${data.total} inserted` +
    (data.skipped.length ? `, ${data.skipped.length} already present` : "") +
    (data.failed.length ? `, ${data.failed.length} failed` : ""),
    "color:#5dd39e;font-weight:600"
  );
  if (data.inserted.length) {
    console.table(data.inserted);
  }
  if (data.skipped.length) {
    console.log("Skipped (already present):");
    console.table(data.skipped);
  }
  if (data.failed.length) {
    console.warn("Failed:");
    console.table(data.failed);
  }
  return data;
})();
