"use strict";

/** Storage layer: HTML archive, extractor versioning, re-archive, claims. */

const { test, describe } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { tmpDb, openStore, QUEST_DIR } = require("./helpers");
const { EXTRACTOR_VERSION, extractText, parsePage } = require(path.join(QUEST_DIR, "extract"));
const { QuestDatabase } = require(path.join(QUEST_DIR, "db"));

const HTML = `<html><head><title>Turnips</title></head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<p>Turnips are a root vegetable.</p>
<ul><li>sow in spring,</li><li>harvest in autumn</li></ul>
<table><tr><td>Alpha</td><td>Beta</td></tr></table>
<pre><code>def sow(seed):
    return seed * 2</code></pre></body></html>`;

describe("extractor", () => {
  test("keeps word boundaries at element edges", () => {
    const text = extractText(HTML);
    assert.ok(!text.includes("HomeAbout"), "nav links fused");
    assert.ok(!text.includes("spring,harvest"), "list items fused");
    assert.ok(!text.includes("AlphaBeta"), "table cells fused");
  });

  test("preserves structure and <pre> indentation", () => {
    const text = extractText(HTML);
    assert.ok(text.includes("\n\n"), "no paragraph breaks");
    assert.ok(text.includes("    return seed * 2"), "pre indentation lost");
    assert.ok(!/[\u0001\u0002]/.test(text), "sentinel characters leaked");
  });

  test("parsePage returns title, text and capped links", () => {
    const many = "<body>" + Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">x</a>`).join("") + "</body>";
    const r = parsePage(many, "https://e.example/", 10);
    assert.strictEqual(r.links.length, 10);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(parsePage(HTML, "https://e.example/").title, "Turnips");
  });

  test("survives malformed input", () => {
    for (const bad of ["", "<html>", "<p>unclosed", "plain text", "<body><div><span></body>"]) {
      extractText(bad);
    }
  });
});

describe("html archive", () => {
  test("round-trips byte-identically and is compressed", () => {
    const store = openStore(tmpDb("html"));
    assert.strictEqual(store.saveRawHtml("https://a.example/1", HTML, 1000), true);
    assert.strictEqual(store.getRawHtml("https://a.example/1").html, HTML);
    const row = store.db.prepare("SELECT html, html_encoding FROM raw_html").get();
    assert.strictEqual(row.html_encoding, "gzip");
    store.close();
  });

  test("oversized pages are skipped, never truncated", () => {
    const store = openStore(tmpDb("html"), { maxStoredHtmlBytes: 100 });
    assert.strictEqual(store.saveRawHtml("https://a.example/big", HTML, 1), false);
    assert.strictEqual(store.getRawHtml("https://a.example/big"), null);
    store.close();
  });

  test("a stale fetch never overwrites a newer one", () => {
    const store = openStore(tmpDb("html"));
    store.saveRawHtml("https://a.example/1", "<p>NEW</p>", 5000);
    store.saveRawHtml("https://a.example/1", "<p>OLD</p>", 10);
    assert.ok(store.getRawHtml("https://a.example/1").html.includes("NEW"));
    store.close();
  });
});

