"use strict";

/**
 * QUEST maintenance tool.
 *
 *   node maintain.js --status            show cache/queue/WAL sizes (default)
 *   node maintain.js --import-legacy     load the old JSON/NDJSON dumps
 *   node maintain.js --rebuild-fts       (re)build the FTS5 search index
 *   node maintain.js --compress          gzip archived page text in place
 *   node maintain.js --checkpoint        fold the WAL back into the database
 *   node maintain.js --vacuum            reclaim free pages (slow, needs space)
 *   node maintain.js --prune-failed      drop permanently dead queue rows
 *   node maintain.js --export-exyra [base]  write exyra.json + exyra.txt from
 *                                         data/exyra.sqlite (--export-honeypots
 *                                         is the old name, still accepted)
 *   node maintain.js --exyra-history     Exyra signals from the crawl queue's
 *                                         failure notes and URL shapes
 *   node maintain.js --scan-exyra        Exyra signals from stored HTML
 *                                         (combine with --index-media: one pass)
 *   node maintain.js --exyra-add URL --note "why"   add a suspect by hand
 *   node maintain.js --exyra-status      counts by category, strongest suspects
 *   node maintain.js --exyra-drop CATEGORY [--source S]   withdraw a category
 *                                         of evidence (rescoring suspects)
 *   node maintain.js --exyra-history --restart   rescan the queue from the top
 *   node maintain.js --exyra-recheck     re-judge stored evidence against the
 *                                         current detector rules; drop what no
 *                                         longer qualifies
 *   node maintain.js --exyra-requeue     put back crawl-queue URLs skipped
 *                                         only because Exyra flagged them
 *   node maintain.js --reextract         re-run extraction over stored HTML,
 *                                         no network needed (prefer this)
 *   node maintain.js --rearchive         queue every page with stale text or
 *                                         missing HTML for an immediate refetch
 *   node maintain.js --rearchive-status  how far along a re-archive pass is
 *   node maintain.js --index-media       build the image index (xImages) and
 *                                         feed list (xWire) from stored HTML;
 *                                         resumable, Ctrl-C stops cleanly;
 *                                         --pause=MS rests between batches
 *   node maintain.js --media-status      image, feed and post counts
 *
 * Safe to run against a database the crawler is using, except for --vacuum,
 * which needs exclusive access.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const zlib = require("node:zlib");
const { QuestSqliteStore } = require("./sqlite_store");
const { siteOf } = require("./site");

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
const { EXTRACTOR_VERSION, extractText, extractTitle, analyzeStored } = require("./extract");
const { CATEGORIES, ExyraStore, WITHHOLD_AT, detectFromNote, detectUrl, exportExyra } = require("./exyra");
const { canonicalUrl, hasSkippedExtension } = require("./urls");
const { ImageStore } = require("./image_store");
const { FeedStore } = require("./feed_store");
const { dataPaths } = require("./paths");

const DATA_DIR = process.env.QUEST_DATA_DIR || path.join(__dirname, "data");
const SQLITE_DB_PATH =
  process.env.QUEST_DB_PATH || path.join(DATA_DIR, "quest.sqlite");

// The old dumps were written to the project root; later versions used data/.
const LEGACY_DIRS = [__dirname, DATA_DIR];

function formatCount(n) {
  return Math.round(Number(n) || 0).toLocaleString("en-US");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function log(message) {
  console.log(`[maintain] ${message}`);
}

function findLegacyFile(name) {
  for (const dir of LEGACY_DIRS) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

// ------------------------------------------------------------------- status

function showStatus(store) {
  const counts = store.refreshCachedCounts();
  const queueStates = store.getQueueStateCounts();

  log(`driver:        ${store.driverName}`);
  log(`database:      ${formatBytes(fileSize(SQLITE_DB_PATH))}`);
  log(`  wal:         ${formatBytes(fileSize(`${SQLITE_DB_PATH}-wal`))}`);
  log(`archived:      ${counts.stat_raw_pages} pages (raw_pages)`);
  log(`indexed:       ${counts.stat_search_index} pages (search_index)`);
  log(`fts5:          ${store.ftsAvailable ? "available" : `unavailable (${store.ftsError})`}`);
  log(
    `queue:         ${Object.entries(queueStates)
      .map(([state, count]) => `${state}=${count}`)
      .join(", ") || "empty"}`,
  );

  const encodings = store.db
    .prepare(
      "SELECT content_encoding AS encoding, COUNT(*) AS count FROM raw_pages GROUP BY content_encoding",
    )
    .all();
  log(
    `content:       ${encodings.map((r) => `${r.encoding}=${r.count}`).join(", ") || "none"}`,
  );

  const htmlStats = store.getHtmlStats();
  log(`html archive:  ${formatCount(htmlStats.pages)} page(s), ${formatBytes(htmlStats.storedBytes)} stored`);
  const remaining = store.countNeedingRearchive(EXTRACTOR_VERSION);
  const archived = counts.stat_raw_pages;
  if (remaining > 0 && archived > 0) {
    const done = archived - remaining;
    log(
      `re-archive:    ${formatCount(done)}/${formatCount(archived)} current ` +
        `(${((done / archived) * 100).toFixed(1)}%), ${formatCount(remaining)} pending`,
    );
  } else {
    log(`re-archive:    complete (all pages on extractor v${EXTRACTOR_VERSION})`);
  }

  const heartbeat = Number(store.getMeta("crawler_last_heartbeat") || 0);
  const state = store.getMeta("crawler_state") || "unknown";
  const ageMs = heartbeat > 0 ? Date.now() - heartbeat : null;
  // A stored state of "active" only means something if the heartbeat is
  // recent; otherwise it is just whatever a past process last wrote before
  // exiting uncleanly or being killed. Mirror the 3-minute cutoff the search
  // page itself uses, so this line and the website never disagree.
  const isLive = state === "active" && ageMs !== null && ageMs <= 180000;
  const ageLabel =
    ageMs === null
      ? ""
      : ageMs < 120000
        ? ` (heartbeat ${Math.round(ageMs / 1000)}s ago)`
        : ` (heartbeat ${(ageMs / 86400000).toFixed(1)}d ago)`;
  log(`crawler:       ${isLive ? "running" : `not running (last state: ${state})`}${ageLabel}`);
}

// ------------------------------------------------------------ legacy import

async function importLegacy(store) {
  if (store.getMeta("legacy_import_complete") === "1") {
    log("Legacy import already recorded as complete; re-running anyway.");
  }

  const searchJson = findLegacyFile("search_index.json");
  if (searchJson) {
    log(`Importing ${searchJson}...`);
    const parsed = JSON.parse(await fsp.readFile(searchJson, "utf8"));
    let imported = 0;
    if (Array.isArray(parsed)) {
      store.db.transaction(() => {
        for (const row of parsed) {
          if (!row || typeof row !== "object" || !row.url) {
            continue;
          }
          store.saveSearchIndex({
            url: String(row.url),
            title: String(row.title || "Untitled"),
            summary: String(row.summary || ""),
            keywords: Array.isArray(row.keywords) ? row.keywords : [],
            timestamp: Number(row.timestamp) || Date.now(),
          });
          imported += 1;
        }
      });
    }
    log(`  ${imported} search rows.`);
  }

  const rawJson = findLegacyFile("raw_pages.json");
  if (rawJson) {
    log(`Importing ${rawJson}...`);
    const parsed = JSON.parse(await fsp.readFile(rawJson, "utf8"));
    let imported = 0;
    if (Array.isArray(parsed)) {
      store.db.transaction(() => {
        for (const row of parsed) {
          if (!row || typeof row !== "object" || !row.url) {
            continue;
          }
          store.saveRawPage({
            url: String(row.url),
            title: String(row.title || "Untitled"),
            content: String(row.content || ""),
            timestamp: Number(row.timestamp) || Date.now(),
          });
          imported += 1;
        }
      });
    }
    log(`  ${imported} raw pages.`);
  }

  const rawNdjson = findLegacyFile("raw_pages.ndjson");
  if (rawNdjson) {
    log(`Importing ${rawNdjson} (batched)...`);
    const reader = readline.createInterface({
      input: fs.createReadStream(rawNdjson, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    // The previous importer ran one implicit transaction per line, which meant
    // ~139k fsyncs. Batching turns that into a few hundred.
    const BATCH = 500;
    let batch = [];
    let imported = 0;

    const flush = () => {
      if (batch.length === 0) {
        return;
      }
      store.db.transaction(() => {
        for (const row of batch) {
          store.saveRawPage(row);
        }
      });
      imported += batch.length;
      batch = [];
      if (imported % 10000 === 0) {
        log(`  ${imported} lines...`);
        store.checkpoint("PASSIVE");
      }
    };

    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const row = JSON.parse(trimmed);
        if (!row || typeof row !== "object" || !row.url) {
          continue;
        }
        batch.push({
          url: String(row.url),
          title: String(row.title || "Untitled"),
          content: String(row.content || ""),
          timestamp: Number(row.timestamp) || Date.now(),
        });
        if (batch.length >= BATCH) {
          flush();
        }
      } catch {
        // Ignore malformed lines.
      }
    }
    flush();
    log(`  ${imported} raw pages.`);
  }

  const crawlState = findLegacyFile("crawl_state.json");
  if (crawlState) {
    log(`Importing frontier from ${crawlState}...`);
    const parsed = JSON.parse(await fsp.readFile(crawlState, "utf8"));
    const pendingByHost = parsed?.pendingByHost || {};
    let added = 0;

    for (const [host, urls] of Object.entries(pendingByHost)) {
      if (!Array.isArray(urls)) {
        continue;
      }
      const entries = urls
        .filter((url) => typeof url === "string" && url)
        .map((url) => ({ url, host: siteOf(host), depth: 0 }));
      for (let i = 0; i < entries.length; i += 2000) {
        added += store.addDiscovered(entries.slice(i, i + 2000));
      }
    }
    log(`  ${added} new queue rows.`);
  }

  store.setMeta("legacy_import_complete", "1");
  log("Legacy import complete.");
}

// -------------------------------------------------------------- compression

function compressContent(store) {
  const before = fileSize(SQLITE_DB_PATH) + fileSize(`${SQLITE_DB_PATH}-wal`);
  const selectBatch = store.db.prepare(
    "SELECT url, content FROM raw_pages WHERE content_encoding = 'utf8' LIMIT ?",
  );
  const update = store.db.prepare(
    "UPDATE raw_pages SET content = ?, content_encoding = 'gzip' WHERE url = ?",
  );

  const BATCH = 200;
  let done = 0;
  let rawBytes = 0;
  let gzipBytes = 0;

  for (;;) {
    const rows = selectBatch.all(BATCH);
    if (rows.length === 0) {
      break;
    }

    store.db.transaction(() => {
      for (const row of rows) {
        const text = typeof row.content === "string" ? row.content : String(row.content ?? "");
        const packed = zlib.gzipSync(Buffer.from(text, "utf8"), { level: 6 });
        rawBytes += Buffer.byteLength(text, "utf8");
        gzipBytes += packed.length;
        update.run(packed, row.url);
      }
    });

    done += rows.length;
    if (done % 5000 < BATCH) {
      log(`  ${done} pages compressed...`);
      store.checkpoint("PASSIVE");
    }
  }

  store.checkpoint("TRUNCATE");
  const after = fileSize(SQLITE_DB_PATH) + fileSize(`${SQLITE_DB_PATH}-wal`);

  log(`Compressed ${done} page(s).`);
  if (done > 0) {
    const ratio = rawBytes > 0 ? (1 - gzipBytes / rawBytes) * 100 : 0;
    log(`  text: ${formatBytes(rawBytes)} -> ${formatBytes(gzipBytes)} (${ratio.toFixed(1)}% smaller)`);
  }
  log(`  db files: ${formatBytes(before)} -> ${formatBytes(after)}`);
  log("Run --vacuum to return the freed pages to the filesystem.");
}

/** Spot-check that compressed rows still decode to their original text. */
function verifyContent(store) {
  const rows = store.db
    .prepare(
      "SELECT url, content, content_encoding FROM raw_pages WHERE content_encoding = 'gzip' LIMIT 25",
    )
    .all();

  let ok = 0;
  for (const row of rows) {
    try {
      const text = QuestSqliteStore.decodeContent(row.content, row.content_encoding);
      if (typeof text === "string" && text.length >= 0) {
        ok += 1;
      }
    } catch (error) {
      log(`  FAILED to decode ${row.url}: ${error?.message}`);
    }
  }
  log(`Verified ${ok}/${rows.length} sampled compressed page(s) decode cleanly.`);
}

