"use strict";

/**
 * QUEST stats generator.
 *
 *   node stats.js            compute a snapshot and write data/stats.json
 *   node stats.js --print    also dump the snapshot to stdout
 *
 * Run this on a schedule (daily is plenty). The dashboard at stats/index.php
 * only ever reads the JSON file this writes -- it never touches the database.
 * That separation is deliberate: the aggregates below are GROUP BYs over
 * millions of rows, which is fine once a day and ruinous on every page load.
 *
 * Each run also appends a row to stats_history, which is what the growth and
 * throughput charts are drawn from.
 */

const fs = require("node:fs");
const path = require("node:path");
const { QuestSqliteStore } = require("./sqlite_store");
const { EXTRACTOR_VERSION } = require("./extract");

const DATA_DIR = process.env.QUEST_DATA_DIR || path.join(__dirname, "data");
const SQLITE_DB_PATH =
  process.env.QUEST_DB_PATH || path.join(DATA_DIR, "quest.sqlite");
const OUTPUT_PATH =
  process.env.QUEST_STATS_PATH || path.join(DATA_DIR, "stats.json");

// Decompressing every page to measure text length would mean unzipping the
// whole archive. A random sample answers "what shape are these pages?" just as
// well, and the output labels which figures are sampled.
const SAMPLE_SIZE = Number(process.env.QUEST_STATS_SAMPLE || 3000);
const HISTORY_LIMIT = Number(process.env.QUEST_STATS_HISTORY || 400);

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function log(message) {
  console.log(`[stats] ${message}`);
}

/** Run fn, returning [result, elapsedMs]; never throws, reports null instead. */
function timed(label, fn) {
  const started = Date.now();
  try {
    const value = fn();
    return { value, ms: Date.now() - started };
  } catch (error) {
    log(`  ! ${label} failed: ${error?.message}`);
    return { value: null, ms: Date.now() - started, error: String(error?.message || error) };
  }
}

