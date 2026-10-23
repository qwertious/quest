"use strict";

/**
 * The feed reader behind xWire.
 *
 * Works through data/feeds.sqlite (filled by the crawler as it finds feed
 * links), fetching each feed when it is due and storing its posts. Polite by
 * construction:
 *   - a steady global rate (FEEDS_PER_MINUTE), like the crawler's
 *   - one request per site per FEED_SITE_GAP_MS, sites as in site.js
 *   - robots.txt obeyed, via the crawler's own rules (robots.js)
 *   - conditional requests: an unchanged feed costs a 304 and no body
 *   - each feed asked about as often as it actually posts (feed_store.js)
 *
 *   node feeds.js          run forever
 *   node feeds.js --once   fetch whatever is due, then exit
 */

if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "8";

const http = require("node:http");
const https = require("node:https");
const axios = require("axios");
const { FeedStore } = require("./feed_store");
const { parseFeed, NotAFeedError } = require("./feed_parse");
const { createRobotsChecker, classifyNetworkError } = require("./robots");
const { SteadyRate } = require("./ratelimit");
const { dataPaths } = require("./paths");
const { ExyraStore, detectFetchError, detectRobots, sniffNotText } = require("./exyra");
const { requireUserAgent } = require("./operator");

function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const USER_AGENT = requireUserAgent("feed reader");
const FEEDS_PER_MINUTE = envInt("FEEDS_PER_MINUTE", 20);
const CONCURRENCY = Math.max(1, envInt("FEEDS_CONCURRENCY", 3));
const SITE_GAP_MS = envInt("FEED_SITE_GAP_MS", 30000);
const TIMEOUT_MS = envInt("FEED_TIMEOUT_MS", 15000);
const HARD_TIMEOUT_MS = envInt("FEED_HARD_TIMEOUT_MS", 30000);
const MAX_FEED_BYTES = envInt("FEED_MAX_BYTES", 3 * 1024 * 1024);
const IDLE_POLL_MS = envInt("FEEDS_IDLE_POLL_MS", 15000);
const STATUS_EVERY_MS = envInt("FEEDS_STATUS_EVERY_MS", 60000);
const DRAIN_GRACE_MS = envInt("FEEDS_DRAIN_GRACE_MS", 3000);