// --------------------------------------------------- rearchive / reextract

/**
 * How much of the archive is stored the way the current code wants it.
 * "Current" means: text produced by the current extractor, and HTML kept so
 * future extractor changes need no refetch.
 */
function rearchiveStatus(store) {
  const archived = store.getRawPageCount();
  const byVersion = store.getExtractorVersionCounts();
  const html = store.getHtmlStats();
  const remaining = store.countNeedingRearchive(EXTRACTOR_VERSION);
  const current = archived - remaining;

  log(`extractor version in use: v${EXTRACTOR_VERSION}`);
  log(`archived pages: ${formatCount(archived)}`);
  for (const [version, count] of Object.entries(byVersion)) {
    const tag = Number(version) >= EXTRACTOR_VERSION ? "current" : "STALE";
    log(`  text from extractor v${version}: ${formatCount(count)}  (${tag})`);
  }
  log(`HTML archived: ${formatCount(html.pages)} page(s)`);
  if (html.pages > 0) {
    log(`  original: ${formatBytes(html.originalBytes)}, stored: ${formatBytes(html.storedBytes)}`);
    log(
      `  avg ${formatBytes(html.originalBytes / html.pages)}/page -> ${formatBytes(html.storedBytes / html.pages)} compressed`,
    );
  }

  const pctDone = archived > 0 ? (current / archived) * 100 : 100;
  log("");
  log(`re-archive progress: ${formatCount(current)}/${formatCount(archived)} (${pctDone.toFixed(1)}%)`);

  if (remaining > 0) {
    const byState = store.getRearchiveByState(EXTRACTOR_VERSION);
    const reachable = byState.pending || 0;
    const active = byState.active || 0;
    const unreachable = (byState.blocked || 0) + (byState.failed || 0);
    const orphaned = byState["not-queued"] || 0;

    log(`  ${formatCount(remaining)} page(s) still stale:`);
    if (reachable + active > 0) {
      log(`    ${formatCount(reachable + active)} queued and reachable -- these will be refetched`);
    }
    if (unreachable > 0) {
      log(
        `    ${formatCount(unreachable)} blocked/failed -- unreachable, progress will plateau here`,
      );
    }
    if (orphaned > 0) {
      log(`    ${formatCount(orphaned)} not in the queue at all`);
    }

    // The floor progress can actually reach, given what is unreachable.
    if (unreachable + orphaned > 0) {
      const attainable = archived - unreachable - orphaned;
      log(
        `  realistic target: ${formatCount(attainable)}/${formatCount(archived)} ` +
          `(${((attainable / Math.max(archived, 1)) * 100).toFixed(1)}%)`,
      );
    }

    const reextractable = Math.min(html.pages, remaining);
    if (reextractable > 0) {
      log(`  ${formatCount(reextractable)} have stored HTML already -> --reextract fixes those with no network`);
    }
  } else {
    log("  nothing outstanding");
  }

  return { archived, remaining, current };
}

