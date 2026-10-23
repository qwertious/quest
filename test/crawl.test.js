"use strict";

/** End to end: real crawler process against a local site. */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const {
  tmpDb,
  openStore,
  runQuest,
  runMaintain,
  spawnQuest,
  startSite,
  QUEST_DIR,
} = require("./helpers");
const { EXTRACTOR_VERSION } = require(path.join(QUEST_DIR, "extract"));

let site;
before(async () => {
  site = await startSite();
});
after(async () => {
  await site.close();
});

describe("a crawl", () => {
  let dbPath;
  let run;

  before(async () => {
    dbPath = tmpDb("crawl");
    run = await runQuest(dbPath, [`${site.base}/a/0`, "--once", "--max-pages=10"]);
  });

  test("exits cleanly", () => assert.strictEqual(run.code, 0, run.out));

  test("stores HTML, text and search rows for every page", () => {
    const store = openStore(dbPath);
    const pages = store.getRawPageCount();
    assert.ok(pages >= 5, `only ${pages} pages`);
    assert.strictEqual(store.getHtmlStats().pages, pages);
    assert.strictEqual(store.getSearchIndexCount(), pages);
    store.close();
  });

  test("text keeps structure and has no fused words", () => {
    const store = openStore(dbPath);
    const row = store.db.prepare("SELECT url FROM raw_pages LIMIT 1").get();
    const text = store.getRawPage(row.url).content;
    assert.ok(text.includes("\n"));
    assert.ok(!text.includes("spring,harvest") && !text.includes("AlphaBeta"));
    assert.ok(!text.includes("should be stripped"), "script text leaked");
    store.close();
  });

  test("honors robots.txt, skips binaries, retries 5xx", () => {
    const store = openStore(dbPath);
    const q = (like) => store.db.prepare("SELECT state, next_eligible_at FROM crawl_queue WHERE url LIKE ?").get(like);
    assert.strictEqual(q("%/secret%")?.state, "blocked");
    assert.strictEqual(q("%/binary")?.state, "failed");
    const boom = q("%/boom");
    assert.strictEqual(boom?.state, "pending");
    assert.ok(boom.next_eligible_at > Date.now(), "5xx should be backed off");
    // A 404 is final on the first try; retrying dead links tripled their cost.
    const gone = store.db.prepare("SELECT state, attempts FROM crawl_queue WHERE url LIKE ?").get("%/gone");
    assert.deepStrictEqual({ ...gone }, { state: "failed", attempts: 1 });
    store.close();
  });

  test("leaves nothing stuck in flight", () => {
    const store = openStore(dbPath);
    assert.strictEqual(store.getQueueStateCounts().active || 0, 0);
    store.close();
  });
});