function log(message) {
  console.log(`[FEEDS] ${message}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

/** Retry-After as epoch ms (seconds or an HTTP date), or 0. */
function retryAfter(error) {
  const value = error?.response?.headers?.["retry-after"];
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Date.now() + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : 0;
}

async function main() {
  const once = process.argv.includes("--once");
  const paths = dataPaths();
  const store = new FeedStore({ dbPath: paths.feeds });
  // Anything odd goes to Exyra, same as the crawler's findings.
  let exyra = null;
  try {
    exyra = new ExyraStore({ dbPath: paths.exyra });
  } catch (error) {
    log(`Exyra unavailable: ${error?.message}`);
  }
  const noteExyra = (url, signals) => {
    if (!exyra || signals.length === 0) return;
    try {
      exyra.record(url, signals, { source: "feeds" });
    } catch {
      // Reporting must never break fetching.
    }
  };
  const robots = createRobotsChecker({
    userAgent: USER_AGENT,
    httpAgent,
    httpsAgent,
    onFetched: (origin, text, info) => noteExyra(`${origin}/robots.txt`, detectRobots(origin, text, info)),
  });
  const limiter = new SteadyRate(FEEDS_PER_MINUTE);

  log(`xWire feed reader: ${paths.feeds}`);
  log(`Rate: ${FEEDS_PER_MINUTE} feeds/min, concurrency ${CONCURRENCY}, ${SITE_GAP_MS / 1000}s between hits on one site`);
  log(`Feeds by state: ${JSON.stringify(store.stateCounts())}; ${store.postCount()} posts stored`);

  let stopping = false;
  let stopReason = "";
  const requestStop = (reason) => {
    if (stopping) return;
    stopping = true;
    stopReason = reason;
    log(`Stopping: ${reason}`);
  };
  const onSignal = (signal) => {
    if (!stopping) {
      requestStop(`signal-${signal}`);
      log("Finishing in-flight feeds. Press Ctrl-C again to stop immediately.");
      return;
    }
    try {
      store.setMetaBatch({ feeds_state: "idle", feeds_stop_reason: `forced-${signal}` });
      store.close();
    } catch {
      // Exiting regardless.
    }
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const stats = { fetched: 0, newPosts: 0, notModified: 0, invalid: 0, failed: 0, byKind: new Map() };
  const siteNextAt = new Map();
  const inFlight = new Set();
  let batch = [];
  let busy = 0;
  let idleSince = 0;

  const heartbeat = () =>
    store.setMetaBatch({ feeds_state: stopping ? "stopping" : "active", feeds_heartbeat: Date.now(), feeds_pid: process.pid });
  heartbeat();
  const timers = [
    setInterval(heartbeat, 10000),
    setInterval(() => {
      const kinds = [...stats.byKind.entries()].map(([k, n]) => `${k} ${n}`).join(", ");
      log(
        `status: ${stats.fetched} fetched (${stats.notModified} unchanged), ${stats.newPosts} new posts, ` +
          `${stats.invalid} not feeds, ${stats.failed} failed${kinds ? ` (${kinds})` : ""}; ` +
          `feeds ${JSON.stringify(store.stateCounts())}`,
      );
    }, STATUS_EVERY_MS),
  ];

  function nextFeed() {
    if (batch.length === 0) {
      batch = store.dueFeeds(Date.now(), 100).filter((f) => !inFlight.has(f.id));
    }
    return batch.shift() || null;
  }

  function fail(feed, reason, kind, options = {}) {
    stats.failed += 1;
    stats.byKind.set(kind, (stats.byKind.get(kind) || 0) + 1);
    store.recordFailure(feed.id, reason, options);
  }

  async function processFeed(feed) {
    // One site, one request per gap -- a thousand blogs on one host are one
    // host's worth of load, not a thousand.
    const now = Date.now();
    const siteFree = siteNextAt.get(feed.site) || 0;
    if (siteFree > now) {
      store.defer(feed.id, siteFree + Math.random() * SITE_GAP_MS);
      return;
    }
    siteNextAt.set(feed.site, now + SITE_GAP_MS);

    const verdict = await robots.check(feed.url);
    if (verdict.verdict === "disallowed") {
      fail(feed, "robots.txt disallows this feed", "robots", { state: "blocked" });
      return;
    }
    if (verdict.verdict === "unreachable") {
      if (verdict.fromCache) {
        store.defer(feed.id, verdict.retryAt);
      } else {
        fail(feed, `robots.txt unreachable (${verdict.kind}): ${verdict.reason}`, verdict.kind, { retryAt: verdict.retryAt });
      }
      return;
    }

    if (!(await limiter.acquire(() => stopping))) {
      store.defer(feed.id, Date.now());
      return;
    }

    let response;
    try {
      const headers = {
        "User-Agent": USER_AGENT,
        Accept:
          "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
      };
      if (feed.etag) headers["If-None-Match"] = feed.etag;
      if (feed.last_modified) headers["If-Modified-Since"] = feed.last_modified;
      response = await axios.get(feed.url, {
        headers,
        timeout: TIMEOUT_MS,
        signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
        maxRedirects: 5,
        maxContentLength: MAX_FEED_BYTES,
        responseType: "text",
        transformResponse: (data) => data,
        validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
        httpAgent,
        httpsAgent,
      });
    } catch (error) {
      const kind = classifyNetworkError(error);
      const status = error?.response?.status;
      const wireBytes = Number(error?.request?.socket?.bytesRead || 0);
      const signals = detectFetchError(feed.url, error, { capBytes: MAX_FEED_BYTES, wireBytes });
      noteExyra(feed.url, signals);
      if (signals.some((s) => s.category === "decompression-bomb" || s.category === "oversized-response")) {
        fail(feed, `${error?.message}`.slice(0, 200), kind, { state: "invalid" });
        return;
      }
      // A feed-shaped link that 404s was never a feed; a declared feed that
      // 404s or 410s is gone.
      const gone = status === 404 || status === 410;
      fail(feed, `${error?.message || kind}`.slice(0, 200), kind, {
        state: gone && (feed.kind === "guess" || status === 410) ? "invalid" : null,
        retryAt: retryAfter(error),
      });
      return;
    }

    stats.fetched += 1;
    if (response.status === 304) {
      stats.notModified += 1;
      store.recordNotModified(feed.id);
      return;
    }

    const finalUrl = response.request?.res?.responseUrl || feed.url;
    const notText = sniffNotText(response.data);
    if (notText) {
      stats.invalid += 1;
      noteExyra(feed.url, [{ category: "content-mismatch", detail: `feed served as ${response.headers["content-type"] || "?"} but ${notText}` }]);
      store.recordFailure(feed.id, `not a feed: ${notText}`, { state: "invalid" });
      return;
    }
    try {
      const parsed = parseFeed(response.data, finalUrl);
      stats.newPosts += store.recordSuccess(feed.id, parsed, {
        etag: response.headers.etag || "",
        lastModified: response.headers["last-modified"] || "",
      });
    } catch (error) {
      if (error instanceof NotAFeedError) {
        stats.invalid += 1;
        store.recordFailure(feed.id, `not a feed: ${error.message}`, { state: "invalid" });
      } else {
        fail(feed, `parse error: ${error?.message}`.slice(0, 200), "parse");
      }
    }
  }

  async function worker() {
    while (!stopping) {
      const feed = nextFeed();
      if (!feed) {
        if (busy === 0 && idleSince === 0) idleSince = Date.now();
        if (once && busy === 0 && Date.now() - idleSince >= DRAIN_GRACE_MS) return;
        await sleep(once ? 200 : IDLE_POLL_MS);
        continue;
      }
      idleSince = 0;
      inFlight.add(feed.id);
      busy += 1;
      try {
        await processFeed(feed);
      } catch (error) {
        log(`unexpected error on ${feed.url}: ${error?.message}`);
        try {
          store.recordFailure(feed.id, `unexpected: ${error?.message}`);
        } catch {
          // Nothing more to do for this feed.
        }
      } finally {
        busy -= 1;
        inFlight.delete(feed.id);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  for (const timer of timers) clearInterval(timer);
  log(
    `Done: ${stats.fetched} fetched (${stats.notModified} unchanged), ${stats.newPosts} new posts, ` +
      `${stats.invalid} not feeds, ${stats.failed} failed.`,
  );
  store.setMetaBatch({ feeds_state: "idle", feeds_stop_reason: stopReason || "completed", feeds_heartbeat: Date.now() });
  store.close();
  exyra?.close();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  // 130 = stopped on purpose, which run.sh takes as "stay stopped".
  if (stopReason.startsWith("signal-")) process.exitCode = 130;
}

main().catch((error) => {
  console.error(`[FEEDS] Fatal error: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