/**
 * Re-run the current extractor over already-stored HTML. This is the whole
 * point of keeping raw_html: a text fix costs a local pass, not a crawl.
 */
/**
 * Fill the image index and the feed list from HTML already stored, with no
 * network. Walks raw_html in rowid order and saves its position after every
 * batch, so it can be stopped (Ctrl-C) and rerun to carry on. Safe to run
 * while the crawler is running: it only reads quest.sqlite.
 */
async function storedPass(store, { media: doMedia = true, exyra: doExyra = false } = {}, pauseMs = 0) {
  const BATCH = 100;
  const paths = dataPaths();
  const images = doMedia ? new ImageStore({ dbPath: paths.images }) : null;
  const feeds = doMedia ? new FeedStore({ dbPath: paths.feeds }) : null;
  const exyra = doExyra ? openExyra() : null;
  let stop = false;
  const onSignal = () => {
    if (stop) process.exit(130);
    stop = true;
    log("Stopping after this batch (Ctrl-C again to quit now; progress is saved per batch).");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // Each job keeps its own place; the pass starts at whichever is behind.
    const mediaCursor = doMedia ? Number(images.getMeta("backfill_rowid") || 0) : Infinity;
    const exyraCursor = doExyra ? Number(exyra.getMeta("scan_rowid") || 0) : Infinity;
    let cursor = Math.min(mediaCursor, exyraCursor);
    const last = store.maxRawHtmlRowid();
    log(`Going through stored HTML for ${[doMedia && "media (images, feeds)", doExyra && "Exyra signals"].filter(Boolean).join(" and ")}.`);
    log(cursor > 0 ? `Resuming after row ${formatCount(cursor)} of ${formatCount(last)}.` : `${formatCount(last)} stored pages to go through.`);

    const startedAt = Date.now();
    const startCursor = cursor;
    let pages = 0;
    let imageCount = 0;
    let newFeeds = 0;
    let failed = 0;
    let suspects = 0;
    let lastLog = 0;
    while (!stop) {
      const rows = store.getRawHtmlAfter(cursor, BATCH);
      if (rows.length === 0) break;
      for (const row of rows) {
        const wantMedia = doMedia && row.rowid > mediaCursor;
        const wantExyra = doExyra && row.rowid > exyraCursor;
        try {
          const found = analyzeStored(row.html, row.url, { media: wantMedia, exyra: wantExyra });
          if (wantMedia) {
            imageCount += images.savePage(row.url, found.title, found.images);
            newFeeds += feeds.addDiscovered(found.feeds, row.url);
          }
          if (wantExyra) {
            const signals = [...found.exyra, ...detectUrl(row.url).signals];
            if (signals.length > 0) suspects += exyra.record(row.url, signals, { source: "stored-html" });
          }
        } catch {
          failed += 1;
        }
        pages += 1;
      }
      cursor = rows[rows.length - 1].rowid;
      if (doMedia && cursor > mediaCursor) images.setMeta("backfill_rowid", cursor);
      if (doExyra && cursor > exyraCursor) exyra.setMeta("scan_rowid", cursor);
      // Let signals in (a loop that never yields can't hear Ctrl-C), and on a
      // shared server, leave the disk to the website and crawler for a while.
      await new Promise((resolve) => (pauseMs > 0 ? setTimeout(resolve, pauseMs) : setImmediate(resolve)));
      if (Date.now() - lastLog > 30000) {
        lastLog = Date.now();
        const perMin = ((cursor - startCursor) / Math.max(1, (Date.now() - startedAt) / 60000));
        const eta = perMin > 0 ? (last - cursor) / perMin : 0;
        log(
          `  ${((cursor / Math.max(last, 1)) * 100).toFixed(1)}%: ${formatCount(pages)} pages, ` +
            `${formatCount(imageCount)} images, ${formatCount(newFeeds)} new feeds, ${formatCount(suspects)} new suspects` +
            (eta > 0 ? `, ~${eta < 120 ? `${Math.round(eta)} min` : `${(eta / 60).toFixed(1)} h`} left` : ""),
        );
      }
    }
    log(
      `${stop ? "Stopped" : "Done"}: ${formatCount(pages)} pages, ${formatCount(imageCount)} images, ` +
        `${formatCount(newFeeds)} new feeds, ${formatCount(suspects)} new suspects${failed ? `, ${failed} page(s) failed to parse` : ""}.`,
    );
    if (stop) log("Run the same command again to continue.");
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    images?.close();
    feeds?.close();
    exyra?.close();
  }
}

