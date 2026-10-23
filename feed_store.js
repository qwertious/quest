"use strict";

/**
 * Feeds and their posts, behind xWire (data/feeds.sqlite).
 *
 *   feeds  every feed the crawler has seen linked, and how fetching it goes
 *   posts  items from those feeds, newest kept, capped per feed
 *
 * The crawler only ever inserts discoveries here; feeds.js owns everything
 * else. Separate from quest.sqlite so the feed reader never waits on the
 * crawler's writes or vice versa.
 *
 * Feed states:
 *   new      discovered, never fetched
 *   active   fetched and parsed at least once
 *   invalid  answered, but with something that isn't a feed (an HTML page
 *            behind a feed-shaped link) -- not asked again
 *   blocked  robots.txt disallows it
 *   dead     failed too many times in a row
 */

const { QuestDatabase } = require("./db");
const { siteOf } = require("./site");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const MIN_INTERVAL_MS = 30 * MINUTE;
const MAX_INTERVAL_MS = 24 * HOUR;
const DEFAULT_INTERVAL_MS = 6 * HOUR;
const MAX_POSTS_PER_FEED = 300;
const DEAD_AFTER_FAILURES = 10;
// A post dated in the future would sit on top of the timeline for days.
const FUTURE_TOLERANCE_MS = HOUR;