function ensureHistoryTable(store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS stats_history (
      captured_at INTEGER PRIMARY KEY,
      archived_pages INTEGER NOT NULL,
      queue_pending INTEGER NOT NULL,
      html_pages INTEGER NOT NULL,
      search_rows INTEGER NOT NULL,
      db_bytes INTEGER NOT NULL,
      current_version_pages INTEGER NOT NULL
    );
  `);
}

const SIZE_BUCKETS = [
  { label: "0", max: 1 },
  { label: "<500", max: 500 },
  { label: "500–2k", max: 2000 },
  { label: "2k–5k", max: 5000 },
  { label: "5k–20k", max: 20000 },
  { label: "20k–100k", max: 100000 },
  { label: "100k+", max: Infinity },
];

function bucketFor(length) {
  for (const bucket of SIZE_BUCKETS) {
    if (length < bucket.max) {
      return bucket.label;
    }
  }
  return SIZE_BUCKETS[SIZE_BUCKETS.length - 1].label;
}

function detectScript(text) {
  const sample = text.slice(0, 3000);
  if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(sample)) return "CJK";
  if (/[\u0400-\u04ff]/.test(sample)) return "Cyrillic";
  if (/[\u0600-\u06ff]/.test(sample)) return "Arabic";
  if (/[\u0900-\u097f]/.test(sample)) return "Devanagari";
  if (/[a-zA-Z]/.test(sample)) return "Latin";
  return "Other";
}

/** Group hosts into a rough registrable domain (last two labels). */
function registrableDomain(host) {
  const parts = String(host || "").split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host || "(unknown)";
}

function main() {
  const args = process.argv.slice(2);
  const started = Date.now();

  if (!fs.existsSync(SQLITE_DB_PATH)) {
    console.error(`[stats] Database not found: ${SQLITE_DB_PATH}`);
    process.exitCode = 1;
    return;
  }

  log(`Reading ${SQLITE_DB_PATH}`);
  const store = new QuestSqliteStore({ dbPath: SQLITE_DB_PATH });
  ensureHistoryTable(store);

  const snapshot = {
    generatedAt: Date.now(),
    schemaVersion: Number(store.getMeta("schema_version")) || null,
    extractorVersion: EXTRACTOR_VERSION,
    sampleSize: SAMPLE_SIZE,
    errors: [],
  };

  const record = (key, label, fn) => {
    const result = timed(label, fn);
    if (result.error) {
      snapshot.errors.push({ metric: label, error: result.error });
    }
    snapshot[key] = result.value;
    log(`  ${label}: ${result.ms}ms`);
    return result.value;
  };

  // --- corpus ---------------------------------------------------------------
  record("corpus", "corpus totals", () => {
    const html = store.getHtmlStats();
    return {
      archivedPages: store.getRawPageCount(),
      searchRows: store.getSearchIndexCount(),
      htmlPages: html.pages,
      htmlOriginalBytes: html.originalBytes,
      htmlStoredBytes: html.storedBytes,
      textStoredBytes: Number(
        store.db.prepare("SELECT COALESCE(SUM(LENGTH(content)),0) b FROM raw_pages").get()?.b || 0,
      ),
      dbBytes: fileSize(SQLITE_DB_PATH),
      walBytes: fileSize(`${SQLITE_DB_PATH}-wal`),
    };
  });

  // --- queue ----------------------------------------------------------------
  record("queue", "queue composition", () => {
    const byState = store.getQueueStateCounts();
    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    return {
      byState,
      total,
      hosts: Number(
        store.db.prepare("SELECT COUNT(*) c FROM crawl_hosts").get()?.c || 0,
      ),
      distinctQueueHosts: Number(
        store.db.prepare("SELECT COUNT(DISTINCT host) c FROM crawl_queue").get()?.c || 0,
      ),
      // Rows scheduled into the future have been fetched at least once.
      crawled: Number(
        store.db
          .prepare("SELECT COUNT(*) c FROM crawl_queue WHERE next_eligible_at > ?")
          .get(Date.now())?.c || 0,
      ),
    };
  });

  // --- re-archive progress --------------------------------------------------
  record("rearchive", "re-archive progress", () => {
    const archived = snapshot.corpus?.archivedPages || 0;
    const remaining = store.countNeedingRearchive(EXTRACTOR_VERSION);
    return {
      archived,
      remaining,
      current: Math.max(archived - remaining, 0),
      byVersion: store.getExtractorVersionCounts(),
      byState: store.getRearchiveByState(EXTRACTOR_VERSION),
    };
  });

  // --- domains --------------------------------------------------------------
  record("domains", "domain breakdown", () => {
    const queueRows = store.db
      .prepare("SELECT host, COUNT(*) c FROM crawl_queue GROUP BY host")
      .all();

    const byDomain = new Map();
    const byTld = new Map();
    for (const row of queueRows) {
      const domain = registrableDomain(row.host);
      byDomain.set(domain, (byDomain.get(domain) || 0) + row.c);
      const tld = String(row.host || "").split(".").pop() || "?";
      byTld.set(tld, (byTld.get(tld) || 0) + row.c);
    }

    const queueTotal = queueRows.reduce((sum, r) => sum + r.c, 0);
    const topDomains = [...byDomain.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([name, queued]) => ({ name, queued, share: queueTotal ? queued / queueTotal : 0 }));

    // Five named TLDs plus "other" keeps the donut at six segments; past that
    // adjacent slices stop being tellable apart at a glance.
    const tlds = [...byTld.entries()].sort((a, b) => b[1] - a[1]);
    const topTlds = tlds.slice(0, 5).map(([name, count]) => ({ name, count }));
    const otherTld = tlds.slice(5).reduce((sum, [, c]) => sum + c, 0);
    if (otherTld > 0) {
      topTlds.push({ name: "other", count: otherTld });
    }

    return {
      distinctHosts: queueRows.length,
      distinctDomains: byDomain.size,
      queueTotal,
      topDomains,
      tlds: topTlds,
      // How concentrated the frontier is: hosts holding half of all queued URLs.
      hostsForHalf: (() => {
        const sorted = queueRows.map((r) => r.c).sort((a, b) => b - a);
        let cum = 0;
        for (let i = 0; i < sorted.length; i += 1) {
          cum += sorted[i];
          if (cum >= queueTotal / 2) return i + 1;
        }
        return sorted.length;
      })(),
    };
  });

  // --- failures -------------------------------------------------------------
  record("failures", "failure reasons", () => {
    const rows = store.db
      .prepare(
        "SELECT last_note FROM crawl_queue WHERE last_note != '' AND state IN ('failed','pending') LIMIT 200000",
      )
      .all();

    const buckets = new Map();
    for (const row of rows) {
      const note = String(row.last_note || "");
      let key = "other";
      if (/hard timeout/i.test(note)) key = "tarpit / hard timeout";
      else if (/timeout|ETIMEDOUT/i.test(note)) key = "timeout";
      else if (/link cap/i.test(note)) key = "link bomb";
      else if (/status code 4/i.test(note)) key = "4xx not found";
      else if (/status code 5/i.test(note)) key = "5xx server error";
      else if (/Unsupported content type/i.test(note)) key = "not HTML";
      else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(note)) key = "DNS failure";
      else if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(note)) key = "connection refused/reset";
      else if (/certificate|SSL|TLS/i.test(note)) key = "TLS error";
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    return {
      sampled: rows.length,
      reasons: [...buckets.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count })),
    };
  });

  // --- sampled page shape ---------------------------------------------------
  record("pageShape", `page shape (sample of ${SAMPLE_SIZE})`, () => {
    const rows = store.db
      .prepare(
        "SELECT content, content_encoding FROM raw_pages WHERE rowid IN (SELECT rowid FROM raw_pages ORDER BY RANDOM() LIMIT ?)",
      )
      .all(SAMPLE_SIZE);

    const sizes = new Map(SIZE_BUCKETS.map((b) => [b.label, 0]));
    const scripts = new Map();
    let totalChars = 0;
    let analyzed = 0;
    let withStructure = 0;

    for (const row of rows) {
      let text;
      try {
        text = QuestSqliteStore.decodeContent(row.content, row.content_encoding);
      } catch {
        continue;
      }
      analyzed += 1;
      totalChars += text.length;
      sizes.set(bucketFor(text.length), (sizes.get(bucketFor(text.length)) || 0) + 1);
      if (text.includes("\n")) withStructure += 1;
      if (text.length > 0) {
        const script = detectScript(text);
        scripts.set(script, (scripts.get(script) || 0) + 1);
      }
    }

    return {
      analyzed,
      meanChars: analyzed ? Math.round(totalChars / analyzed) : 0,
      // Extractor v1 collapsed all whitespace, so this is a direct read on how
      // much of the archive still carries the old damage.
      withLineStructurePct: analyzed ? withStructure / analyzed : 0,
      sizes: SIZE_BUCKETS.map((b) => ({ bucket: b.label, count: sizes.get(b.label) || 0 })),
      scripts: [...scripts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
    };
  });

  // --- crawler health -------------------------------------------------------
  record("crawler", "crawler health", () => {
    const heartbeat = Number(store.getMeta("crawler_last_heartbeat") || 0);
    const state = store.getMeta("crawler_state") || "unknown";
    const ageMs = heartbeat > 0 ? Date.now() - heartbeat : null;
    return {
      state,
      running: state === "active" && ageMs !== null && ageMs <= 180000,
      heartbeatAt: heartbeat || null,
      heartbeatAgeMs: ageMs,
      startedAt: Number(store.getMeta("crawler_started_at") || 0) || null,
      pagesPerMinute: Number(store.getMeta("crawler_pages_per_minute") || 0) || null,
      processedTotal: Number(store.getMeta("crawler_processed_total") || 0) || null,
      stopReason: store.getMeta("crawler_stop_reason") || "",
    };
  });

  // --- history --------------------------------------------------------------
  try {
    store.db
      .prepare(
        `INSERT INTO stats_history
           (captured_at, archived_pages, queue_pending, html_pages, search_rows, db_bytes, current_version_pages)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.generatedAt,
        snapshot.corpus?.archivedPages || 0,
        snapshot.queue?.byState?.pending || 0,
        snapshot.corpus?.htmlPages || 0,
        snapshot.corpus?.searchRows || 0,
        snapshot.corpus?.dbBytes || 0,
        snapshot.rearchive?.current || 0,
      );
  } catch (error) {
    log(`  ! could not append history: ${error?.message}`);
  }

  snapshot.history = store.db
    .prepare(
      `SELECT captured_at, archived_pages, queue_pending, html_pages, search_rows, db_bytes, current_version_pages
       FROM stats_history ORDER BY captured_at DESC LIMIT ?`,
    )
    .all(HISTORY_LIMIT)
    .reverse()
    .map((row) => ({
      at: Number(row.captured_at),
      archivedPages: Number(row.archived_pages),
      queuePending: Number(row.queue_pending),
      htmlPages: Number(row.html_pages),
      searchRows: Number(row.search_rows),
      dbBytes: Number(row.db_bytes),
      currentVersionPages: Number(row.current_version_pages),
    }));

  snapshot.generatedInMs = Date.now() - started;
  store.close();

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  // Write via a temp file + rename so the dashboard never reads a half-written
  // snapshot if it happens to load mid-generation.
  const tmp = `${OUTPUT_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, OUTPUT_PATH);

  log(`Wrote ${OUTPUT_PATH} in ${snapshot.generatedInMs}ms`);
  if (snapshot.errors.length > 0) {
    log(`${snapshot.errors.length} metric(s) failed; the dashboard will show them as unavailable.`);
  }
  if (args.includes("--print")) {
    console.log(JSON.stringify(snapshot, null, 2));
  }
}

main();