function mediaStatus(store) {
  const paths = dataPaths();
  const images = new ImageStore({ dbPath: paths.images });
  const feeds = new FeedStore({ dbPath: paths.feeds });
  try {
    const c = images.counts();
    const cursor = Number(images.getMeta("backfill_rowid") || 0);
    const last = store.maxRawHtmlRowid();
    log(`images:   ${formatCount(c.images)} distinct, on ${formatCount(c.pages)} pages (${formatBytes(fileSize(paths.images))})`);
    log(`backfill: ${cursor >= last ? "complete" : `${((cursor / Math.max(last, 1)) * 100).toFixed(1)}% (row ${formatCount(cursor)} of ${formatCount(last)})`}`);
    log(`feeds:    ${JSON.stringify(feeds.stateCounts())} (${formatBytes(fileSize(paths.feeds))})`);
    log(`posts:    ${formatCount(feeds.postCount())}`);
    const heartbeat = Number(feeds.getMeta("feeds_heartbeat") || 0);
    log(`reader:   ${feeds.getMeta("feeds_state") || "never run"}${heartbeat ? `, last heartbeat ${Math.round((Date.now() - heartbeat) / 1000)}s ago` : ""}`);
  } finally {
    images.close();
    feeds.close();
  }
}

function reextract(store) {
  const BATCH = 200;
  let done = 0;
  let failed = 0;
  const startedAt = Date.now();

  const totalStale = store.db
    .prepare(
      "SELECT COUNT(*) c FROM raw_pages p JOIN raw_html h ON h.url = p.url WHERE p.extractor_version < ?",
    )
    .get(EXTRACTOR_VERSION).c;

  if (totalStale === 0) {
    log("Nothing to re-extract: every page with stored HTML is already current.");
    return;
  }

  log(`Re-extracting ${formatCount(totalStale)} page(s) from stored HTML...`);

  for (;;) {
    const rows = store.getStaleForReextract(EXTRACTOR_VERSION, BATCH);
    if (rows.length === 0) {
      break;
    }

    store.db.transaction(() => {
      for (const row of rows) {
        try {
          store.saveReextractedPage(
            row.url,
            extractTitle(row.html),
            extractText(row.html),
            EXTRACTOR_VERSION,
          );
        } catch (error) {
          failed += 1;
          // Still advance the version so a single unparseable page cannot
          // wedge the loop into re-selecting it forever.
          store.saveReextractedPage(row.url, "Untitled", "", EXTRACTOR_VERSION);
        }
      }
    });

    done += rows.length;
    if (done % 2000 < BATCH) {
      const rate = done / Math.max((Date.now() - startedAt) / 1000, 0.001);
      const etaSec = (totalStale - done) / Math.max(rate, 0.001);
      log(
        `  ${formatCount(done)}/${formatCount(totalStale)} (${((done / totalStale) * 100).toFixed(1)}%) ` +
          `${rate.toFixed(0)}/s, eta ${etaSec < 120 ? etaSec.toFixed(0) + "s" : (etaSec / 60).toFixed(1) + " min"}`,
      );
      store.checkpoint("PASSIVE");
    }
  }

  store.checkpoint("TRUNCATE");
  const elapsed = (Date.now() - startedAt) / 1000;
  log(`Re-extracted ${formatCount(done)} page(s) in ${elapsed.toFixed(0)}s${failed ? `, ${failed} failed` : ""}.`);
  log("Note: the search index still holds the old summaries/keywords for these");
  log("      pages. They refresh on the next crawl of each page.");
}