describe("re-archive", () => {
  test("marks exactly the stale pages due, leaving current ones scheduled", () => {
    const store = openStore(tmpDb("rearchive"));
    const future = Date.now() + 30 * 86400000;
    const urls = ["https://q.example/stale", "https://q.example/current", "https://q.example/nohtml"];
    store.addDiscovered(urls.map((url) => ({ url, host: "q.example", depth: 0 })));
    for (const url of urls) store.completeUrl(url, future);

    store.saveRawPage({ url: urls[0], title: "T", content: "x", extractorVersion: 1, timestamp: 1 });
    store.saveRawHtml(urls[0], HTML, 1);
    store.saveRawPage({ url: urls[1], title: "T", content: "x", extractorVersion: EXTRACTOR_VERSION, timestamp: 1 });
    store.saveRawHtml(urls[1], HTML, 1);
    store.saveRawPage({ url: urls[2], title: "T", content: "x", extractorVersion: EXTRACTOR_VERSION, timestamp: 1 });

    assert.strictEqual(store.countNeedingRearchive(EXTRACTOR_VERSION), 2);
    assert.strictEqual(store.markForRearchive(EXTRACTOR_VERSION), 2);
    const due = store.db
      .prepare("SELECT url FROM crawl_queue WHERE next_eligible_at = 0 ORDER BY url")
      .all()
      .map((r) => r.url);
    assert.deepStrictEqual(due, [urls[2], urls[0]]);
    assert.strictEqual(store.markForRearchive(EXTRACTOR_VERSION), 0, "not idempotent");
    assert.strictEqual(store.getQueuePendingCount(), 3, "queue rows added or removed");
    store.close();
  });

  test("the backlog count reads the small index, never the page bodies", () => {
    // Regression: an OR in this count forced a scan of every stored page
    // (~GBs in production), freezing the crawler's event loop each minute.
    const store = openStore(tmpDb("rearchive-plan"));
    const plan = (sql) =>
      store.db
        .prepare("EXPLAIN QUERY PLAN " + sql)
        .all(EXTRACTOR_VERSION)
        .map((r) => r.detail)
        .join(" | ");
    for (const sql of [
      "SELECT COUNT(*) FROM raw_pages INDEXED BY idx_raw_version_url WHERE extractor_version < ?",
      "SELECT COUNT(*) FROM raw_pages p INDEXED BY idx_raw_version_url WHERE p.extractor_version >= ? AND NOT EXISTS (SELECT 1 FROM raw_html h WHERE h.url = p.url)",
    ]) {
      const detail = plan(sql);
      assert.match(detail, /COVERING INDEX idx_raw_version_url/, detail);
    }
    store.close();
  });

  test("re-extraction from stored HTML fixes text without a refetch", () => {
    const store = openStore(tmpDb("reextract"));
    const url = "https://r.example/1";
    store.saveRawPage({ url, title: "T", content: "HomeAboutTurnips", extractorVersion: 1, timestamp: 1000 });
    store.saveRawHtml(url, HTML, 1000);

    for (const row of store.getStaleForReextract(EXTRACTOR_VERSION, 10)) {
      store.saveReextractedPage(row.url, "T", extractText(row.html), EXTRACTOR_VERSION);
    }
    const page = store.getRawPage(url);
    assert.strictEqual(page.extractorVersion, EXTRACTOR_VERSION);
    assert.ok(!page.content.includes("HomeAbout"));
    assert.strictEqual(page.timestamp, 1000, "fetch timestamp should not move");
    store.close();
  });
});

describe("background housekeeping", () => {
  test("runs on its own thread and agrees with the inline result", async () => {
    const { startBackground } = require(path.join(QUEST_DIR, "background"));
    const dbPath = tmpDb("background");
    const store = openStore(dbPath);
    store.addDiscovered([1, 2, 3].map((i) => ({ url: `https://bg.example/${i}`, host: "bg.example", depth: 0 })));
    store.saveRawPage({ url: "https://bg.example/1", title: "T", content: "x", extractorVersion: 1, timestamp: 1 });

    const logs = [];
    const bg = startBackground({ dbPath, fallbackStore: store, onLog: (m) => logs.push(m) });
    try {
      assert.ok(bg.threaded, logs.join("\n"));
      const counts = await bg.run("counts");
      assert.ok(!counts.inline, "ran inline");
      assert.strictEqual(counts.result.stat_queue_pending, 3);
      assert.strictEqual(counts.result.stat_raw_pages, 1);
      const rearchive = await bg.run("rearchive", EXTRACTOR_VERSION);
      assert.strictEqual(rearchive.result, store.countNeedingRearchive(EXTRACTOR_VERSION));
      assert.strictEqual(Number(store.getMeta("stat_rearchive_remaining")), rearchive.result, "meta not written");
      assert.ok(await bg.run("checkpoint"));
    } finally {
      await bg.close();
      store.close();
    }
    assert.deepStrictEqual(logs, []);
  });
});