describe("re-archive", () => {
  test("refetches stale pages while keeping the queue and index", async () => {
    const dbPath = tmpDb("rearchive-e2e");
    await runQuest(dbPath, [`${site.base}/a/0`, "--once", "--max-pages=8"]);

    let store = openStore(dbPath);
    store.db.exec("UPDATE raw_pages SET extractor_version = 1; DELETE FROM raw_html;");
    const stale = store.countNeedingRearchive(EXTRACTOR_VERSION);
    const indexBefore = store.getSearchIndexCount();
    store.close();

    const marked = await runMaintain(dbPath, ["--rearchive"]);
    assert.strictEqual(marked.code, 0, marked.out);
    assert.match(marked.out, /Queued \d+ page\(s\) for immediate refetch/);

    await runQuest(dbPath, [`${site.base}/a/0`, "--once"]);
    store = openStore(dbPath);
    assert.ok(store.countNeedingRearchive(EXTRACTOR_VERSION) < stale);
    assert.ok(store.getHtmlStats().pages > 0);
    assert.ok(store.getSearchIndexCount() >= indexBefore, "search index shrank");
    store.close();
  });

  test("the ETA counts old stale pages, not just recently fetched ones", async () => {
    const dbPath = tmpDb("rearchive-eta");
    await runQuest(dbPath, [`${site.base}/a/0`, "--once", "--max-pages=20"]);
    let store = openStore(dbPath);
    // Stale AND long past their refresh date: the common case in production,
    // and the one the old counter ignored.
    store.db.exec(`
      UPDATE raw_pages SET extractor_version = 1, timestamp = 1;
      UPDATE search_index SET timestamp = 1;
      DELETE FROM raw_html;`);
    store.close();
    await runMaintain(dbPath, ["--rearchive"]);

    const child = spawnQuest(dbPath, [`${site.base}/a/0`], { QUEST_PAGES_PER_MINUTE: "120" });
    const until = Date.now() + 10000;
    const eta = /re-archive: .* to go, ~[\d.]+ (min|h) at current rate\n/;
    while (!eta.test(child.output) && child.exitCode === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill("SIGKILL");
    await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
    assert.match(child.output, eta);
  });

  test("--reextract fixes stale text from stored HTML with no network", async () => {
    const dbPath = tmpDb("reextract-e2e");
    await runQuest(dbPath, [`${site.base}/a/0`, "--once", "--max-pages=5"]);
    let store = openStore(dbPath);
    store.db.exec("UPDATE raw_pages SET extractor_version = 1");
    const withHtml = store.getHtmlStats().pages;
    store.close();

    const r = await runMaintain(dbPath, ["--reextract"]);
    assert.strictEqual(r.code, 0, r.out);
    store = openStore(dbPath);
    assert.strictEqual(store.getExtractorVersionCounts()[EXTRACTOR_VERSION], withHtml);
    store.close();
  });

  test("an abrupt kill mid-run loses no finished work and redoes none", async () => {
    const dbPath = tmpDb("resume");
    await runQuest(dbPath, [`${site.base}/a/0`, "--once", "--max-pages=30"]);
    let store = openStore(dbPath);
    store.db.exec("UPDATE raw_pages SET extractor_version = 1; DELETE FROM raw_html;");
    store.close();
    await runMaintain(dbPath, ["--rearchive"]);

    const child = spawnQuest(dbPath, [`${site.base}/a/0`], { QUEST_PER_HOST_DELAY_MS: "1" });
    await new Promise((r) => setTimeout(r, 2500));
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));

    store = openStore(dbPath);
    const doneBefore = new Map(
      store.db
        .prepare("SELECT url, timestamp FROM raw_pages WHERE extractor_version >= ?")
        .all(EXTRACTOR_VERSION)
        .map((r) => [r.url, r.timestamp]),
    );
    store.close();
    assert.ok(doneBefore.size > 0, "nothing finished before the kill -- window too short");

    const resumed = await runQuest(dbPath, [`${site.base}/a/0`, "--once"]);
    assert.strictEqual(resumed.code, 0);

    store = openStore(dbPath);
    for (const [url, ts] of doneBefore) {
      const row = store.db.prepare("SELECT timestamp FROM raw_pages WHERE url = ?").get(url);
      assert.strictEqual(row.timestamp, ts, `${url} was refetched after resume`);
    }
    assert.strictEqual(store.getQueueStateCounts().active || 0, 0);
    store.close();
  });
});