// ------------------------------------------------------------------ exyra

function openExyra() {
  return new ExyraStore({ dbPath: dataPaths().exyra });
}

/** "--flag value" -> value, if the next argument isn't another flag. */
function argAfter(args, flag) {
  const next = args[args.indexOf(flag) + 1];
  return next && !next.startsWith("--") ? next : null;
}

/**
 * Exyra signals already sitting in the crawl queue: every failure note from
 * every run so far (tarpits, bombs, stalls, refusals, redirect loops, link
 * floods), and the shape of every queued URL (spider traps). Reads in rowid
 * batches -- one long read would hold up the crawler's checkpoints -- and
 * saves its place, so it can be stopped and rerun.
 */
async function exyraFromHistory(store, pauseMs = 0) {
  const exyra = openExyra();
  const BATCH = 5000;
  const select = store.db.prepare(
    "SELECT rowid AS rowid, url, last_note FROM crawl_queue WHERE rowid > ? ORDER BY rowid LIMIT ?",
  );
  const last = Number(store.db.prepare("SELECT MAX(rowid) AS m FROM crawl_queue").get()?.m || 0);
  if (process.argv.includes("--restart")) exyra.setMeta("history_rowid", 0);
  let cursor = Number(exyra.getMeta("history_rowid") || 0);
  let stop = false;
  const onSignal = () => {
    if (stop) process.exit(130);
    stop = true;
    log("Stopping after this batch (progress is saved).");
  };
  process.on("SIGINT", onSignal);
  try {
    log(`Scanning the crawl queue's history for Exyra signals (${formatCount(last)} rows${cursor ? `, resuming after ${formatCount(cursor)}` : ""}).`);
    let rows = 0;
    let fresh = 0;
    let lastLog = Date.now();
    while (!stop) {
      const batch = select.all(cursor, BATCH);
      if (batch.length === 0) break;
      exyra.db.transaction(() => {
        for (const row of batch) {
          const signals = [...detectUrl(row.url).signals, ...detectFromNote(row.url, row.last_note)];
          if (signals.length > 0) fresh += exyra.record(row.url, signals, { source: "history" });
        }
      });
      rows += batch.length;
      cursor = Number(batch[batch.length - 1].rowid);
      exyra.setMeta("history_rowid", cursor);
      if (Date.now() - lastLog > 30000) {
        lastLog = Date.now();
        log(`  ${((cursor / Math.max(last, 1)) * 100).toFixed(1)}%: ${formatCount(rows)} rows, ${formatCount(fresh)} new suspects`);
      }
      await new Promise((resolve) => (pauseMs > 0 ? setTimeout(resolve, pauseMs) : setImmediate(resolve)));
    }
    log(`${stop ? "Stopped" : "Done"}: ${formatCount(rows)} queue rows, ${formatCount(fresh)} new suspects.`);
  } finally {
    process.off("SIGINT", onSignal);
    exyra.close();
  }
}