class FeedStore {
  constructor({ dbPath }) {
    this.db = new QuestDatabase(dbPath);
    this.db.pragmaSet("journal_mode = WAL");
    this.db.pragmaSet("synchronous = NORMAL");
    this.db.pragmaSet("busy_timeout = 10000");
    this.db.pragmaSet("cache_size = -8000");
    this.migrate();
    this.prepare();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS feeds (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        site TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'guess',
        title TEXT NOT NULL DEFAULT '',
        home_url TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        icon_url TEXT NOT NULL DEFAULT '',
        discovered_from TEXT NOT NULL DEFAULT '',
        discovered_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'new',
        etag TEXT NOT NULL DEFAULT '',
        last_modified TEXT NOT NULL DEFAULT '',
        last_fetched_at INTEGER NOT NULL DEFAULT 0,
        next_fetch_at INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        post_count INTEGER NOT NULL DEFAULT 0,
        last_post_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_feeds_due ON feeds(next_fetch_at) WHERE state IN ('new', 'active');
      CREATE INDEX IF NOT EXISTS idx_feeds_site ON feeds(site);

      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY,
        feed_id INTEGER NOT NULL,
        guid TEXT NOT NULL,
        url TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        image_url TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        published_at INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        UNIQUE (feed_id, guid)
      );
      CREATE INDEX IF NOT EXISTS idx_posts_time ON posts(published_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_feed ON posts(feed_id, published_at DESC);
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
          title, summary, author, content='posts', content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
          INSERT INTO posts_fts(rowid, title, summary, author) VALUES (new.id, new.title, new.summary, new.author);
        END;
        CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
          INSERT INTO posts_fts(posts_fts, rowid, title, summary, author) VALUES ('delete', old.id, old.title, old.summary, old.author);
        END;
        CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE OF title, summary, author ON posts BEGIN
          INSERT INTO posts_fts(posts_fts, rowid, title, summary, author) VALUES ('delete', old.id, old.title, old.summary, old.author);
          INSERT INTO posts_fts(rowid, title, summary, author) VALUES (new.id, new.title, new.summary, new.author);
        END;
      `);
      this.ftsAvailable = true;
    } catch (error) {
      this.ftsAvailable = false;
      this.ftsError = error?.message;
    }
  }

  prepare() {
    this.insertFeedStmt = this.db.prepare(`
      INSERT INTO feeds(url, site, kind, title, discovered_from, discovered_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        -- A declared <link> outranks a feed-shaped <a> seen earlier.
        kind = CASE WHEN feeds.kind = 'guess' THEN excluded.kind ELSE feeds.kind END
    `);
    this.dueStmt = this.db.prepare(`
      SELECT id, url, site, kind, state, etag, last_modified, failures
      FROM feeds INDEXED BY idx_feeds_due
      WHERE state IN ('new', 'active') AND next_fetch_at <= ?
      ORDER BY next_fetch_at LIMIT ?
    `);
    this.upsertPostStmt = this.db.prepare(`
      INSERT INTO posts(feed_id, guid, url, title, summary, image_url, author, published_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id, guid) DO UPDATE SET
        url = excluded.url, title = excluded.title, summary = excluded.summary,
        image_url = excluded.image_url, author = excluded.author
      WHERE posts.title != excluded.title OR posts.summary != excluded.summary
         OR posts.url != excluded.url OR posts.image_url != excluded.image_url
    `);
    this.existingGuidStmt = this.db.prepare("SELECT 1 FROM posts WHERE feed_id = ? AND guid = ?");
    this.pruneStmt = this.db.prepare(`
      DELETE FROM posts WHERE feed_id = ? AND id NOT IN (
        SELECT id FROM posts WHERE feed_id = ? ORDER BY published_at DESC, id DESC LIMIT ?
      )
    `);
    this.recentDatesStmt = this.db.prepare(
      "SELECT published_at FROM posts WHERE feed_id = ? ORDER BY published_at DESC LIMIT 10",
    );
  }

  /** From the crawler: feeds seen linked from a page. Returns how many were new. */
  addDiscovered(feeds, fromUrl, now = Date.now()) {
    if (!feeds || feeds.length === 0) return 0;
    return this.db.transaction(() => {
      let added = 0;
      for (const feed of feeds) {
        let site;
        try {
          site = siteOf(new URL(feed.url).hostname);
        } catch {
          continue;
        }
        const before = this.db.prepare("SELECT 1 FROM feeds WHERE url = ?").get(feed.url);
        this.insertFeedStmt.run(feed.url, site, feed.kind || "guess", feed.title || "", fromUrl || "", now);
        if (!before) added += 1;
      }
      return added;
    });
  }

  dueFeeds(now = Date.now(), limit = 50) {
    return this.dueStmt.all(now, limit);
  }

  /** Push a feed back without counting anything against it (site busy, etc). */
  defer(feedId, untilMs) {
    this.db.prepare("UPDATE feeds SET next_fetch_at = ? WHERE id = ?").run(Math.floor(untilMs), feedId);
  }

  /**
   * How long until this feed is worth asking again: half the typical gap
   * between its recent posts, within [30 min, 24 h]. A feed that posts
   * hourly is checked every half hour; one that posts monthly, daily.
   */
  intervalFor(feedId) {
    const dates = this.recentDatesStmt.all(feedId).map((r) => Number(r.published_at));
    if (dates.length < 2) return DEFAULT_INTERVAL_MS;
    const gaps = [];
    for (let i = 1; i < dates.length; i += 1) gaps.push(dates[i - 1] - dates[i]);
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, median / 2));
  }

  /** ±10%, so feeds discovered together don't stay in lockstep forever. */
  static jitter(ms) {
    return Math.floor(ms * (0.9 + Math.random() * 0.2));
  }

  /** A parsed feed came back. Returns the number of posts that were new. */
  recordSuccess(feedId, feed, { etag = "", lastModified = "" } = {}, now = Date.now()) {
    return this.db.transaction(() => {
      let fresh = 0;
      for (const item of feed.items) {
        const known = this.existingGuidStmt.get(feedId, item.guid);
        // No date: first time we saw it is the best guess, and it keeps.
        let published = item.publishedAt ?? now;
        if (published > now + FUTURE_TOLERANCE_MS) published = now;
        this.upsertPostStmt.run(
          feedId, String(item.guid).slice(0, 500), item.url || "", item.title || "", item.summary || "",
          item.imageUrl || "", item.author || "", Math.floor(published), now,
        );
        if (!known) fresh += 1;
      }
      this.pruneStmt.run(feedId, feedId, MAX_POSTS_PER_FEED);
      const stats = this.db
        .prepare("SELECT COUNT(*) c, MAX(published_at) last FROM posts WHERE feed_id = ?")
        .get(feedId);
      this.db
        .prepare(`
          UPDATE feeds SET state = 'active', kind = ?, title = ?, home_url = ?, description = ?, icon_url = ?,
            etag = ?, last_modified = ?, last_fetched_at = ?, failures = 0, last_error = '',
            post_count = ?, last_post_at = ?, next_fetch_at = ?
          WHERE id = ?
        `)
        .run(
          feed.kind, feed.title || "", feed.homeUrl || "", feed.description || "", feed.iconUrl || "",
          etag || "", lastModified || "", now, Number(stats.c), Number(stats.last || 0),
          now + FeedStore.jitter(this.intervalFor(feedId)), feedId,
        );
      return fresh;
    });
  }

  /** 304: nothing changed, ask again on the usual schedule. */
  recordNotModified(feedId, now = Date.now()) {
    this.db
      .prepare("UPDATE feeds SET last_fetched_at = ?, failures = 0, last_error = '', next_fetch_at = ? WHERE id = ?")
      .run(now, now + FeedStore.jitter(this.intervalFor(feedId)), feedId);
  }

  /**
   * A failed fetch. `state` ends it for good ('invalid', 'blocked');
   * otherwise back off 1h, 2h, 4h ... up to a day, and give up after
   * DEAD_AFTER_FAILURES in a row. `retryAt` sets a floor (robots.txt
   * unreachable until then, Retry-After, ...).
   */
  recordFailure(feedId, reason, { state = null, retryAt = 0 } = {}, now = Date.now()) {
    const row = this.db.prepare("SELECT failures FROM feeds WHERE id = ?").get(feedId);
    const failures = Number(row?.failures || 0) + 1;
    const nextState = state || (failures >= DEAD_AFTER_FAILURES ? "dead" : null);
    const backoff = Math.min(MAX_INTERVAL_MS, HOUR * 2 ** (failures - 1));
    this.db
      .prepare(`
        UPDATE feeds SET failures = ?, last_error = ?, last_fetched_at = ?, next_fetch_at = ?,
          state = COALESCE(?, state)
        WHERE id = ?
      `)
      .run(failures, String(reason || "").slice(0, 300), now, Math.max(now + FeedStore.jitter(backoff), retryAt), nextState, feedId);
    return nextState;
  }

  stateCounts() {
    const counts = {};
    for (const row of this.db.prepare("SELECT state, COUNT(*) c FROM feeds GROUP BY state").all()) {
      counts[row.state] = Number(row.c);
    }
    return counts;
  }

  postCount() {
    return Number(this.db.prepare("SELECT COUNT(*) c FROM posts").get().c);
  }

  setMetaBatch(values) {
    const stmt = this.db.prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(values)) stmt.run(key, String(value));
    });
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  close() {
    try {
      // Skip it rather than wait if another process is using the file.
      this.db.pragmaSet("busy_timeout = 0");
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Closing matters more.
    }
    this.db.close();
  }
}

module.exports = { FeedStore, DEAD_AFTER_FAILURES };
