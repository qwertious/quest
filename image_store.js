"use strict";

/**
 * The image index behind xImages (data/images.sqlite).
 *
 * Kept out of quest.sqlite on purpose: it is large, rebuildable from the
 * stored HTML at any time (maintain.js --index-media), and the crawl
 * database is already at the limit of what the server's disk handles well.
 *
 *   images      one row per distinct image URL
 *   image_refs  one row per (image, page that shows it), carrying the words
 *               that page uses for it: alt text, caption, page title
 *   image_fts   full-text index over image_refs
 *
 * The same picture used on ten pages is one image found by the words of all
 * ten, and each result can link back to every page it appears on.
 */

const { QuestDatabase } = require("./db");
const { siteOf } = require("./site");

class ImageStore {
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
      CREATE TABLE IF NOT EXISTS images (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        site TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_refs (
        id INTEGER PRIMARY KEY,
        image_id INTEGER NOT NULL,
        page_url TEXT NOT NULL,
        page_title TEXT NOT NULL DEFAULT '',
        alt TEXT NOT NULL DEFAULT '',
        caption TEXT NOT NULL DEFAULT '',
        is_lead INTEGER NOT NULL DEFAULT 0,
        seen_at INTEGER NOT NULL,
        UNIQUE (image_id, page_url)
      );
      CREATE INDEX IF NOT EXISTS idx_refs_page ON image_refs(page_url);
      CREATE INDEX IF NOT EXISTS idx_images_site ON images(site);
    `);
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS image_fts USING fts5(
          alt, caption, page_title, content='image_refs', content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS image_refs_ai AFTER INSERT ON image_refs BEGIN
          INSERT INTO image_fts(rowid, alt, caption, page_title) VALUES (new.id, new.alt, new.caption, new.page_title);
        END;
        CREATE TRIGGER IF NOT EXISTS image_refs_ad AFTER DELETE ON image_refs BEGIN
          INSERT INTO image_fts(image_fts, rowid, alt, caption, page_title) VALUES ('delete', old.id, old.alt, old.caption, old.page_title);
        END;
        CREATE TRIGGER IF NOT EXISTS image_refs_au AFTER UPDATE ON image_refs BEGIN
          INSERT INTO image_fts(image_fts, rowid, alt, caption, page_title) VALUES ('delete', old.id, old.alt, old.caption, old.page_title);
          INSERT INTO image_fts(rowid, alt, caption, page_title) VALUES (new.id, new.alt, new.caption, new.page_title);
        END;
      `);
      this.ftsAvailable = true;
    } catch (error) {
      this.ftsAvailable = false;
      this.ftsError = error?.message;
    }
  }

  prepare() {
    this.upsertImageStmt = this.db.prepare(`
      INSERT INTO images(url, site, width, height, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        last_seen = excluded.last_seen,
        width = COALESCE(excluded.width, images.width),
        height = COALESCE(excluded.height, images.height)
      RETURNING id
    `);
    this.deleteRefsForPageStmt = this.db.prepare("DELETE FROM image_refs WHERE page_url = ?");
    this.insertRefStmt = this.db.prepare(`
      INSERT OR REPLACE INTO image_refs(image_id, page_url, page_title, alt, caption, is_lead, seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.searchStmt = this.ftsAvailable
      ? this.db.prepare(`
          SELECT i.url, i.site, r.page_url, r.page_title, r.alt, r.caption
          FROM (SELECT rowid, bm25(image_fts, 4.0, 3.0, 1.0) AS rank FROM image_fts
                WHERE image_fts MATCH ? ORDER BY rank LIMIT ?) f
          JOIN image_refs r ON r.id = f.rowid JOIN images i ON i.id = r.image_id
          ORDER BY f.rank
        `)
      : null;
  }

  /**
   * Replace everything known about one page's images. A re-crawled page that
   * dropped an image no longer vouches for it.
   */
  savePage(pageUrl, pageTitle, images, now = Date.now()) {
    return this.db.transaction(() => {
      this.deleteRefsForPageStmt.run(pageUrl);
      const title = String(pageTitle || "").slice(0, 300);
      for (const image of images) {
        let site = "";
        try {
          site = siteOf(new URL(image.url).hostname);
        } catch {
          continue;
        }
        const row = this.upsertImageStmt.get(image.url, site, image.width || null, image.height || null, now, now);
        this.insertRefStmt.run(row.id, pageUrl, title, image.alt || "", image.caption || "", image.lead ? 1 : 0, now);
      }
      return images.length;
    });
  }

  /** Plain-word search, for tests and the CLI; the site does its own in PHP. */
  search(words, limit = 20) {
    if (!this.searchStmt) return [];
    const terms = String(words).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    if (terms.length === 0) return [];
    return this.searchStmt.all(terms.map((t) => `"${t}"`).join(" "), limit);
  }

  counts() {
    const one = (sql) => Number(this.db.prepare(sql).get()?.c || 0);
    return {
      images: one("SELECT COUNT(*) c FROM images"),
      refs: one("SELECT COUNT(*) c FROM image_refs"),
      pages: one("SELECT COUNT(DISTINCT page_url) c FROM image_refs"),
    };
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
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

module.exports = { ImageStore };