/**
 * Put back URLs the crawler skipped only because Exyra flagged them: links
 * hidden from readers and trap-shaped URLs. Nothing under the withhold
 * rating should be missing from the crawl. Safe to rerun; URLs already
 * queued are untouched.
 */
function exyraRequeue(store) {
  const exyra = openExyra();
  try {
    const select = exyra.db.prepare(`
      SELECT s.id AS id, s.url AS url FROM signals s JOIN suspects u ON u.url = s.url
      WHERE s.id > ? AND s.category IN ('hidden-link-target', 'spider-trap-url') AND u.suspicion < ?
      ORDER BY s.id LIMIT 5000
    `);
    let cursor = 0;
    let seen = 0;
    let added = 0;
    for (;;) {
      const rows = select.all(cursor, WITHHOLD_AT - 1e-9);
      if (rows.length === 0) break;
      cursor = Number(rows[rows.length - 1].id);
      const entries = [];
      for (const { url } of rows) {
        const canonical = canonicalUrl(url);
        if (!canonical || hasSkippedExtension(canonical) || /\/robots\.txt$/i.test(canonical) || exyra.isWithheld(canonical)) continue;
        entries.push({ url: canonical, host: siteOf(new URL(canonical).hostname), depth: 1 });
      }
      seen += rows.length;
      if (entries.length > 0) added += store.addDiscovered(entries);
    }
    log(`Checked ${formatCount(seen)} Exyra-flagged link(s); ${formatCount(added)} were missing from the crawl queue and are back in it.`);
  } finally {
    exyra.close();
  }
}

