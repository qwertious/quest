"use strict";

/**
 * robots.txt per RFC 9309, and what an unreachable host is allowed to cost.
 *
 *   2xx     -> obey the rules
 *   4xx     -> "unavailable": the crawler MAY fetch anything
 *   5xx, 429, or a network error -> "unreachable": MUST assume disallow
 *
 * Each case runs as its own crawl, because every fake host shares the
 * 127.0.0.1 hostname and parking one would otherwise hide another.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const {
  tmpDb,
  openStore,
  runQuest,
  startRobotsHost,
  startBlackhole,
  refusedPort,
  QUEST_DIR,
} = require("./helpers");

const threeUrls = (port) => [1, 2, 3].map((i) => `http://127.0.0.1:${port}/p${i}`);

async function crawl(port) {
  const dbPath = tmpDb("robots");
  const started = Date.now();
  const run = await runQuest(dbPath, [...threeUrls(port), "--once"]);
  const store = openStore(dbPath);
  const result = {
    run,
    ms: Date.now() - started,
    archived: store.getRawPageCount(),
    rows: store.db
      .prepare("SELECT url, state, attempts, last_note FROM crawl_queue ORDER BY url")
      .all(),
    hostAvailableAt: store.db.prepare("SELECT next_available_at a FROM crawl_hosts").get()?.a || 0,
  };
  store.close();
  return result;
}

describe("robots.txt handling", () => {
  const hosts = {};
  const results = {};
  let blackhole;

  before(async () => {
    for (const kind of ["404", "503", "429", "disallow", "silent", "huge", "wildcard"]) {
      hosts[kind] = await startRobotsHost(kind);
      results[kind] = await crawl(hosts[kind].port);
    }
    blackhole = await startBlackhole();
    results.blackhole = await crawl(blackhole.port);
    results.refused = await crawl(await refusedPort());
  });

  after(async () => {
    for (const h of Object.values(hosts)) await h.close();
    await blackhole.close();
  });

  test("4xx robots.txt means crawl freely", () => {
    assert.strictEqual(hosts["404"].hits.pages, 3);
    assert.strictEqual(results["404"].archived, 3);
  });

  for (const kind of ["503", "429", "silent"]) {
    test(`${kind} robots.txt: no page is ever requested`, () => {
      assert.strictEqual(hosts[kind].hits.pages, 0);
      assert.strictEqual(results[kind].archived, 0);
    });
  }

  test("a host that accepts and never speaks is not crawled", () => {
    assert.strictEqual(results.blackhole.archived, 0);
  });

  test("a refused port is not crawled", () => {
    assert.strictEqual(results.refused.archived, 0);
  });

  for (const kind of ["503", "429", "silent", "blackhole", "refused"]) {
    test(`${kind}: nothing is blocked permanently, so it is retried later`, () => {
      assert.ok(results[kind].rows.every((r) => r.state !== "blocked"), JSON.stringify(results[kind].rows));
    });
  }

  for (const kind of ["503", "silent", "blackhole", "refused"]) {
    test(`${kind}: one outage costs one attempt`, () => {
      const charged = results[kind].rows.filter((r) => /robots\.txt unreachable/.test(r.last_note));
      assert.strictEqual(charged.length, 1, JSON.stringify(results[kind].rows));
      for (const r of results[kind].rows.filter((x) => !/robots\.txt unreachable/.test(x.last_note))) {
        assert.strictEqual(r.attempts, 0, `sibling burned an attempt: ${JSON.stringify(r)}`);
        assert.strictEqual(r.state, "pending");
      }
    });
  }

  // A site that resets or stalls connections is refusing us as a whole (how
  // Tumblr's IP block looked), so the site is parked. A 503 or a refused port
  // is about one hostname; the site's other hostnames carry on.
  for (const kind of ["silent", "blackhole"]) {
    test(`${kind}: the whole site is parked`, () => {
      assert.ok(results[kind].hostAvailableAt > Date.now(), "site was not parked");
    });
  }
  for (const kind of ["503", "refused"]) {
    test(`${kind}: the site is not parked over one hostname`, () => {
      assert.ok(results[kind].hostAvailableAt <= Date.now() + 60000, "site was parked");
    });
  }

  test("each failure names the layer that broke", () => {
    assert.match(results.silent.run.out, /robots\.txt unreachable \((stall|hard-timeout)\)/);
    assert.match(results.blackhole.run.out, /robots\.txt unreachable \((stall|hard-timeout)\)/);
    assert.match(results["503"].run.out, /robots\.txt unreachable \(http5xx\)/);
    assert.match(results["429"].run.out, /robots\.txt unreachable \(http429\)/);
    assert.match(results.refused.run.out, /robots\.txt unreachable \(refused\)/);
  });

  test("an explicit Disallow still blocks permanently", () => {
    assert.strictEqual(hosts.disallow.hits.pages, 0);
    assert.ok(results.disallow.rows.every((r) => r.state === "blocked"));
  });

  test("an oversized robots.txt is obeyed up to 512 KB, not treated as unreachable", () => {
    const byUrl = Object.fromEntries(results.huge.rows.map((r) => [r.url.replace(/.*\//, ""), r.state]));
    assert.strictEqual(byUrl.p2, "blocked", JSON.stringify(results.huge.rows));
    // p1/p3 fetched: the half-read "Disallow: /" at the cut was dropped.
    assert.strictEqual(hosts.huge.hits.pages, 2, results.huge.run.out);
    assert.strictEqual(results.huge.archived, 2);
  });

  test("wildcard rules are obeyed, and '/**' is not an error", () => {
    const byUrl = Object.fromEntries(results.wildcard.rows.map((r) => [r.url.replace(/.*\//, ""), r.state]));
    assert.strictEqual(byUrl.p2, "blocked", JSON.stringify(results.wildcard.rows));
    assert.strictEqual(hosts.wildcard.hits.pages, 2, results.wildcard.run.out);
    assert.doesNotMatch(results.wildcard.run.out, /unreachable|Invalid regular expression/);
  });

  test("a silent host costs about the hard cap, not minutes", () => {
    assert.ok(results.silent.ms < 15000, `${results.silent.ms}ms`);
    assert.ok(results.blackhole.ms < 15000, `${results.blackhole.ms}ms`);
  });

  test("status lines show where each attempt's time went, by layer", () => {
    assert.match(results["404"].run.out, /per attempt \(\d+ this interval\): robots\.txt \S+, rate wait \S+, fetch \S+, store \S+/);
    assert.match(results.silent.run.out, /failures by layer this interval: /);
    assert.match(results["404"].run.out, /threadpool 16; robots\.txt hard cap 800ms, page hard cap \d+ms/);
  });
});

describe("robots.txt rules and cache", () => {
  const { parseRobotsTxt, isPathAllowedByRules, createRobotsChecker } = require(path.join(QUEST_DIR, "robots"));

  test("prefix, wildcard and anchored rules; the longest rule wins, allow wins a tie", () => {
    const rules = parseRobotsTxt(
      [
        "User-agent: *",
        "Disallow: /",
        "Allow: /public/",
        "Disallow: /public/private",
        "Allow: /docs/",
        "Disallow: /*.pdf$",
        "Disallow: tmp",
        "Allow: /x",
        "Disallow: /x",
      ].join("\n"),
    );
    const allowed = (p) => isPathAllowedByRules(p, rules);
    assert.strictEqual(allowed("/anything"), false);
    assert.strictEqual(allowed("/public/page"), true);
    assert.strictEqual(allowed("/public/private/page"), false);
    // "/*.pdf$" (7 chars) outranks "Allow: /docs/" (6); "/public/" (8) outranks it.
    assert.strictEqual(allowed("/docs/a.pdf"), false);
    assert.strictEqual(allowed("/docs/a.pdf?v=1"), true, "$ anchors the end");
    assert.strictEqual(allowed("/public/a.pdf"), true, "longest match wins");
    assert.strictEqual(allowed("/tmp/a"), false, "rule without a leading slash");
    assert.strictEqual(allowed("/x"), true, "allow wins a same-length tie");
  });

  test("the cache stays inside its rule budget", async () => {
    const hosts = [];
    for (let i = 0; i < 3; i += 1) hosts.push(await startRobotsHost("rules100"));
    const checker = createRobotsChecker({ userAgent: "test", cacheMaxRules: 150 });
    for (const host of hosts) {
      assert.strictEqual((await checker.check(`http://127.0.0.1:${host.port}/r5/x`)).verdict, "disallowed");
      assert.ok(checker.ruleCount() <= 150, `${checker.ruleCount()} rules cached`);
    }
    assert.strictEqual(checker.cache.size, 1, "older sites not evicted");
    for (const host of hosts) await host.close();
  });
});

describe("daily budget", () => {
  test("a budget-deferred URL is handed back, not left stuck 'active'", async () => {
    const host = await startRobotsHost("404");
    const dbPath = tmpDb("budget");
    // Budget of 1: the first URL is fetched, the second trips the budget.
    await runQuest(dbPath, [...threeUrls(host.port), "--once"], {
      QUEST_DAILY_DOMAIN_BUDGET: "1",
      QUEST_CONCURRENCY: "1",
    });
    const store = openStore(dbPath);
    const states = store.getQueueStateCounts();
    assert.strictEqual(states.active || 0, 0, `rows stuck active: ${JSON.stringify(states)}`);
    const deferred = store.db
      .prepare("SELECT attempts FROM crawl_queue WHERE state = 'pending' AND next_eligible_at > ?")
      .all(Date.now());
    assert.ok(deferred.length >= 1, "no URL was deferred to the next day");
    assert.ok(deferred.every((r) => r.attempts === 0), "budget deferral charged an attempt");
    store.close();
    await host.close();
  });
});