describe("scheduler due times", () => {
  const wrongHosts = (store) =>
    store.db
      .prepare(
        `SELECT h.host, h.next_due_at FROM crawl_hosts h WHERE h.next_due_at != COALESCE(
           (SELECT MIN(next_eligible_at) FROM crawl_queue q WHERE q.host = h.host AND q.state = 'pending'),
           9000000000000000)`,
      )
      .all();

  test("stay exact through every kind of queue write", () => {
    const store = openStore(tmpDb("due"));
    // mulberry32: deterministic, and unlike a bare LCG its low bits don't
    // cycle -- that made rand(8) replay the same op order every 8 steps.
    let seed = 42;
    const rand = (n) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) / 4294967296 * n) | 0;
    };
    const now = Date.now();
    const urls = [];
    for (let i = 0; i < 300; i += 1) {
      const host = `h${i % 17}.example`;
      urls.push(`https://${host}/${i}`);
      store.addDiscovered([{ url: urls[i], host, depth: 0 }]);
      // Distinct due times: ties would hide a wrong minimum.
      store.rescheduleUrl(urls[i], now - 5e5 + rand(1e6));
    }
    const claimed = [];
    for (let step = 0; step < 2000; step += 1) {
      const url = urls[rand(urls.length)];
      switch (rand(9)) {
        case 8: { const host = `h${rand(23)}.example`; const u = `https://${host}/n${step}`; urls.push(u); store.addDiscovered([{ url: u, host, depth: 0 }]); break; }
        case 0: { const c = store.claimNext(now + rand(1e6), 0); if (c) claimed.push(c.url); break; }
        case 1: store.completeUrl(url, now + rand(3e9)); break;
        case 2: store.rescheduleUrl(url, now - 5e5 + rand(1e6)); break; // earlier or later
        case 3: store.unclaimUrl(claimed.pop() || url, now + rand(1e5)); break;
        case 4: store.setUrlState(url, rand(2) ? "failed" : "blocked"); break;
        case 5: store.db.prepare("DELETE FROM crawl_queue WHERE url = ?").run(url); break;
        case 6: store.releaseActiveClaims(); break;
        case 7: store.markForRearchive(EXTRACTOR_VERSION); break;
      }
      // Every step, not just at the end: a later write can repair an
      // earlier mistake and hide it.
      const wrong = wrongHosts(store);
      assert.deepStrictEqual(wrong, [], `after step ${step}`);
    }
    store.close();
  });

  test("hosts with nothing due cost nothing to skip", () => {
    const store = openStore(tmpDb("due-skip"));
    const future = Date.now() + 30 * 86400000;
    const done = [];
    for (let i = 0; i < 2000; i += 1) done.push({ url: `https://done${i}.example/`, host: `done${i}.example`, depth: 0 });
    store.addDiscovered(done);
    for (const d of done) store.completeUrl(d.url, future);
    store.addDiscovered([{ url: "https://live.example/", host: "live.example", depth: 0 }]);
    const plan = store.db
      .prepare("EXPLAIN QUERY PLAN SELECT host FROM crawl_hosts INDEXED BY idx_hosts_ready WHERE MAX(next_available_at, next_due_at) <= ? ORDER BY MAX(next_available_at, next_due_at) LIMIT 1")
      .all(Date.now())
      .map((r) => r.detail)
      .join(" | ");
    assert.match(plan, /SEARCH crawl_hosts USING INDEX idx_hosts_ready/, plan);
    assert.strictEqual(store.claimNext(Date.now(), 0)?.host, "live.example");
    store.close();
  });
});

describe("claims", () => {
  test("unclaimUrl undoes the attempt the claim charged", () => {
    const store = openStore(tmpDb("claims"));
    store.addDiscovered([{ url: "https://c.example/1", host: "c.example", depth: 0 }]);
    const claim = store.claimNext(Date.now(), 0);
    assert.strictEqual(claim.attempts, 1);
    const later = Date.now() + 60000;
    store.unclaimUrl(claim.url, later);
    const row = store.db.prepare("SELECT state, attempts, next_eligible_at FROM crawl_queue").get();
    assert.strictEqual(row.state, "pending");
    assert.strictEqual(row.attempts, 0, "attempt was not given back");
    assert.strictEqual(row.next_eligible_at, later);
    store.close();
  });

  test("host fairness spreads claims instead of draining one big host", () => {
    const store = openStore(tmpDb("fair"));
    const entries = [];
    for (let i = 0; i < 500; i++) entries.push({ url: `https://big.example/${i}`, host: "big.example", depth: 0 });
    for (let h = 0; h < 50; h++) entries.push({ url: `https://s${h}.example/1`, host: `s${h}.example`, depth: 0 });
    store.addDiscovered(entries);
    store.db.exec("UPDATE crawl_queue SET next_eligible_at = 0; UPDATE crawl_hosts SET next_available_at = 0");

    const hosts = [];
    for (let i = 0; i < 51; i++) {
      const c = store.claimNext(Date.now(), 0);
      hosts.push(c.host);
      store.completeUrl(c.url, Date.now() + 86400000);
    }
    assert.strictEqual(new Set(hosts).size, 51, "some host was served twice before others got a turn");
    store.close();
  });
});