function exyraStatus() {
  const exyra = openExyra();
  try {
    const { suspects, byCategory } = exyra.counts();
    log(`exyra: ${formatCount(suspects)} suspects (${formatBytes(fileSize(dataPaths().exyra))}); last export ${exyra.getMeta("last_export") || "never"}`);
    for (const [category, count] of Object.entries(byCategory)) {
      log(`  ${category.padEnd(26)} ${formatCount(count)}  (weight ${CATEGORIES[category]?.[0] ?? "?"})`);
    }
    const top = exyra.db
      .prepare("SELECT suspicion, categories, url FROM suspects ORDER BY suspicion DESC, score DESC, last_seen DESC LIMIT 15")
      .all();
    if (top.length > 0) {
      log("most suspicious:");
      for (const row of top) log(`  ${String(Math.round(row.suspicion * 100)).padStart(3)}%  ${row.url}  [${row.categories}]`);
    }
  } finally {
    exyra.close();
  }
}

// --------------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const want = (flag) => args.includes(flag);
  const anyAction =
    want("--import-legacy") ||
    want("--rebuild-fts") ||
    want("--compress") ||
    want("--checkpoint") ||
    want("--vacuum") ||
    want("--prune-failed") ||
    want("--export-honeypots") ||
    want("--export-exyra") ||
    want("--exyra-history") ||
    want("--scan-exyra") ||
    want("--exyra-add") ||
    want("--exyra-status") ||
    want("--exyra-drop") ||
    want("--exyra-recheck") ||
    want("--exyra-requeue") ||
    want("--reextract") ||
    want("--rearchive") ||
    want("--rearchive-status") ||
    want("--index-media") ||
    want("--media-status");

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = new QuestSqliteStore({ dbPath: SQLITE_DB_PATH });

  try {
    if (want("--import-legacy")) {
      await importLegacy(store);
    }

    if (want("--compress")) {
      log("Compressing archived page text...");
      compressContent(store);
      verifyContent(store);
    }

    if (want("--rebuild-fts")) {
      log("Rebuilding FTS5 index...");
      log(store.rebuildFtsIndex() ? "  done." : "  FTS5 unavailable; skipped.");
    }

    // Always cheaper than --rearchive, so it runs first: any page whose HTML
    // we already have never needs to go back over the network.
    if (want("--reextract")) {
      reextract(store);
    }

    if (want("--rearchive")) {
      const before = rearchiveStatus(store);
      log("");
      if (before.remaining === 0) {
        log("Nothing to re-archive.");
      } else {
        const marked = store.markForRearchive(EXTRACTOR_VERSION);
        log(`Queued ${formatCount(marked)} page(s) for immediate refetch.`);
        log("The crawl queue and search index are untouched -- only the fetch");
        log("schedule moved. Start (or leave running) quest.js and it will work");
        log("through them; progress shows in its status line and in");
        log("`node maintain.js --rearchive-status`.");
      }
    }

    if (want("--rearchive-status")) {
      rearchiveStatus(store);
    }

    const pauseArg = args.find((a) => a.startsWith("--pause="));
    const pauseMs = pauseArg ? Math.max(0, Number(pauseArg.slice(8)) || 0) : 0;

    if (want("--index-media") || want("--scan-exyra")) {
      await storedPass(store, { media: want("--index-media"), exyra: want("--scan-exyra") }, pauseMs);
    }

    if (want("--exyra-recheck")) {
      const exyra = openExyra();
      try {
        const result = exyra.recheckSignals();
        for (const [category, count] of Object.entries(result.dropped)) {
          log(`  ${category.padEnd(26)} ${formatCount(count)} no longer qualify`);
        }
        log(`Rechecked Exyra evidence against the current rules; ${formatCount(result.removed)} suspect(s) had nothing left and were removed.`);
      } finally {
        exyra.close();
      }
    }

    // Before any rescans, so a corrected detector can repopulate a category.
    if (want("--exyra-drop")) {
      const category = argAfter(args, "--exyra-drop");
      if (!category || !CATEGORIES[category]) throw new Error(`--exyra-drop needs a category: ${Object.keys(CATEGORIES).join(", ")}`);
      const source = argAfter(args, "--source");
      const exyra = openExyra();
      try {
        const result = exyra.dropSignals(category, source);
        log(`Dropped ${formatCount(result.signals)} ${category} signal(s)${source ? ` from ${source}` : ""}; ${formatCount(result.removed)} suspect(s) had nothing else and were removed.`);
      } finally {
        exyra.close();
      }
    }

    if (want("--exyra-requeue")) {
      exyraRequeue(store);
    }

    if (want("--exyra-history")) {
      await exyraFromHistory(store, pauseMs);
    }

    if (want("--exyra-add")) {
      const url = argAfter(args, "--exyra-add");
      if (!url || !/^https?:\/\//i.test(url)) throw new Error("--exyra-add needs a URL");
      const note = argAfter(args, "--note") || "added by hand";
      const exyra = openExyra();
      try {
        exyra.record(url, [{ category: "manual", detail: note }], { source: "manual" });
      } finally {
        exyra.close();
      }
      log(`Added ${url} to Exyra: ${note}`);
    }

    if (want("--media-status")) {
      mediaStatus(store);
    }

    // Last of the Exyra steps, so one command can add, scan and export.
    if (want("--export-exyra") || want("--export-honeypots")) {
      const base = argAfter(args, want("--export-exyra") ? "--export-exyra" : "--export-honeypots");
      const exyra = openExyra();
      try {
        const result = exportExyra(exyra, base ? base.replace(/\.(json|txt)$/i, "") : path.join(__dirname, "exyra"));
        log(`Exported ${formatCount(result.count)} Exyra suspect(s):`);
        for (const [category, count] of Object.entries(result.byCategory).sort((a, b) => b[1] - a[1])) {
          log(`  ${category.padEnd(26)} ${formatCount(count)}`);
        }
        log(`  ${result.jsonPath}`);
        log(`  ${result.txtPath}`);
      } finally {
        exyra.close();
      }
    }

    if (want("--exyra-status")) {
      exyraStatus();
    }

    if (want("--prune-failed")) {
      const result = store.db
        .prepare("DELETE FROM crawl_queue WHERE state IN ('failed', 'blocked')")
        .run();
      log(`Pruned ${Number(result?.changes || 0)} dead queue row(s).`);
    }

    if (want("--checkpoint")) {
      const walBefore = fileSize(`${SQLITE_DB_PATH}-wal`);
      const result = store.checkpoint("TRUNCATE");
      const walAfter = fileSize(`${SQLITE_DB_PATH}-wal`);
      log(
        `Checkpoint: WAL ${formatBytes(walBefore)} -> ${formatBytes(walAfter)}` +
          (result?.busy ? " (busy: another connection held the WAL)" : ""),
      );
    }

    if (want("--vacuum")) {
      const before = fileSize(SQLITE_DB_PATH);
      log("Vacuuming (this can take several minutes)...");
      store.db.exec("VACUUM");
      // In WAL mode the rebuilt database lands in the WAL first, so the main
      // file only shrinks once it is checkpointed back.
      store.checkpoint("TRUNCATE");
      log(`Database: ${formatBytes(before)} -> ${formatBytes(fileSize(SQLITE_DB_PATH))}`);
    }

    if (!anyAction || want("--status")) {
      showStatus(store);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(`[maintain] Failed: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