describe("resilience", () => {
  test("a trickling response is cut off by the hard timeout", async () => {
    const dbPath = tmpDb("tarpit");
    const t0 = Date.now();
    const r = await runQuest(dbPath, [`${site.base}/tarpit`, "--once", "--max-pages=1"], {
      QUEST_REQUEST_TIMEOUT_MS: "10000",
      QUEST_HARD_TIMEOUT_MS: "700",
      QUEST_MAX_ATTEMPTS: "1",
      QUEST_CONCURRENCY: "1",
    });
    assert.strictEqual(r.code, 0);
    assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0}ms`);
    assert.match(r.out, /hard timeout/i);
  });

  test("a page with thousands of links is capped", async () => {
    const dbPath = tmpDb("manylinks");
    const r = await runQuest(dbPath, [`${site.base}/manylinks`, "--once", "--max-pages=1"], {
      QUEST_MAX_LINKS_PER_PAGE: "50",
      QUEST_CONCURRENCY: "1",
    });
    assert.match(r.out, /more than 50 links/);
    const store = openStore(dbPath);
    const queued = store.db.prepare("SELECT COUNT(*) c FROM crawl_queue").get().c;
    assert.ok(queued <= 51 + 5, `queued ${queued}`);
    store.close();
  });

  test("the memory circuit breaker stops the process cleanly", async () => {
    const dbPath = tmpDb("memstop");
    const r = await runQuest(dbPath, [`${site.base}/a/0`], {
      QUEST_MEMORY_STOP_MB: "1",
      QUEST_MEMORY_PAUSE_MB: "1",
      QUEST_MEMORY_CHECK_EVERY_MS: "200",
    });
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /Stopping: memory-hard-limit/);
    const store = openStore(dbPath);
    assert.strictEqual(store.getMeta("crawler_state"), "idle");
    assert.strictEqual(store.getQueueStateCounts().active || 0, 0);
    store.close();
  });

  test("QUEST_FORCE_IPV4 still crawls, and startup says which mode is on", async () => {
    const dbPath = tmpDb("ipv4");
    const r = await runQuest(dbPath, [`${site.base}/a/0`, "--once", "--max-pages=3"], {
      QUEST_FORCE_IPV4: "true",
    });
    assert.strictEqual(r.code, 0);
    assert.match(r.out, /Networking: IPv4 forced/);
    assert.match(r.out, /Processed [1-9]\d* page/);
  });
});

describe("responsiveness", () => {
  const waitFor = async (child, re, ms) => {
    const until = Date.now() + ms;
    while (!re.test(child.output) && child.exitCode === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return re.test(child.output);
  };

  test("the status line reports event-loop stalls and claim timing", async () => {
    const child = spawnQuest(tmpDb("loopstats"), [`${site.base}/a/0`], { QUEST_PAGES_PER_MINUTE: "30" });
    const seen = await waitFor(child, /event loop: longest stall \d/, 8000);
    child.kill("SIGKILL");
    await new Promise((r) => child.on("exit", r));
    assert.ok(seen, child.output);
    assert.match(child.output, /claims: \d+, avg/);
  });

  // Windows has no catchable SIGINT for child processes; the server is Linux.
  test("one Ctrl-C stops cleanly with exit code 130, which run.sh won't restart", { skip: process.platform === "win32" }, async () => {
    const dbPath = tmpDb("sigint");
    const child = spawnQuest(dbPath, [`${site.base}/a/0`]);
    assert.ok(await waitFor(child, /status:/, 8000), child.output);
    child.kill("SIGINT");
    const code = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("exit", r)));
    assert.strictEqual(code, 130, child.output);
    assert.match(child.output, /Run complete/);
  });

  test("a second Ctrl-C exits at once, leaving no claims active", { skip: process.platform === "win32" }, async () => {
    const dbPath = tmpDb("doublesigint");
    // A slow rate keeps the first, graceful stop waiting on the limiter.
    const child = spawnQuest(dbPath, [`${site.base}/a/0`], { QUEST_PAGES_PER_MINUTE: "1", QUEST_CONCURRENCY: "4" });
    assert.ok(await waitFor(child, /status:/, 8000), child.output);
    child.kill("SIGINT");
    assert.ok(await waitFor(child, /Press Ctrl-C again/, 3000), child.output);
    child.kill("SIGINT");
    const code = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("exit", r)));
    assert.strictEqual(code, 130, child.output);
    const store = openStore(dbPath);
    assert.strictEqual(store.getQueueStateCounts().active || 0, 0);
    store.close();
  });
});