describe("opening a busy database", () => {
  test("an up-to-date database opens without needing the write lock", () => {
    const dbPath = tmpDb("busy");
    openStore(dbPath).close();
    // Another process (the crawler, mid-shutdown) holding the write lock.
    const writer = new QuestDatabase(dbPath);
    writer.exec("BEGIN IMMEDIATE");
    const started = Date.now();
    try {
      const store = openStore(dbPath);
      store.close();
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started}ms for the lock`);
  });
});

describe("migration", () => {
  test("a v2 database (no HTML, no versions) migrates cleanly and reports stale", () => {
    const dbPath = tmpDb("migrate");
    const db = new QuestDatabase(dbPath);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE raw_pages (url TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL, content_encoding TEXT NOT NULL DEFAULT 'utf8');
      CREATE TABLE search_index (url TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, keywords_json TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE crawl_queue (url TEXT PRIMARY KEY, host TEXT NOT NULL, discovered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, depth INTEGER NOT NULL DEFAULT 0, next_eligible_at INTEGER NOT NULL DEFAULT 0, last_note TEXT NOT NULL DEFAULT '');
      CREATE TABLE crawl_hosts (host TEXT PRIMARY KEY, order_index INTEGER NOT NULL DEFAULT 0, next_available_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE domain_budget (host TEXT NOT NULL, day_key TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (host, day_key));
      CREATE TABLE blacklist_rules (kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, value));
    `);
    const ins = db.prepare("INSERT INTO raw_pages(url,title,content,timestamp) VALUES(?,?,?,?)");
    for (let i = 0; i < 50; i++) ins.run(`https://legacy.example/${i}`, "T", "fused", 1000);
    db.close();

    const store = openStore(dbPath);
    assert.ok(Number(store.getMeta("schema_version")) >= 3);
    assert.strictEqual(store.getRawPage("https://legacy.example/5").content, "fused");
    assert.strictEqual(store.countNeedingRearchive(EXTRACTOR_VERSION), 50);
    store.close();
  });

  test("a v4 database is regrouped by site, with exact due times", () => {
    const dbPath = tmpDb("migrate-sites");
    let store = openStore(dbPath);
    // Rows as v4 stored them: one host per hostname.
    const now = Date.now();
    const ins = store.db.prepare(
      "INSERT INTO crawl_queue(url, host, depth, state, attempts, discovered_at, updated_at, next_eligible_at) VALUES(?, ?, 0, ?, 0, 1, 1, ?)",
    );
    store.db.exec("DROP TRIGGER trg_queue_due_insert");
    ins.run("https://a.tumblr.com/1", "a.tumblr.com", "pending", now + 500);
    ins.run("https://b.tumblr.com/1", "b.tumblr.com", "pending", now - 100);
    ins.run("https://c.tumblr.com/1", "c.tumblr.com", "failed", 0);
    ins.run("https://www.bbc.co.uk/1", "www.bbc.co.uk", "pending", now - 50);
    store.db.exec("INSERT INTO crawl_hosts(host) VALUES('a.tumblr.com'), ('b.tumblr.com'), ('www.bbc.co.uk')");
    store.setMeta("schema_version", "4");
    store.close();

    store = openStore(dbPath);
    const hosts = store.db.prepare("SELECT url, host FROM crawl_queue ORDER BY url").all();
    assert.deepStrictEqual(
      hosts.map((r) => r.host),
      ["tumblr.com", "tumblr.com", "tumblr.com", "bbc.co.uk"],
    );
    const sites = Object.fromEntries(
      store.db.prepare("SELECT host, next_due_at FROM crawl_hosts").all().map((r) => [r.host, r.next_due_at]),
    );
    assert.deepStrictEqual(Object.keys(sites).sort(), ["bbc.co.uk", "tumblr.com"]);
    assert.strictEqual(sites["tumblr.com"], now - 100, "due time is the earliest pending URL across the site");
    // One site, one turn: after a tumblr claim the next goes elsewhere.
    const first = store.claimNext(now, 60000);
    const second = store.claimNext(now, 60000);
    assert.strictEqual(first.host, "tumblr.com");
    assert.strictEqual(second.host, "bbc.co.uk");
    assert.strictEqual(store.claimNext(now, 60000), null, "tumblr was claimed twice in a row");
    assert.strictEqual(Number(store.getMeta("schema_version")), 5);
    store.close();
  });
});
