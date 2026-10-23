"use strict";

const zlib = require("node:zlib");
const { QuestDatabase, toBuffer } = require("./db");
const { siteOf } = require("./site");

const SCHEMA_VERSION = 5;

// crawl_hosts.next_due_at for a host with nothing pending: never due.
const NEVER_DUE = 9000000000000000;

// Bump when installDueTriggers' definitions change; existing databases then
// get them rebuilt on their next open, and only then.
const DUE_TRIGGERS_VERSION = 2;

/**
 * Coerce a scheduling timestamp. A NaN or undefined here would bind as NULL and
 * blow up the NOT NULL constraint mid-crawl, so fall back to "due now".
 */
function scheduleTime(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms) : Date.now();
}

/**
 * Storage layer for QUEST.
 *
 * The crawl frontier lives in SQLite and is mutated one row at a time. Nothing
 * here loads the frontier into memory, and nothing rewrites it wholesale --
 * that was the dominant cost in the previous design.
 *
 * Three caches are maintained, and all are authoritative:
 *   raw_html     -- the original HTML exactly as fetched (gzipped)
 *   raw_pages    -- text extracted from that HTML (gzipped)
 *   search_index -- title/summary/keywords, mirrored into an FTS5 index
 *
 * raw_html is the source of truth. Keeping it means a change to the extractor
 * only needs a re-extract pass over local data, never another crawl.
 */
class QuestSqliteStore {
  constructor(options) {
    this.dbPath = options.dbPath;
    this.compressContent = options.compressContent !== false;
    this.storeHtml = options.storeHtml !== false;
    this.maxStoredHtmlBytes = options.maxStoredHtmlBytes ?? 2 * 1024 * 1024;

    this.db = new QuestDatabase(this.dbPath);
    this.driverName = this.db.driverName;

    this.db.pragmaSet("journal_mode = WAL");
    this.db.pragmaSet("synchronous = NORMAL");
    this.db.pragmaSet("temp_store = MEMORY");
    this.db.pragmaSet("busy_timeout = 10000");
    // Keep the WAL from growing without bound; 64 MB of frames is plenty of
    // headroom between checkpoints and stops readers paying for a huge index.
    this.db.pragmaSet("journal_size_limit = 67108864");
    this.db.pragmaSet("cache_size = -20000");

    // A second connection to a database another connection has already
    // opened (e.g. the crawler's background thread) skips the migration.
    if (options.migrate !== false) {
      this.migrateSchema();
    }
    this.prepareStatements();
  }

  // --------------------------------------------------------------- schema

  migrateSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS raw_pages (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS search_index (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crawl_queue (
        url TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        discovered_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crawl_hosts (
        host TEXT PRIMARY KEY,
        order_index INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS domain_budget (
        host TEXT NOT NULL,
        day_key TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (host, day_key)
      );

      CREATE TABLE IF NOT EXISTS blacklist_rules (
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (kind, value)
      );

      -- The HTML exactly as fetched. Deliberately a separate table: these rows
      -- are an order of magnitude larger than anything else here, and keeping
      -- them apart means they can be pruned or dropped wholesale without
      -- touching the text archive or the search index.
      CREATE TABLE IF NOT EXISTS raw_html (
        url TEXT PRIMARY KEY,
        html BLOB NOT NULL,
        html_encoding TEXT NOT NULL DEFAULT 'gzip',
        byte_length INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_search_timestamp ON search_index(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_budget_day ON domain_budget(day_key);
    `);

    this.addColumnIfMissing("crawl_queue", "state", "TEXT NOT NULL DEFAULT 'pending'");
    this.addColumnIfMissing("crawl_queue", "attempts", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("crawl_queue", "depth", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing(
      "crawl_queue",
      "next_eligible_at",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.addColumnIfMissing(
      "crawl_hosts",
      "next_available_at",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // When this host's earliest pending URL is due; kept current by triggers
    // (see migrateHostDueTimes). Defaults to "never" so a host row created
    // before its first URL can't look claimable.
    const dueColumnAdded = this.addColumnIfMissing(
      "crawl_hosts",
      "next_due_at",
      `INTEGER NOT NULL DEFAULT ${NEVER_DUE}`,
    );
    this.addColumnIfMissing(
      "raw_pages",
      "content_encoding",
      "TEXT NOT NULL DEFAULT 'utf8'",
    );
    // Which extractor produced this row's text. Existing rows default to 1,
    // the original $("body").text() extractor, so they are correctly reported
    // as stale and picked up by --reextract / --rearchive.
    this.addColumnIfMissing(
      "raw_pages",
      "extractor_version",
      "INTEGER NOT NULL DEFAULT 1",
    );
    // Free-text note on why a URL last failed or was flagged -- not just a
    // pass/fail bit. This is what lets a later export tell a tarpit apart
    // from a plain dead link instead of lumping every failure together.
    this.addColumnIfMissing("crawl_queue", "last_note", "TEXT NOT NULL DEFAULT ''");

    // The scheduler picks a host first (see claimNext), then the oldest-due
    // URL on that host, so the index it needs is per-host, not global.
    //
    // Deliberately no index on state alone, and no plain index on
    // next_eligible_at: either invites the planner to rank the whole frontier
    // by urgency and hand every claim to whichever host has the most overdue
    // backlog, which is exactly the pile-up this schema is designed to avoid.
    this.db.exec(`
      DROP INDEX IF EXISTS idx_queue_host;
      DROP INDEX IF EXISTS idx_queue_state;
      DROP INDEX IF EXISTS idx_queue_ready;
      CREATE INDEX IF NOT EXISTS idx_queue_host_ready
        ON crawl_queue(host, next_eligible_at) WHERE state = 'pending';
      CREATE INDEX IF NOT EXISTS idx_queue_last_note
        ON crawl_queue(host) WHERE last_note != '';
      -- Answers "which pages still need re-archiving?" from the index alone.
      -- Carrying url as well as extractor_version is the whole point: the
      -- previous index held only the version, so any query that also needed
      -- url (to check raw_html) fell back to scanning raw_pages itself --
      -- every row, every stored page's content, gigabytes in production --
      -- and the crawler ran one of those every 60 seconds on its event loop.
      DROP INDEX IF EXISTS idx_raw_extractor;
      CREATE INDEX IF NOT EXISTS idx_raw_version_url
        ON raw_pages(extractor_version, url);
    `);

    const previousVersion = Number(
      this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0,
    );
    if (previousVersion > 0 && previousVersion < 5) {
      // Rebuilds crawl_hosts with exact due times, so no separate backfill.
      this.migrateHostsToSites();
    } else {
      this.migrateHostDueTimes(dueColumnAdded);
    }
    this.installDueTriggers();

    this.ensureFtsIndex();

    // Written only when it changes: an unconditional write here needed the
    // database's write lock on every open.
    if (previousVersion !== SCHEMA_VERSION) {
      this.db
        .prepare(
          "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(SCHEMA_VERSION));
    }
  }

  /**
   * crawl_hosts.next_due_at = MIN(next_eligible_at) over the host's pending
   * URLs, so the scheduler finds a claimable host with one index seek instead
   * of walking every host checking whether it has anything due. That walk
   * cost ~0.4s per claim once hundreds of thousands of finished hosts
   * (everything booked weeks out) sat at the front of it.
   *
   * Triggers keep the column exact on every write path -- claim, complete,
   * reschedule, re-archive marking, pruning -- without callers knowing:
   *   a URL becomes due sooner -> MIN(current, new), no lookup needed
   *   the earliest URL leaves or moves later -> recompute from the per-host
   *     index (skipped when the URL wasn't the earliest)
   */
  migrateHostDueTimes(backfill) {
    if (backfill) {
      // One-time: one index lookup per host.
      this.db.exec(`
        UPDATE crawl_hosts SET next_due_at = COALESCE(
          (SELECT MIN(q.next_eligible_at) FROM crawl_queue q
           WHERE q.host = crawl_hosts.host AND q.state = 'pending'),
          ${NEVER_DUE});
      `);
    }
  }

  /**
   * Schema 5: crawl_queue.host holds the site (see site.js), not the
   * hostname, so cooldown, fairness and the daily budget apply to a whole
   * site. One pass over the queue, then crawl_hosts is rebuilt from it with
   * exact due times. domain_budget was keyed by hostname, so today's counts
   * restart.
   */
  migrateHostsToSites() {
    this.db.defineFunction("quest_site", (host) => siteOf(host));
    this.db.transaction(() => {
      this.db.exec(`
        UPDATE crawl_queue SET host = quest_site(host) WHERE host != quest_site(host);
        DELETE FROM crawl_hosts;
        INSERT INTO crawl_hosts(host, order_index, next_available_at, next_due_at)
          SELECT host, 0, 0,
                 COALESCE(MIN(CASE WHEN state = 'pending' THEN next_eligible_at END), ${NEVER_DUE})
          FROM crawl_queue GROUP BY host;
        DELETE FROM domain_budget;
      `);
    });
  }

  installDueTriggers() {
    // Only when missing or out of date: rewriting them on every open took a
    // write lock on the whole database each time maintain.js or a site
    // opened it, and failed whenever the crawler held that lock.
    const installed = this.db.prepare("SELECT value FROM meta WHERE key = 'due_triggers_version'").get()?.value;
    const present = this.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_queue_due_%'")
      .get().n;
    if (Number(installed) === DUE_TRIGGERS_VERSION && Number(present) === 4) {
      return;
    }

    const recomputeOld = `
        UPDATE crawl_hosts SET next_due_at = COALESCE(
          (SELECT MIN(q.next_eligible_at) FROM crawl_queue q
           WHERE q.host = OLD.host AND q.state = 'pending'),
          ${NEVER_DUE})
        WHERE host = OLD.host AND next_due_at >= OLD.next_eligible_at;`;

    // Dropped and recreated together, so a changed definition takes effect
    // on existing databases too.
    this.db.exec(`
      DROP TRIGGER IF EXISTS trg_queue_due_insert;
      DROP TRIGGER IF EXISTS trg_queue_due_sooner;
      DROP TRIGGER IF EXISTS trg_queue_due_later;
      DROP TRIGGER IF EXISTS trg_queue_due_delete;

      CREATE TRIGGER trg_queue_due_insert
      AFTER INSERT ON crawl_queue WHEN NEW.state = 'pending'
      BEGIN
        INSERT INTO crawl_hosts(host, order_index, next_available_at, next_due_at)
        VALUES(NEW.host, 0, 0, NEW.next_eligible_at)
        ON CONFLICT(host) DO UPDATE SET next_due_at = MIN(next_due_at, excluded.next_due_at);
      END;

      -- An upsert, like the insert trigger: a URL can come back to pending
      -- (released, unclaimed) on a site that has no crawl_hosts row.
      CREATE TRIGGER trg_queue_due_sooner
      AFTER UPDATE OF state, next_eligible_at ON crawl_queue
      WHEN NEW.state = 'pending'
        AND (OLD.state != 'pending' OR NEW.next_eligible_at < OLD.next_eligible_at)
      BEGIN
        INSERT INTO crawl_hosts(host, order_index, next_available_at, next_due_at)
        VALUES(NEW.host, 0, 0, NEW.next_eligible_at)
        ON CONFLICT(host) DO UPDATE SET next_due_at = MIN(next_due_at, excluded.next_due_at);
      END;

      CREATE TRIGGER trg_queue_due_later
      AFTER UPDATE OF state, next_eligible_at ON crawl_queue
      WHEN OLD.state = 'pending'
        AND (NEW.state != 'pending' OR NEW.next_eligible_at > OLD.next_eligible_at)
      BEGIN${recomputeOld}
      END;

      CREATE TRIGGER trg_queue_due_delete
      AFTER DELETE ON crawl_queue WHEN OLD.state = 'pending'
      BEGIN${recomputeOld}
      END;

      -- Claimable = off cooldown AND something due, i.e. the later of the two
      -- has passed. Ordering by that same value serves whichever host has
      -- been claimable longest; a host just served goes to the back.
      DROP INDEX IF EXISTS idx_hosts_available;
      CREATE INDEX IF NOT EXISTS idx_hosts_ready
        ON crawl_hosts(MAX(next_available_at, next_due_at));
    `);
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES ('due_triggers_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(DUE_TRIGGERS_VERSION));
  }

  addColumnIfMissing(table, column, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => row.name === column)) {
      return false;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  ensureFtsIndex() {
    // The triggers below only fire on future writes, so a table created against
    // an existing search_index would sit empty and every search would return
    // nothing. Detect first-time creation and backfill before returning.
    const existedBefore = Boolean(
      this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_fts'")
        .get(),
    );

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
          title,
          summary,
          keywords_json,
          url,
          content='search_index',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER IF NOT EXISTS search_index_ai AFTER INSERT ON search_index BEGIN
          INSERT INTO search_fts(rowid, title, summary, keywords_json, url)
          VALUES (new.rowid, new.title, new.summary, new.keywords_json, new.url);
        END;

        CREATE TRIGGER IF NOT EXISTS search_index_ad AFTER DELETE ON search_index BEGIN
          INSERT INTO search_fts(search_fts, rowid, title, summary, keywords_json, url)
          VALUES ('delete', old.rowid, old.title, old.summary, old.keywords_json, old.url);
        END;

        CREATE TRIGGER IF NOT EXISTS search_index_au AFTER UPDATE ON search_index BEGIN
          INSERT INTO search_fts(search_fts, rowid, title, summary, keywords_json, url)
          VALUES ('delete', old.rowid, old.title, old.summary, old.keywords_json, old.url);
          INSERT INTO search_fts(rowid, title, summary, keywords_json, url)
          VALUES (new.rowid, new.title, new.summary, new.keywords_json, new.url);
        END;
      `);
      this.ftsAvailable = true;

      if (!existedBefore) {
        const existingRows = Number(
          this.db.prepare("SELECT COUNT(*) AS count FROM search_index").get()?.count || 0,
        );
        if (existingRows > 0) {
          this.db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild')");
          this.ftsBackfilled = existingRows;
        }
      }
    } catch (error) {
      // FTS5 is compiled into most SQLite builds but not all. Search still
      // works via the LIKE fallback in the PHP layer when it is missing.
      this.ftsAvailable = false;
      this.ftsError = error?.message || String(error);
    }
  }

  /** Populate the FTS index from search_index. Only needed after a migration. */
  rebuildFtsIndex() {
    if (!this.ftsAvailable) {
      return false;
    }
    this.db.exec("INSERT INTO search_fts(search_fts) VALUES('rebuild')");
    return true;
  }

  // ----------------------------------------------------------- statements

  prepareStatements() {
    this.selectMetaStmt = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    this.upsertMetaStmt = this.db.prepare(
      "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    );

    this.upsertRawPageStmt = this.db.prepare(`
      INSERT INTO raw_pages(url, title, content, content_encoding, extractor_version, timestamp)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        title=excluded.title,
        content=excluded.content,
        content_encoding=excluded.content_encoding,
        extractor_version=excluded.extractor_version,
        timestamp=excluded.timestamp
      WHERE excluded.timestamp >= raw_pages.timestamp
    `);

    this.selectRawPageStmt = this.db.prepare(
      "SELECT url, title, content, content_encoding, extractor_version, timestamp FROM raw_pages WHERE url = ?",
    );

    // Re-extraction updates text in place without touching the fetch
    // timestamp -- the page was not re-fetched, only re-read.
    this.reextractStmt = this.db.prepare(`
      UPDATE raw_pages
      SET title = ?, content = ?, content_encoding = ?, extractor_version = ?
      WHERE url = ?
    `);

    // --- raw html -------------------------------------------------------

    this.upsertHtmlStmt = this.db.prepare(`
      INSERT INTO raw_html(url, html, html_encoding, byte_length, timestamp)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        html=excluded.html,
        html_encoding=excluded.html_encoding,
        byte_length=excluded.byte_length,
        timestamp=excluded.timestamp
      WHERE excluded.timestamp >= raw_html.timestamp
    `);

    this.selectHtmlStmt = this.db.prepare(
      "SELECT url, html, html_encoding, byte_length, timestamp FROM raw_html WHERE url = ?",
    );

    this.hasHtmlStmt = this.db.prepare("SELECT 1 AS present FROM raw_html WHERE url = ?");

    this.countHtmlStmt = this.db.prepare("SELECT COUNT(*) AS count FROM raw_html");
    this.sumHtmlBytesStmt = this.db.prepare(
      "SELECT COALESCE(SUM(byte_length), 0) AS bytes, COALESCE(SUM(LENGTH(html)), 0) AS stored FROM raw_html",
    );

    // --- freshness / re-archive ------------------------------------------

    // One lookup answering "does this page need fetching again?": is it
    // indexed, how was its text extracted, and do we have its HTML.
    this.selectPageStateStmt = this.db.prepare(`
      SELECT
        s.timestamp AS indexed_at,
        p.extractor_version AS extractor_version,
        (SELECT 1 FROM raw_html h WHERE h.url = ?) AS has_html
      FROM (SELECT ? AS u) AS q
      LEFT JOIN search_index s ON s.url = q.u
      LEFT JOIN raw_pages p ON p.url = q.u
    `);

    this.countByExtractorStmt = this.db.prepare(
      "SELECT extractor_version AS v, COUNT(*) AS count FROM raw_pages GROUP BY extractor_version ORDER BY extractor_version",
    );

    this.selectStaleForReextractStmt = this.db.prepare(`
      SELECT p.url AS url, h.html AS html, h.html_encoding AS html_encoding
      FROM raw_pages p
      JOIN raw_html h ON h.url = p.url
      WHERE p.extractor_version < ?
      LIMIT ?
    `);

    // "Stale" = text from an older extractor, OR current text with no HTML
    // kept. Written as two disjoint ranges of idx_raw_version_url rather than
    // one OR: with the OR, SQLite cannot use an index for either side and
    // scans raw_pages row by row, dragging every page's content off disk.
    // Both halves below are answered from the index alone. Parameters: the
    // current extractor version, twice.
    const STALE_URLS = `
      SELECT url FROM raw_pages INDEXED BY idx_raw_version_url
      WHERE extractor_version < ?
      UNION ALL
      SELECT p.url FROM raw_pages p INDEXED BY idx_raw_version_url
      WHERE p.extractor_version >= ?
        AND NOT EXISTS (SELECT 1 FROM raw_html h WHERE h.url = p.url)
    `;

    // Make every stale page due for a fetch right now. Pages already current
    // keep their schedule.
    this.markRearchiveStmt = this.db.prepare(`
      UPDATE crawl_queue
      SET next_eligible_at = 0, updated_at = ?
      WHERE state = 'pending'
        AND next_eligible_at > 0
        AND url IN (${STALE_URLS})
    `);

    this.countStaleVersionStmt = this.db.prepare(
      "SELECT COUNT(*) AS count FROM raw_pages INDEXED BY idx_raw_version_url WHERE extractor_version < ?",
    );
    this.countMissingHtmlStmt = this.db.prepare(`
      SELECT COUNT(*) AS count FROM raw_pages p INDEXED BY idx_raw_version_url
      WHERE p.extractor_version >= ?
        AND NOT EXISTS (SELECT 1 FROM raw_html h WHERE h.url = p.url)
    `);

    // Stale pages split by whether the crawler can still reach them. Pages
    // parked as blocked/failed will never come back on their own, so progress
    // legitimately plateaus above zero -- without this breakdown that looks
    // like the re-archive has stalled when it has actually finished.
    this.countRearchiveByStateStmt = this.db.prepare(`
      SELECT COALESCE(q.state, 'not-queued') AS state, COUNT(*) AS count
      FROM (${STALE_URLS}) s
      LEFT JOIN crawl_queue q ON q.url = s.url
      GROUP BY COALESCE(q.state, 'not-queued')
    `);

    this.upsertSearchIndexStmt = this.db.prepare(`
      INSERT INTO search_index(url, title, summary, keywords_json, timestamp)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        title=excluded.title,
        summary=excluded.summary,
        keywords_json=excluded.keywords_json,
        timestamp=excluded.timestamp
      WHERE excluded.timestamp >= search_index.timestamp
    `);

    this.selectIndexedAtStmt = this.db.prepare(
      "SELECT timestamp FROM search_index WHERE url = ?",
    );

    // --- frontier -------------------------------------------------------

    this.insertQueueStmt = this.db.prepare(`
      INSERT INTO crawl_queue(url, host, depth, state, attempts, discovered_at, updated_at, next_eligible_at)
      VALUES(?, ?, ?, 'pending', 0, ?, ?, ?)
      ON CONFLICT(url) DO NOTHING
    `);

    this.insertHostStmt = this.db.prepare(
      "INSERT OR IGNORE INTO crawl_hosts(host, order_index, next_available_at) VALUES(?, 0, 0)",
    );

    // Host fairness, in two indexed steps rather than one combined query: a
    // JOIN with a mixed ORDER BY across a small table (hosts) and a huge one
    // (queue) is exactly the shape that made the planner sort the whole
    // frontier before (see the note above idx_queue_host_ready).
    //
    // Step 1: the host that has been claimable longest -- off cooldown with a
    // URL due, per next_due_at (see migrateHostDueTimes). A single seek on
    // idx_hosts_ready, however many hosts have nothing due.
    this.selectFairHostStmt = this.db.prepare(`
      SELECT host
      FROM crawl_hosts INDEXED BY idx_hosts_ready
      WHERE MAX(next_available_at, next_due_at) <= ?
      ORDER BY MAX(next_available_at, next_due_at)
      LIMIT 1
    `);

    this.recomputeHostDueStmt = this.db.prepare(`
      UPDATE crawl_hosts SET next_due_at = COALESCE(
        (SELECT MIN(q.next_eligible_at) FROM crawl_queue q
         WHERE q.host = crawl_hosts.host AND q.state = 'pending'),
        ${NEVER_DUE})
      WHERE host = ?
    `);

    // Step 2: the oldest-due URL on that specific host.
    this.selectHostNextUrlStmt = this.db.prepare(`
      SELECT url, depth, attempts
      FROM crawl_queue INDEXED BY idx_queue_host_ready
      WHERE host = ? AND state = 'pending' AND next_eligible_at <= ?
      ORDER BY next_eligible_at
      LIMIT 1
    `);

    this.markActiveStmt = this.db.prepare(
      "UPDATE crawl_queue SET state = 'active', attempts = attempts + 1, updated_at = ? WHERE url = ?",
    );

    this.setHostAvailableAtStmt = this.db.prepare(
      "UPDATE crawl_hosts SET next_available_at = ? WHERE host = ?",
    );

    this.rescheduleStmt = this.db.prepare(
      "UPDATE crawl_queue SET state = 'pending', next_eligible_at = ?, updated_at = ? WHERE url = ?",
    );

    this.completeStmt = this.db.prepare(
      "UPDATE crawl_queue SET state = 'pending', attempts = 0, next_eligible_at = ?, updated_at = ? WHERE url = ?",
    );

    this.setQueueStateStmt = this.db.prepare(
      "UPDATE crawl_queue SET state = ?, updated_at = ? WHERE url = ?",
    );

    this.releaseActiveStmt = this.db.prepare(
      "UPDATE crawl_queue SET state = 'pending', updated_at = ? WHERE state = 'active'",
    );

    this.setLastNoteStmt = this.db.prepare(
      "UPDATE crawl_queue SET last_note = ? WHERE url = ?",
    );

    // Hand a claim back without it counting as an attempt: claimNext bumped
    // attempts on the assumption a fetch would follow, and when none did the
    // bump has to be undone or the URL creeps toward MAX_ATTEMPTS for nothing.
    this.unclaimStmt = this.db.prepare(`
      UPDATE crawl_queue
      SET state = 'pending', attempts = MAX(attempts - 1, 0), next_eligible_at = ?, updated_at = ?
      WHERE url = ?
    `);

    this.selectFlaggedUrlsStmt = this.db.prepare(`
      SELECT url, host, state, attempts, updated_at, last_note
      FROM crawl_queue
      WHERE last_note LIKE ?
      ORDER BY updated_at DESC
      LIMIT ?
    `);


    // --- budget ---------------------------------------------------------

    this.incrementBudgetStmt = this.db.prepare(`
      INSERT INTO domain_budget(host, day_key, count) VALUES(?, ?, 1)
      ON CONFLICT(host, day_key) DO UPDATE SET count = count + 1
    `);

    this.selectBudgetStmt = this.db.prepare(
      "SELECT count FROM domain_budget WHERE host = ? AND day_key = ?",
    );

    this.pruneBudgetStmt = this.db.prepare(
      "DELETE FROM domain_budget WHERE day_key < ?",
    );

    // --- blacklist ------------------------------------------------------

    this.insertBlacklistStmt = this.db.prepare(
      "INSERT OR IGNORE INTO blacklist_rules(kind, value) VALUES(?, ?)",
    );
    this.clearBlacklistStmt = this.db.prepare("DELETE FROM blacklist_rules");
    this.selectBlacklistStmt = this.db.prepare(
      "SELECT kind, value FROM blacklist_rules ORDER BY kind, value",
    );

    // --- counts ---------------------------------------------------------

    this.countSearchIndexStmt = this.db.prepare(
      "SELECT COUNT(*) AS count FROM search_index",
    );
    this.countRawPagesStmt = this.db.prepare(
      "SELECT COUNT(*) AS count FROM raw_pages",
    );
    this.countQueuePendingStmt = this.db.prepare(
      "SELECT COUNT(*) AS count FROM crawl_queue WHERE state = 'pending'",
    );
    this.countQueueByStateStmt = this.db.prepare(
      "SELECT state, COUNT(*) AS count FROM crawl_queue GROUP BY state",
    );
  }

  // -------------------------------------------------------------- meta

  getMeta(key) {
    return this.selectMetaStmt.get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.upsertMetaStmt.run(key, String(value));
  }

  setMetaBatch(entries) {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(entries)) {
        this.upsertMetaStmt.run(key, String(value));
      }
    });
  }

  // ------------------------------------------------------------ content

  encodeContent(text) {
    if (!this.compressContent) {
      return { value: text, encoding: "utf8" };
    }
    return {
      value: zlib.gzipSync(Buffer.from(text, "utf8"), { level: 6 }),
      encoding: "gzip",
    };
  }

  static decodeContent(value, encoding) {
    if (encoding !== "gzip") {
      return typeof value === "string" ? value : String(value ?? "");
    }
    const buffer = toBuffer(value);
    if (!buffer) {
      return "";
    }
    return zlib.gunzipSync(buffer).toString("utf8");
  }

  saveRawPage(record) {
    const encoded = this.encodeContent(record.content ?? "");
    this.upsertRawPageStmt.run(
      record.url,
      record.title,
      encoded.value,
      encoded.encoding,
      Number(record.extractorVersion) || 1,
      record.timestamp,
    );
  }

  /** Read a page back out of the archive, transparently decompressing. */
  getRawPage(url) {
    const row = this.selectRawPageStmt.get(url);
    if (!row) {
      return null;
    }
    return {
      url: row.url,
      title: row.title,
      content: QuestSqliteStore.decodeContent(row.content, row.content_encoding),
      extractorVersion: Number(row.extractor_version) || 1,
      timestamp: Number(row.timestamp) || 0,
    };
  }

  // ---------------------------------------------------------- raw html

  /**
   * Store the HTML exactly as fetched. Oversized pages are skipped rather than
   * silently truncated -- half a document would be worse than none, because it
   * would look re-extractable when it isn't.
   */
  saveRawHtml(url, html, timestamp) {
    if (!this.storeHtml) {
      return false;
    }
    const buffer = Buffer.from(html, "utf8");
    if (buffer.length > this.maxStoredHtmlBytes) {
      return false;
    }
    this.upsertHtmlStmt.run(
      url,
      zlib.gzipSync(buffer, { level: 6 }),
      "gzip",
      buffer.length,
      timestamp,
    );
    return true;
  }

  getRawHtml(url) {
    const row = this.selectHtmlStmt.get(url);
    if (!row) {
      return null;
    }
    return {
      url: row.url,
      html: QuestSqliteStore.decodeHtml(row.html, row.html_encoding),
      byteLength: Number(row.byte_length) || 0,
      timestamp: Number(row.timestamp) || 0,
    };
  }

  /**
   * Stored HTML in storage order, `limit` rows after `afterRowid`. A cursor
   * rather than OFFSET, so a long pass can stop and resume from the last
   * rowid it finished without rescanning what it already did.
   */
  getRawHtmlAfter(afterRowid, limit) {
    this.rawHtmlAfterStmt ??= this.db.prepare(
      "SELECT rowid AS rowid, url, html, html_encoding FROM raw_html WHERE rowid > ? ORDER BY rowid LIMIT ?",
    );
    return this.rawHtmlAfterStmt.all(afterRowid, limit).map((row) => ({
      rowid: Number(row.rowid),
      url: row.url,
      html: QuestSqliteStore.decodeHtml(row.html, row.html_encoding),
    }));
  }

  maxRawHtmlRowid() {
    return Number(this.db.prepare("SELECT MAX(rowid) AS m FROM raw_html").get()?.m || 0);
  }

  static decodeHtml(value, encoding) {
    if (encoding !== "gzip") {
      return typeof value === "string" ? value : String(value ?? "");
    }
    const buffer = toBuffer(value);
    return buffer ? zlib.gunzipSync(buffer).toString("utf8") : "";
  }

  hasRawHtml(url) {
    return Boolean(this.hasHtmlStmt.get(url));
  }

  getHtmlStats() {
    const row = this.sumHtmlBytesStmt.get() || {};
    return {
      pages: Number(this.countHtmlStmt.get()?.count || 0),
      originalBytes: Number(row.bytes || 0),
      storedBytes: Number(row.stored || 0),
    };
  }

  // ------------------------------------------------- freshness / rearchive

  /**
   * Everything needed to decide whether a URL should be fetched again:
   * when it was last indexed, which extractor produced its text, and whether
   * its HTML was kept.
   */
  getPageState(url) {
    const row = this.selectPageStateStmt.get(url, url) || {};
    return {
      indexedAt: Number(row.indexed_at) || 0,
      extractorVersion: Number(row.extractor_version) || 0,
      hasHtml: Boolean(row.has_html),
    };
  }

  /** Re-run extraction results into an existing row, without a re-fetch. */
  saveReextractedPage(url, title, text, extractorVersion) {
    const encoded = this.encodeContent(text ?? "");
    this.reextractStmt.run(
      title,
      encoded.value,
      encoded.encoding,
      extractorVersion,
      url,
    );
  }

  /** A batch of pages whose stored HTML can be re-extracted locally. */
  getStaleForReextract(currentVersion, limit) {
    return this.selectStaleForReextractStmt.all(currentVersion, limit).map((row) => ({
      url: row.url,
      html: QuestSqliteStore.decodeHtml(row.html, row.html_encoding),
    }));
  }

  getExtractorVersionCounts() {
    const counts = {};
    for (const row of this.countByExtractorStmt.all()) {
      counts[row.v] = Number(row.count) || 0;
    }
    return counts;
  }

  countNeedingRearchive(currentVersion) {
    return (
      Number(this.countStaleVersionStmt.get(currentVersion)?.count || 0) +
      Number(this.countMissingHtmlStmt.get(currentVersion)?.count || 0)
    );
  }

  /** Stale pages grouped by crawl_queue state: pending, blocked, failed, ... */
  getRearchiveByState(currentVersion) {
    const counts = {};
    for (const row of this.countRearchiveByStateStmt.all(currentVersion, currentVersion)) {
      counts[row.state] = Number(row.count) || 0;
    }
    return counts;
  }

  /**
   * Queue every page whose text is stale or whose HTML was never kept for an
   * immediate re-fetch. The queue itself and the search index are untouched --
   * only the fetch schedule moves.
   */
  markForRearchive(currentVersion) {
    const result = this.markRearchiveStmt.run(Date.now(), currentVersion, currentVersion);
    return Number(result?.changes || 0);
  }

  saveSearchIndex(record) {
    this.upsertSearchIndexStmt.run(
      record.url,
      record.title,
      record.summary,
      JSON.stringify(Array.isArray(record.keywords) ? record.keywords : []),
      record.timestamp,
    );
  }

  getIndexedAt(url) {
    const row = this.selectIndexedAtStmt.get(url);
    return row ? Number(row.timestamp) || 0 : 0;
  }

  // ----------------------------------------------------------- frontier

  /**
   * Add newly discovered URLs. Existing rows keep their schedule, so a URL that
   * is already booked for a re-crawl is never bumped back to the front.
   */
  addDiscovered(entries) {
    if (entries.length === 0) {
      return 0;
    }

    return this.db.transaction(() => {
      const now = Date.now();
      let added = 0;
      for (const entry of entries) {
        this.insertHostStmt.run(entry.host);
        const result = this.insertQueueStmt.run(
          entry.url,
          entry.host,
          entry.depth ?? 0,
          now,
          now,
          now,
        );
        added += Number(result?.changes || 0);
      }
      return added;
    });
  }

  /**
   * Atomically take the oldest-due URL from whichever eligible host has been
   * waiting longest since it was last served. Host fairness is the primary
   * ordering, not URL urgency, so no small set of hosts can dominate every
   * claim just because their backlog happens to look more overdue than
   * everyone else's. Returns null when nothing is ready right now.
   */
  claimNext(nowMs, hostDelayMs) {
    return this.db.transaction(() => {
      let hostRow = null;
      let urlRow = null;
      // The triggers keep next_due_at exact, so the first host should always
      // have a due URL. If one ever doesn't, correct it and look again rather
      // than stalling on it.
      for (let tries = 0; tries < 5 && !urlRow; tries += 1) {
        hostRow = this.selectFairHostStmt.get(nowMs);
        if (!hostRow) {
          return null;
        }
        urlRow = this.selectHostNextUrlStmt.get(hostRow.host, nowMs);
        if (!urlRow) {
          this.recomputeHostDueStmt.run(hostRow.host);
        }
      }
      if (!urlRow) {
        return null;
      }

      this.markActiveStmt.run(nowMs, urlRow.url);
      this.setHostAvailableAtStmt.run(nowMs + hostDelayMs, hostRow.host);
      return {
        url: urlRow.url,
        host: hostRow.host,
        depth: Number(urlRow.depth) || 0,
        // Post-increment: this is the attempt number about to be made, so the
        // first try reports 1.
        attempts: (Number(urlRow.attempts) || 0) + 1,
      };
    });
  }

  /** Crawled successfully; book the next visit. */
  completeUrl(url, nextEligibleAt) {
    this.completeStmt.run(scheduleTime(nextEligibleAt), Date.now(), url);
  }

  /** Put a URL back for a later attempt without counting it as finished. */
  rescheduleUrl(url, nextEligibleAt) {
    this.rescheduleStmt.run(scheduleTime(nextEligibleAt), Date.now(), url);
  }

  /** Take a URL out of rotation permanently (robots, blacklist, dead link). */
  setUrlState(url, state) {
    this.setQueueStateStmt.run(state, Date.now(), url);
  }

  /**
   * Return a claimed URL to the queue as if it had never been claimed: back to
   * pending, attempt counter restored, due again at nextEligibleAt. For every
   * path where a claim ends without anything going over the network.
   */
  unclaimUrl(url, nextEligibleAt) {
    this.unclaimStmt.run(scheduleTime(nextEligibleAt), Date.now(), url);
  }

  /** Recover URLs left 'active' by a crash or a hard kill. */
  releaseActiveClaims() {
    const result = this.releaseActiveStmt.run(Date.now());
    return Number(result?.changes || 0);
  }

  /**
   * Record why a URL last failed, or note something worth flagging about it
   * (e.g. it tried to hand back an unreasonable number of links) even when it
   * otherwise succeeded. This is separate from state -- a row can be pending,
   * failed, or blocked and still carry a note explaining the last thing that
   * happened to it.
   */
  setLastNote(url, note) {
    this.setLastNoteStmt.run(String(note || "").slice(0, 500), url);
  }

  /** URLs whose last_note matches a LIKE pattern, e.g. '%hard timeout%'. */
  getFlaggedUrls(likePattern, limit = 10000) {
    return this.selectFlaggedUrlsStmt.all(likePattern, limit);
  }

  /**
   * Park a whole host until a given time (used when its daily budget runs out).
   *
   * Only crawl_hosts is touched. The claim query joins against it, so one row
   * update takes every URL on that host out of rotation. Rewriting the queue
   * rows themselves would mean a full table scan per host per day, because
   * there is deliberately no index on crawl_queue(host).
   */
  deferHost(host, untilMs) {
    this.setHostAvailableAtStmt.run(scheduleTime(untilMs), host);
  }

  // ------------------------------------------------------------- budget

  getDomainCount(host, dayKey) {
    const row = this.selectBudgetStmt.get(host, dayKey);
    return row ? Number(row.count) || 0 : 0;
  }

  incrementDomainCount(host, dayKey) {
    this.incrementBudgetStmt.run(host, dayKey);
  }

  pruneBudgetsBefore(dayKey) {
    const result = this.pruneBudgetStmt.run(dayKey);
    return Number(result?.changes || 0);
  }

  // ---------------------------------------------------------- blacklist

  /** Replace the stored rules with the ones from disk so edits take effect. */
  syncBlacklist(config) {
    this.db.transaction(() => {
      this.clearBlacklistStmt.run();
      for (const [kind, items] of Object.entries(config)) {
        for (const value of items) {
          const trimmed = String(value || "").trim();
          if (trimmed) {
            this.insertBlacklistStmt.run(kind, trimmed);
          }
        }
      }
    });
  }

  getBlacklistConfig() {
    const config = {
      exactUrls: [],
      urlPrefixes: [],
      blockedHosts: [],
      pathContains: [],
    };

    for (const row of this.selectBlacklistStmt.all()) {
      if (config[row.kind]) {
        config[row.kind].push(row.value);
      }
    }

    return config;
  }

  // ------------------------------------------------------------- counts

  getSearchIndexCount() {
    return Number(this.countSearchIndexStmt.get()?.count || 0);
  }

  getRawPageCount() {
    return Number(this.countRawPagesStmt.get()?.count || 0);
  }

  getQueuePendingCount() {
    return Number(this.countQueuePendingStmt.get()?.count || 0);
  }

  getQueueStateCounts() {
    const counts = {};
    for (const row of this.countQueueByStateStmt.all()) {
      counts[row.state] = Number(row.count) || 0;
    }
    return counts;
  }

  /**
   * Recompute the counts the search page displays and stash them in meta, so
   * the web layer never has to run COUNT(*) on a request.
   */
  refreshCachedCounts() {
    const stats = {
      stat_search_index: this.getSearchIndexCount(),
      stat_raw_pages: this.getRawPageCount(),
      stat_queue_pending: this.getQueuePendingCount(),
      stat_counts_updated_at: Date.now(),
    };
    this.setMetaBatch(stats);
    return stats;
  }

  // -------------------------------------------------------- maintenance

  /** Fold the WAL back into the main database and truncate it. */
  checkpoint(mode = "TRUNCATE") {
    try {
      const row = this.db.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
      return row || null;
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  }

  close() {
    try {
      // Fold the WAL back if nobody else is using the database; if someone
      // is (the crawler, while maintain.js runs), don't queue behind them for
      // busy_timeout just to close -- they'll checkpoint it themselves.
      this.db.pragmaSet("busy_timeout = 0");
      this.checkpoint("TRUNCATE");
    } catch {
      // Closing matters more than the checkpoint succeeding.
    }
    this.db.close();
  }
}

module.exports = {
  QuestSqliteStore,
  SCHEMA_VERSION,
};
