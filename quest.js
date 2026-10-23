"use strict";

/**
 * QUEST: Qwertious Unified Extraction and Scanning Tool
 * Tagline: "Congratulations! You are on a QUEST!"
 *
 * Long-running crawler. Fetches at a steady, configurable rate and keeps two
 * caches in SQLite:
 *   raw_pages    -- full cleaned page text (gzipped by default)
 *   search_index -- title, summary and keywords, mirrored into FTS5
 *
 * The crawl frontier lives in the database. This process holds no queue in
 * memory, so its footprint stays flat no matter how large the frontier grows.
 *
 * Usage:
 *   node quest.js                     run forever at the configured rate
 *   node quest.js --once              drain what is currently due, then exit
 *   node quest.js --max-pages=500     stop after 500 pages
 *   node quest.js https://seed.url    add seeds (repeatable)
 */

// Must run before anything touches libuv's threadpool. dns.lookup() runs on
// that pool (default: 4 threads) and CANNOT be cancelled -- when a request is
// aborted mid-lookup, the getaddrinfo() call keeps its thread until the
// resolver gives up on its own. On a box with a slow resolver, aborted
// requests leave zombie lookups holding every thread, and every new request
// queues behind them before any timeout even starts. A bigger pool doesn't fix
// slow DNS, but it stops slow DNS from stalling the whole crawler.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = "16";
}

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const axios = require("axios");
const { createRobotsChecker, classifyNetworkError } = require("./robots");
const { SteadyRate } = require("./ratelimit");
const { canonicalUrl, hasSkippedExtension } = require("./urls");
const { ImageStore } = require("./image_store");
const { FeedStore } = require("./feed_store");
const { dataPaths } = require("./paths");
const {
  ExyraStore,
  detectFetchError,
  detectFromNote,
  detectRobots,
  detectUrl,
  sniffNotText,
} = require("./exyra");
const { QuestSqliteStore } = require("./sqlite_store");
const { startBackground } = require("./background");
const { siteOf } = require("./site");
const { parsePage, EXTRACTOR_VERSION } = require("./extract");
const { requireUserAgent } = require("./operator");

const QUEST_NAME = "Qwertious Unified Extraction and Scanning Tool";
const QUEST_TAGLINE = "Congratulations! You are on a QUEST!";

/**
 * Zero is a legitimate value for most of these settings -- no per-host delay,
 * no depth limit, no daily budget -- so it must be accepted rather than
 * treated as "unset" and silently replaced by the default.
 */
function envInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Rates divide into an interval, so zero is not meaningful here. */
function envFloat(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

// --- pacing -----------------------------------------------------------------
// The whole point of the rewrite: one knob that sets a steady, predictable rate.
const PAGES_PER_MINUTE = envFloat("QUEST_PAGES_PER_MINUTE", 60);
// At least one worker, or the crawler would start and immediately idle.
const CONCURRENCY = Math.max(1, envInt("QUEST_CONCURRENCY", 4));
const PER_HOST_DELAY_MS = envInt("QUEST_PER_HOST_DELAY_MS", 5000);
const IDLE_POLL_MS = envInt("QUEST_IDLE_POLL_MS", 1000);
const EMPTY_QUEUE_SLEEP_MS = envInt("QUEST_EMPTY_QUEUE_SLEEP_MS", 30000);
// --once waits this long with nothing claimable and nothing in flight before
// deciding the frontier really is drained rather than just cooling down.
const DRAIN_GRACE_MS = envInt("QUEST_DRAIN_GRACE_MS", 20000);

// --- fetching ---------------------------------------------------------------
const USER_AGENT = requireUserAgent("educational scraper");
const REQUEST_TIMEOUT_MS = envInt("QUEST_REQUEST_TIMEOUT_MS", 12000);
// axios's own `timeout` is an IDLE timeout under the hood (Node resets it on
// every byte received), so a server that trickles a few bytes every few
// seconds -- deliberately (a tarpit) or not -- never trips it and can hold a
// connection open indefinitely. This is a hard ceiling on total request time,
// enforced independently of how much trickle activity there is.
const HARD_TIMEOUT_MS = envInt("QUEST_HARD_TIMEOUT_MS", REQUEST_TIMEOUT_MS * 2);
const ROBOTS_TIMEOUT_MS = envInt("QUEST_ROBOTS_TIMEOUT_MS", 6000);
// Wall-clock cap on the whole robots.txt fetch, DNS and TCP connect included.
// ROBOTS_TIMEOUT_MS above is axios's idle timer, which Node only arms once the
// connection is up -- so without this, a host stuck in DNS or connect could
// hold a worker for the OS connect timeout (~2 minutes on Linux) before the
// 6s timer ever started.
const ROBOTS_HARD_TIMEOUT_MS = envInt("QUEST_ROBOTS_HARD_TIMEOUT_MS", 10000);
// An unreachable robots.txt means "assume disallow" (RFC 9309 2.3.1.4). Cache
// that verdict briefly, not for the usual 24h: it is about the network path
// right now, and every other URL on the host should skip fast instead of each
// paying the same timeout -- but the host deserves another try later.
const ROBOTS_UNREACHABLE_TTL_MS = envInt("QUEST_ROBOTS_UNREACHABLE_TTL_MS", 60 * 60 * 1000);
// RFC 9309 requires parsing at least 500 KiB.
const ROBOTS_MAX_BYTES = 512 * 1024;
// robots.txt failures that mean the whole site is refusing this crawler.
const SITE_WIDE_FAILURES = new Set(["reset", "stall", "hard-timeout", "http429", "connect"]);
const MAX_HTML_BYTES = envInt("QUEST_MAX_HTML_BYTES", 2 * 1024 * 1024);
const MAX_CONTENT_CHARS = envInt("QUEST_MAX_CONTENT_CHARS", 200000);
const MAX_ATTEMPTS = envInt("QUEST_MAX_ATTEMPTS", 3);
// Answers that won't be different in half an hour: the page is gone, or
// we're not allowed it. Retrying them tripled the cost of every dead link
// (most failures are 404s from links on re-crawled pages). Timeouts, 429s,
// 5xx and the like still get their retries.
const FINAL_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 414, 451]);
const RETRY_BACKOFF_MS = [5 * 60 * 1000, 30 * 60 * 1000, 4 * 60 * 60 * 1000];
// A crafted or generated page can dump tens of thousands of links into a
// single response (a spam farm, an infinite faceted-search trap). Past this
// many, the rest of the page is almost never worth discovering.
const MAX_LINKS_PER_PAGE = envInt("QUEST_MAX_LINKS_PER_PAGE", 500);

// --- policy -----------------------------------------------------------------
const TOP_KEYWORDS = 20;
const FOLLOW_EXTERNAL_LINKS = envBool("QUEST_FOLLOW_EXTERNAL_LINKS", true);
const DAILY_DOMAIN_BUDGET = envInt("QUEST_DAILY_DOMAIN_BUDGET", 50);
const REINDEX_AFTER_DAYS = envInt("QUEST_REINDEX_AFTER_DAYS", 30);
const REINDEX_AFTER_MS = REINDEX_AFTER_DAYS * 24 * 60 * 60 * 1000;
const MAX_DEPTH = envInt("QUEST_MAX_DEPTH", 0); // 0 = unlimited
const MAX_QUEUE_ROWS = envInt("QUEST_MAX_QUEUE_ROWS", 2000000);
const COMPRESS_CONTENT = envBool("QUEST_COMPRESS_CONTENT", true);
// Keeping the original HTML is what makes extraction changes cheap: a new
// extractor becomes a local re-extract pass instead of another full crawl.
// It is also the bulk of the disk cost -- see README before turning it off.
const STORE_HTML = envBool("QUEST_STORE_HTML", true);
// Images (for xImages) and feed links (for xWire) found on each page.
const INDEX_MEDIA = envBool("QUEST_INDEX_MEDIA", true);
// Exyra's files for the Exyra project, rewritten from data/exyra.sqlite.
const EXYRA_EXPORT_BASE = process.env.QUEST_EXYRA_EXPORT || path.join(__dirname, "exyra");
const EXYRA_EXPORT_EVERY_MS = envInt("QUEST_EXYRA_EXPORT_EVERY_MS", 3 * 60 * 60 * 1000);
const MAX_STORED_HTML_BYTES = envInt("QUEST_MAX_STORED_HTML_BYTES", MAX_HTML_BYTES);
// Opt-in, off by default: on some VPS boxes IPv6 is advertised in DNS but has
// no real upstream route, so every HTTPS connection tries AAAA first, hangs
// until the request timeout kills it, and only then falls back -- producing
// near-universal timeouts across totally unrelated hosts. If a run is failing
// almost everything with "timeout of Nms exceeded" regardless of target,
// that symptom is diagnostic: try this before suspecting the target sites.
const FORCE_IPV4 = envBool("QUEST_FORCE_IPV4", false);

// --- housekeeping cadence ---------------------------------------------------
const HEARTBEAT_EVERY_MS = 10000;
const STATUS_EVERY_MS = envInt("QUEST_STATUS_EVERY_MS", 60000);
const COUNTS_EVERY_MS = envInt("QUEST_COUNTS_EVERY_MS", 60000);
const CHECKPOINT_EVERY_MS = envInt("QUEST_CHECKPOINT_EVERY_MS", 120000);
const REARCHIVE_RECOUNT_MS = envInt("QUEST_REARCHIVE_RECOUNT_MS", 15 * 60 * 1000);
// A periodic job that holds the event loop longer than this gets logged.
const SLOW_JOB_MS = envInt("QUEST_SLOW_JOB_MS", 1000);
const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ROBOTS_CACHE_MAX = 5000;
const MEMORY_CHECK_EVERY_MS = envInt("QUEST_MEMORY_CHECK_EVERY_MS", 5000);
// Two thresholds, not one: PAUSE stops claiming new work and lets in-flight
// fetches finish and V8 catch up on GC, without giving up the process or its
// place in the schedule. STOP is the last resort -- exit cleanly (so nothing
// is mid-write when it happens) rather than wait for the OS to kill it.
// Defaults assume a machine with real memory to spare; override both down on
// a small box, e.g. 250/450 for a 2GB server also running a web stack.
const MEMORY_PAUSE_MB = envInt("QUEST_MEMORY_PAUSE_MB", 450);
const MEMORY_STOP_MB = envInt("QUEST_MEMORY_STOP_MB", 700);

const DATA_DIR = process.env.QUEST_DATA_DIR || path.join(__dirname, "data");
const SQLITE_DB_PATH =
  process.env.QUEST_DB_PATH || path.join(DATA_DIR, "quest.sqlite");
const BLACKLIST_CANDIDATES = [
  path.join(__dirname, "blacklist.json"),
  path.join(DATA_DIR, "blacklist.json"),
];

const DEFAULT_URLS = [
  "https://example.com",
  "https://example.org",
  "https://www.iana.org/domains/reserved",
];

const DEFAULT_BLACKLIST = {
  exactUrls: [],
  urlPrefixes: [],
  blockedHosts: [],
  pathContains: [
    "/login",
    "/signin",
    "/signup",
    "/account",
    "/checkout",
    "/cart",
    "/wp-admin",
    "/admin",
    "/private",
    "/session",
    "/auth",
    "/oauth",
  ],
};

const STOPWORDS = new Set(
  ("a about above after again against all also am an and any are as at be because been before being below between both but by can did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why with would you your yours yourself yourselves").split(
    " ",
  ),
);

// ---------------------------------------------------------------- utilities

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function log(message) {
  console.log(`[QUEST] ${message}`);
}

function fmtCount(n) {
  return Math.round(n).toLocaleString("en-US");
}

function getUtcDayKey(timestampMs = Date.now()) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function getNextUtcMidnight(timestampMs = Date.now()) {
  const d = new Date(timestampMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// ------------------------------------------------------------------ blacklist

function sanitizeBlacklist(rawBlacklist) {
  const next = {
    exactUrls: [],
    urlPrefixes: [],
    blockedHosts: [],
    pathContains: [],
  };

  for (const key of Object.keys(next)) {
    const items = Array.isArray(rawBlacklist?.[key]) ? rawBlacklist[key] : [];
    next[key] = [
      ...new Set(
        items
          .filter((v) => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];
  }

  return next;
}

function readBlacklistFromDisk() {
  for (const candidate of BLACKLIST_CANDIDATES) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      return { config: sanitizeBlacklist(parsed), source: candidate };
    } catch (error) {
      console.warn(
        `[QUEST] Ignoring unreadable blacklist ${candidate}: ${error?.message}`,
      );
    }
  }
  return { config: sanitizeBlacklist(DEFAULT_BLACKLIST), source: "built-in defaults" };
}

function createBlacklistMatcher(config) {
  return {
    exactSet: new Set(config.exactUrls.map((v) => canonicalUrl(v)).filter(Boolean)),
    prefixes: config.urlPrefixes.map((v) => v.toLowerCase()),
    blockedHosts: new Set(config.blockedHosts.map((h) => h.toLowerCase())),
    pathContains: config.pathContains.map((v) => v.toLowerCase()),
  };
}

function isBlacklisted(url, matcher) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  if (matcher.exactSet.has(url)) {
    return true;
  }
  if (matcher.blockedHosts.has(parsed.hostname.toLowerCase())) {
    return true;
  }

  const lowered = url.toLowerCase();
  for (const prefix of matcher.prefixes) {
    if (lowered.startsWith(prefix)) {
      return true;
    }
  }

  const pathLower = parsed.pathname.toLowerCase();
  for (const fragment of matcher.pathContains) {
    if (pathLower.includes(fragment)) {
      return true;
    }
  }

  return false;
}

// --------------------------------------------------------------- robots.txt

// Reused across every request rather than created per-call, so connections
// actually pool. Only constructed with family:4 when FORCE_IPV4 is set --
// otherwise axios/Node use their normal (dual-stack, Happy-Eyeballs-if-
// available) behavior unchanged.
const httpAgent = new http.Agent(FORCE_IPV4 ? { family: 4 } : {});
const httpsAgent = new https.Agent(FORCE_IPV4 ? { family: 4 } : {});

// The rules themselves live in robots.js, shared with the feed reader.
// Exyra suspects (exyra.js): opened in main(). Anything that notices
// something unlike an ordinary page reports it here; reporting never throws
// and never affects the crawl.
let exyraStore = null;
let exyraSignals = 0;
let exyraNewSuspects = 0;
let exyraErrors = 0;
function noteExyra(url, signals, referrer = "") {
  if (!exyraStore || !signals || signals.length === 0) return;
  try {
    exyraNewSuspects += exyraStore.record(url, signals, { source: "crawler", referrer });
    exyraSignals += signals.length;
  } catch (error) {
    exyraErrors += 1;
    if (exyraErrors <= 3) log(`exyra: could not record ${url}: ${error?.message}`);
  }
}

const robots = createRobotsChecker({
  onFetched: (origin, text, info) => noteExyra(`${origin}/robots.txt`, detectRobots(origin, text, info)),
  userAgent: USER_AGENT,
  httpAgent,
  httpsAgent,
  timeoutMs: ROBOTS_TIMEOUT_MS,
  hardTimeoutMs: ROBOTS_HARD_TIMEOUT_MS,
  cacheTtlMs: ROBOTS_CACHE_TTL_MS,
  unreachableTtlMs: ROBOTS_UNREACHABLE_TTL_MS,
  cacheMax: ROBOTS_CACHE_MAX,
  maxBytes: ROBOTS_MAX_BYTES,
});
const robotsCache = robots.cache;
const robotsUnreachableByKind = robots.unreachableByKind;
let robotsUnreachableLoggedAt = 0;
const checkRobots = robots.check;

// -------------------------------------------------------- extraction pipeline

async function fetchHtml(url) {
  let response;
  try {
    response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      // Belt and suspenders: `timeout` above only fires on a fully idle
      // socket, so it does nothing against a connection that keeps sending a
      // trickle of bytes. This fires regardless of activity.
      signal: AbortSignal.timeout(HARD_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "gzip, deflate, br",
      },
      maxRedirects: 5,
      maxContentLength: MAX_HTML_BYTES,
      maxBodyLength: MAX_HTML_BYTES,
      responseType: "text",
      validateStatus: (status) => status >= 200 && status < 400,
      httpAgent,
      httpsAgent,
    });
  } catch (error) {
    if (error?.name === "CanceledError" || error?.code === "ERR_CANCELED") {
      throw new Error(`Exceeded hard timeout of ${HARD_TIMEOUT_MS}ms (slow or stalled response)`);
    }
    throw error;
  }

  const contentType = String(response.headers["content-type"] || "").toLowerCase();
  if (
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    const error = new Error(`Unsupported content type: ${contentType || "unknown"}`);
    error.permanent = true;
    throw error;
  }

  // Labelled HTML is not proof of HTML: a body of NUL bytes or binary is a
  // trap or a mistake, and either way not a page to archive.
  const notText = sniffNotText(response.data);
  if (notText) {
    const error = new Error(`Not a page: served as ${contentType} but ${notText}`);
    error.permanent = true;
    error.exyra = [{ category: "content-mismatch", detail: error.message }];
    throw error;
  }

  return response.data;
}


function extractKeywords(text, limit = TOP_KEYWORDS) {
  const counts = new Map();
  const tokens = text.toLowerCase().match(/[a-z0-9]{3,}/g) || [];

  for (const token of tokens) {
    if (STOPWORDS.has(token)) {
      continue;
    }
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .slice(0, limit)
    .map(([word]) => word);
}

function summarize(text, sentenceCount = 3) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.split(/\s+/).filter(Boolean).length >= 6);

  if (sentences.length === 0) {
    return text.slice(0, 240).trim() || "No summary available.";
  }

  return sentences.slice(0, sentenceCount).join(" ");
}

// -------------------------------------------------------------------- runtime

function parseArgs(argv) {
  const options = { once: false, maxPages: 0, seeds: [], rebuildFts: false };

  for (const arg of argv) {
    if (arg === "--once") {
      options.once = true;
    } else if (arg === "--rebuild-fts") {
      options.rebuildFts = true;
    } else if (arg.startsWith("--max-pages=")) {
      options.maxPages = Math.max(0, Number(arg.split("=")[1]) || 0);
    } else if (!arg.startsWith("--")) {
      options.seeds.push(arg);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log(`\n${QUEST_NAME}`);
  console.log(`${QUEST_TAGLINE}\n`);

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const store = new QuestSqliteStore({
    dbPath: SQLITE_DB_PATH,
    compressContent: COMPRESS_CONTENT,
    storeHtml: STORE_HTML,
    maxStoredHtmlBytes: MAX_STORED_HTML_BYTES,
  });

  log(`Database: ${SQLITE_DB_PATH} (driver: ${store.driverName})`);
  log(
    `Rate: ${PAGES_PER_MINUTE} pages/min, concurrency ${CONCURRENCY}, per-host delay ${PER_HOST_DELAY_MS}ms`,
  );
  log(
    `Content compression: ${COMPRESS_CONTENT ? "on (gzip)" : "off"}; FTS5: ${store.ftsAvailable ? "available" : `unavailable (${store.ftsError})`}`,
  );
  log(
    `HTML archive: ${STORE_HTML ? `on (max ${formatBytes(MAX_STORED_HTML_BYTES)}/page)` : "OFF - extraction changes will need a re-crawl"}; extractor v${EXTRACTOR_VERSION}`,
  );

  // Image index (xImages) and discovered feeds (xWire), each in its own file.
  let media = null;
  if (INDEX_MEDIA) {
    const paths = dataPaths();
    try {
      media = { images: new ImageStore({ dbPath: paths.images }), feeds: new FeedStore({ dbPath: paths.feeds }) };
      log(`Media index: images -> ${paths.images}, feeds -> ${paths.feeds}`);
    } catch (error) {
      log(`Media index unavailable (${error?.message}); crawling without it.`);
    }
  } else {
    log("Media index: off (QUEST_INDEX_MEDIA=false)");
  }

  const exyraPaths = dataPaths();
  try {
    exyraStore = new ExyraStore({ dbPath: exyraPaths.exyra });
    log(`Exyra suspects: ${exyraPaths.exyra}, exported to ${EXYRA_EXPORT_BASE}.json/.txt every ${Math.round(EXYRA_EXPORT_EVERY_MS / 60000)} min`);
  } catch (error) {
    log(`Exyra unavailable (${error?.message}); crawling without it.`);
  }
  log(
    `Networking: ${FORCE_IPV4 ? "IPv4 forced" : "default (dual-stack)"}; ` +
      `threadpool ${process.env.UV_THREADPOOL_SIZE}; robots.txt hard cap ${ROBOTS_HARD_TIMEOUT_MS}ms, ` +
      `page hard cap ${HARD_TIMEOUT_MS}ms`,
  );
  if (!FORCE_IPV4) {
    log(
      "  If most fetches are timing out regardless of target host, that usually means broken IPv6 " +
        "routing on this machine, not that the sites are down. Try QUEST_FORCE_IPV4=true.",
    );
  }

  const rearchiveBacklog = store.countNeedingRearchive(EXTRACTOR_VERSION);
  if (rearchiveBacklog > 0) {
    const archived = store.getRawPageCount();
    log(
      `Re-archive backlog: ${rearchiveBacklog} of ${archived} page(s) need refetching ` +
        `(stale extractor or missing HTML). Run "node maintain.js --rearchive" to make them due now.`,
    );
  }

  if (options.rebuildFts) {
    log("Rebuilding FTS index...");
    log(store.rebuildFtsIndex() ? "FTS index rebuilt." : "FTS unavailable; skipped.");
  }

  const recovered = store.releaseActiveClaims();
  if (recovered > 0) {
    log(`Recovered ${recovered} URL(s) left in-flight by a previous run.`);
  }

  const blacklist = readBlacklistFromDisk();
  store.syncBlacklist(blacklist.config);
  const blacklistMatcher = createBlacklistMatcher(blacklist.config);
  log(`Blacklist loaded from ${blacklist.source}.`);

  // Seeds only matter when they are new; existing rows keep their schedule.
  const seedUrls = (options.seeds.length > 0 ? options.seeds : DEFAULT_URLS)
    .map((url) => canonicalUrl(url))
    .filter(Boolean)
    .filter((url) => !isBlacklisted(url, blacklistMatcher));

  if (seedUrls.length > 0) {
    const added = store.addDiscovered(
      seedUrls.map((url) => ({ url, host: siteOf(new URL(url).hostname), depth: 0 })),
    );
    log(`Seeds: ${seedUrls.length} supplied, ${added} new.`);
  }

  let counts = store.refreshCachedCounts();
  log(
    `Cache: ${counts.stat_raw_pages} pages archived, ${counts.stat_search_index} indexed, ${counts.stat_queue_pending} queued.`,
  );

  // --- shutdown handling ----------------------------------------------------

  let stopping = false;
  let stopReason = null;
  const shouldStop = () => stopping;

  function requestStop(reason) {
    if (stopping) {
      return;
    }
    stopping = true;
    stopReason = reason;
    log(`Stopping: ${reason}`);
    store.setMeta("crawler_state", "stopping");
    store.setMeta("crawler_stop_reason", reason);
  }

  // First Ctrl-C: finish in-flight pages and shut down cleanly. Second: stop
  // now. The queue is crash-safe -- claims left 'active' are released on the
  // next start -- so forcing costs at most the pages that were mid-fetch.
  const signalHandler = (signal) => {
    if (!stopping) {
      requestStop(`signal-${signal}`);
      log("Finishing in-flight pages. Press Ctrl-C again to stop immediately.");
      return;
    }
    log("Stopping immediately.");
    try {
      store.releaseActiveClaims();
      store.setMetaBatch({ crawler_state: "idle", crawler_stop_reason: `forced-${signal}` });
      store.close();
      media?.images.close();
      media?.feeds.close();
      exyraStore?.close();
    } catch {
      // Exiting regardless; the next start cleans up.
    }
    process.exit(130);
  };
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  // --- shared crawl state ---------------------------------------------------

  const limiter = new SteadyRate(PAGES_PER_MINUTE);
  const startedAt = Date.now();
  let processedCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let discoveredCount = 0;
  // Stale pages (old extractor or no HTML) brought up to date this run,
  // whatever triggered the refetch. Drives the re-archive ETA. It used to
  // count only stale pages that were otherwise still fresh -- a sliver of
  // the real rate, which turned an ~11 day backlog into "~1474 days".
  let rearchivedCount = 0;
  let htmlSkippedCount = 0;
  let imagesIndexed = 0;
  let feedsFound = 0;
  let mediaErrors = 0;
  // Where each attempt's time actually goes, reset every status line. This is
  // what turns "it's slow" into "robots.txt is eating 40s per attempt".
  const phase = { attempts: 0, robotsMs: 0, waitMs: 0, fetchMs: 0, storeMs: 0, claims: 0, claimMs: 0, claimMaxMs: 0 };
  const fetchFailByKind = new Map();
  let unreachableHostsParked = 0;
  let rearchiveRemaining = rearchiveBacklog;
  let lastStatusAt = startedAt;
  let lastStatusProcessed = 0;
  let queuePending = counts.stat_queue_pending;

  store.setMetaBatch({
    crawler_state: "active",
    crawler_started_at: startedAt,
    crawler_last_heartbeat: startedAt,
    crawler_pid: process.pid,
    crawler_pages_per_minute: PAGES_PER_MINUTE,
    crawler_stop_reason: "",
  });

  // --- periodic housekeeping ------------------------------------------------

  const timers = [];

  timers.push(
    setInterval(() => {
      store.setMetaBatch({
        crawler_state: stopping ? "stopping" : "active",
        crawler_last_heartbeat: Date.now(),
        crawler_processed_total: processedCount,
      });
    }, HEARTBEAT_EVERY_MS),
  );

  // Every database call is synchronous: while one runs on this thread,
  // nothing else can -- no fetch completes, no timer fires, not even Ctrl-C.
  // Counting a 2M-row queue on a box that can't cache it took 11s a minute.
  // So the periodic jobs run on a background thread with its own connection
  // (see background.js), and only report here if they were slow.
  const background = startBackground({ dbPath: SQLITE_DB_PATH, fallbackStore: store, onLog: log });

  function housekeeping(label, job, arg, apply) {
    background
      .run(job, arg)
      .then((reply) => {
        if (!reply || stopping) return;
        apply(reply.result);
        if (reply.ms >= SLOW_JOB_MS) {
          log(
            reply.inline
              ? `slow: ${label} took ${reply.ms}ms, and everything else waited while it ran`
              : `background: ${label} took ${reply.ms}ms (crawling carried on meanwhile)`,
          );
        }
      })
      .catch((error) => log(`${label} failed: ${error?.message}`));
  }

  timers.push(
    setInterval(() => {
      housekeeping("count refresh", "counts", null, (result) => {
        counts = result;
        queuePending = result.stat_queue_pending;
      });
    }, COUNTS_EVERY_MS),
  );

  // The exact re-archive count is recomputed rarely; in between, the figure
  // is kept current by decrementing it as stale pages are refetched.
  timers.push(
    setInterval(() => {
      if (rearchiveRemaining <= 0) return;
      housekeeping("re-archive recount", "rearchive", EXTRACTOR_VERSION, (result) => {
        rearchiveRemaining = result;
      });
    }, REARCHIVE_RECOUNT_MS),
  );

  // PASSIVE, never TRUNCATE, while running. TRUNCATE waits for every open
  // reader -- the PHP pages, stats.js, maintain.js -- and with busy_timeout
  // at 10s it froze the whole crawler for up to 10s each time a web visitor
  // happened to be mid-query. PASSIVE copies what it can and returns at once;
  // journal_size_limit keeps the file bounded. TRUNCATE still runs at exit.
  timers.push(
    setInterval(() => {
      housekeeping("WAL checkpoint", "checkpoint", null, () => {});
    }, CHECKPOINT_EVERY_MS),
  );

  if (exyraStore) {
    timers.push(setInterval(() => {
      try {
        exyraStore.refreshWithheld();
      } catch {
        // Keep the list we have.
      }
    }, 5 * 60 * 1000));
  }

  // Exyra's export files: soon after start, then periodically. Off the main
  // thread -- the JSON can be large.
  if (exyraStore) {
    const exportExyraNow = () =>
      housekeeping("exyra export", "exyra-export", { dbPath: dataPaths().exyra, basePath: EXYRA_EXPORT_BASE }, (result) => {
        log(`exyra: exported ${fmtCount(result.count)} suspect(s) to ${path.basename(result.txtPath)} and ${path.basename(result.jsonPath)}`);
      });
    const first = setTimeout(exportExyraNow, Math.min(60000, EXYRA_EXPORT_EVERY_MS));
    first.unref?.();
    timers.push(setInterval(exportExyraNow, EXYRA_EXPORT_EVERY_MS));
  }

  // How long the event loop has been unable to run anything. This is the
  // number that would have shown the freeze directly: fetches "timing out"
  // after 12s against hosts that answer in 100ms means the loop was blocked,
  // not the network.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  timers.push(
    setInterval(() => {
      const now = Date.now();
      const elapsedMin = (now - lastStatusAt) / 60000;
      const rate = elapsedMin > 0 ? (processedCount - lastStatusProcessed) / elapsedMin : 0;
      const rss = process.memoryUsage().rss;

      log(
        `status: ${processedCount} pages (${rate.toFixed(1)}/min), ${failureCount} failed, ` +
          `${skippedCount} skipped, ${discoveredCount} discovered, queue ${queuePending}, ` +
          `rss ${formatBytes(rss)} (js heap ${formatBytes(process.memoryUsage().heapUsed)}, robots cache ${robotsCache.size} sites, ${fmtCount(robots.ruleCount())} rules)` +
            `${memoryPaused ? " (PAUSED: memory)" : ""}`,
      );

      // Re-archive progress, only while there is a backlog to report on.
      if (rearchiveRemaining > 0) {
        const archived = Math.max(counts.stat_raw_pages || 0, 1);
        const done = archived - rearchiveRemaining;
        const perMin = elapsedMin > 0 ? rearchivedCount / ((now - startedAt) / 60000) : 0;
        const etaMin = perMin > 0 ? rearchiveRemaining / perMin : null;
        let etaText = "";
        if (etaMin && Number.isFinite(etaMin)) {
          if (etaMin < 120) etaText = `~${etaMin.toFixed(0)} min`;
          else if (etaMin < 1440 * 30) etaText = `~${(etaMin / 60).toFixed(1)} h`;
          else etaText = `~${(etaMin / 1440).toFixed(0)} days`;
          // An ETA past a month isn't a schedule, it's a symptom: at any sane
          // rate this backlog clears in days. Say so instead of just printing
          // a multi-year number that reads as either a bug or a life sentence.
          if (etaMin >= 1440 * 30) {
            etaText += " at current rate -- this is abnormally slow, see the failure rate and Networking line above";
          } else {
            etaText += " at current rate";
          }
        }
        log(
          `  re-archive: ${fmtCount(done)}/${fmtCount(archived)} pages current ` +
            `(${((done / archived) * 100).toFixed(1)}%), ${fmtCount(rearchiveRemaining)} to go` +
            (etaText ? `, ${etaText}` : ""),
        );
      }
      if (htmlSkippedCount > 0) {
        log(`  ${htmlSkippedCount} page(s) too large to archive HTML for (text still stored)`);
      }
      if (media) {
        log(
          `  media: ${fmtCount(imagesIndexed)} image(s) indexed, ${fmtCount(feedsFound)} new feed(s) found this run` +
            (mediaErrors > 0 ? `, ${mediaErrors} error(s)` : ""),
        );
      }
      if (exyraStore) {
        log(`  exyra: ${fmtCount(exyraNewSuspects)} new suspect(s) from ${fmtCount(exyraSignals)} signal(s) this run; ${exyraStore.withheld.size} withheld from the crawl`);
      }

      // Time breakdown since the last status line. If an attempt averages far
      // more than the timeouts allow, the missing time is in the timings here.
      if (phase.attempts > 0) {
        const avg = (ms) => {
          const s = ms / phase.attempts / 1000;
          return s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(1)}s`;
        };
        log(
          `  per attempt (${phase.attempts} this interval): robots.txt ${avg(phase.robotsMs)}, ` +
            `rate wait ${avg(phase.waitMs)}, fetch ${avg(phase.fetchMs)}, store ${avg(phase.storeMs)}`,
        );
      }
      if (phase.claims > 0) {
        log(`  claims: ${phase.claims}, avg ${(phase.claimMs / phase.claims).toFixed(1)}ms, slowest ${phase.claimMaxMs}ms`);
      }
      {
        const longest = loopDelay.max / 1e6;
        const p99 = loopDelay.percentile(99) / 1e6;
        const fmtMs = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
        log(
          `  event loop: longest stall ${fmtMs(longest)}, p99 ${fmtMs(p99)}` +
            (longest >= SLOW_JOB_MS
              ? " -- nothing (fetches, timers, Ctrl-C) could run for that long; timeouts in that window are not real"
              : ""),
        );
        loopDelay.reset();
      }
      if (fetchFailByKind.size > 0) {
        const parts = [...fetchFailByKind.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([kind, count]) => `${kind} ${count}`);
        log(`  failures by layer this interval: ${parts.join(", ")}`);
      }
      if (unreachableHostsParked > 0) {
        log(`  ${unreachableHostsParked} site(s) parked for ${Math.round(ROBOTS_UNREACHABLE_TTL_MS / 60000)} min as refusing connections this interval`);
      }
      phase.attempts = 0;
      phase.robotsMs = 0;
      phase.waitMs = 0;
      phase.fetchMs = 0;
      phase.storeMs = 0;
      phase.claims = 0;
      phase.claimMs = 0;
      phase.claimMaxMs = 0;
      fetchFailByKind.clear();
      unreachableHostsParked = 0;

      lastStatusAt = now;
      lastStatusProcessed = processedCount;
    }, STATUS_EVERY_MS),
  );

  // A running total of robots.txt outcomes by layer, once a minute at most.
  // Unlike the per-interval line above this never resets, so a steady climb in
  // one bucket across unrelated hosts is easy to spot.
  timers.push(
    setInterval(() => {
      if (robotsUnreachableByKind.size === 0 || Date.now() - robotsUnreachableLoggedAt < 60000) {
        return;
      }
      robotsUnreachableLoggedAt = Date.now();
      const total = [...robotsUnreachableByKind.values()].reduce((a, b) => a + b, 0);
      const parts = [...robotsUnreachableByKind.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${kind} ${count}`);
      log(`  robots.txt unreachable so far: ${total} (${parts.join(", ")}) -- hosts skipped, not fetched`);
    }, STATUS_EVERY_MS),
  );

  // Real backpressure, not just a log line: PAUSE stops claiming new work and
  // lets in-flight fetches drain so V8 can catch up on GC without losing the
  // process's place in the schedule; STOP is the last resort so the process
  // exits on its own terms -- mid-checkpoint is a much better place to end up
  // than wherever the OS happens to kill it.
  let memoryPaused = false;
  timers.push(
    setInterval(() => {
      const rss = process.memoryUsage().rss;

      if (rss >= MEMORY_STOP_MB * 1024 * 1024) {
        requestStop(
          `memory-hard-limit rss=${formatBytes(rss)} threshold=${MEMORY_STOP_MB}MB`,
        );
        return;
      }

      if (rss >= MEMORY_PAUSE_MB * 1024 * 1024) {
        if (!memoryPaused) {
          memoryPaused = true;
          log(
            `pausing: rss ${formatBytes(rss)} is above the ${MEMORY_PAUSE_MB}MB pause threshold; ` +
              `letting in-flight work drain before claiming more`,
          );
        }
      } else if (memoryPaused) {
        memoryPaused = false;
        log(`resuming: rss ${formatBytes(rss)} back under the ${MEMORY_PAUSE_MB}MB pause threshold`);
      }
    }, MEMORY_CHECK_EVERY_MS),
  );

  timers.push(
    setInterval(
      () => {
        const cutoff = getUtcDayKey(Date.now() - 45 * 24 * 60 * 60 * 1000);
        store.pruneBudgetsBefore(cutoff);
      },
      60 * 60 * 1000,
    ),
  );

  for (const timer of timers) {
    timer.unref?.();
  }

  // --- per-page work --------------------------------------------------------

  const seedHosts = new Set(seedUrls.map((url) => new URL(url).hostname));

  function queueLinks(links, parentDepth, fromUrl) {
    // URL shape first, before the queue cap below can skip everything: a
    // link that looks like an endless generated space is reported to Exyra.
    // Being reported changes nothing about whether it is crawled -- only a
    // rating at or above the withhold line (exyra.js) does that.
    if (exyraStore) {
      for (const link of links) {
        const { signals } = detectUrl(link);
        if (signals.length > 0) noteExyra(link, signals, fromUrl);
      }
    }

    if (queuePending >= MAX_QUEUE_ROWS) {
      return 0;
    }
    if (MAX_DEPTH > 0 && parentDepth + 1 > MAX_DEPTH) {
      return 0;
    }

    const entries = [];
    const seen = new Set();

    for (const link of links) {
      const url = canonicalUrl(link);
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);

      if (hasSkippedExtension(url) || isBlacklisted(url, blacklistMatcher) || exyraStore?.isWithheld(url)) {
        continue;
      }

      const hostname = new URL(url).hostname;
      if (!FOLLOW_EXTERNAL_LINKS && !seedHosts.has(hostname)) {
        continue;
      }

      // Scheduled per site, not per hostname: see site.js.
      entries.push({ url, host: siteOf(hostname), depth: parentDepth + 1 });
    }

    return entries.length > 0 ? store.addDiscovered(entries) : 0;
  }

  async function processClaim(claim) {
    const { url, host, depth, attempts } = claim;

    // Rated at or above the withhold line by Exyra (a bomb, a tarpit, a hand
    // entry): not worth fetching. Below that line nothing is withheld.
    if (exyraStore?.isWithheld(url)) {
      store.setLastNote(url, "withheld: Exyra rating at or above the withhold line");
      store.setUrlState(url, "blocked");
      skippedCount += 1;
      return;
    }

    if (isBlacklisted(url, blacklistMatcher)) {
      store.setUrlState(url, "blocked");
      skippedCount += 1;
      return;
    }

    // Already fresh enough AND already archived the way we want it? Book the
    // next visit and move on without fetching. A page whose text came from an
    // older extractor, or whose HTML was never kept, is refetched even if it
    // is recent -- that is what makes a re-archive pass work.
    const pageState = store.getPageState(url);
    const isFresh =
      pageState.indexedAt > 0 && Date.now() - pageState.indexedAt < REINDEX_AFTER_MS;
    const isCurrent =
      pageState.extractorVersion >= EXTRACTOR_VERSION &&
      (!STORE_HTML || pageState.hasHtml);

    if (isFresh && isCurrent) {
      store.completeUrl(url, pageState.indexedAt + REINDEX_AFTER_MS);
      skippedCount += 1;
      return;
    }
    const dayKey = getUtcDayKey();
    if (store.getDomainCount(host, dayKey) >= DAILY_DOMAIN_BUDGET) {
      // Park the whole host rather than popping its URLs one at a time, and
      // hand this URL back -- it previously stayed 'active' until restart,
      // invisible to the scheduler.
      const midnight = getNextUtcMidnight();
      store.deferHost(host, midnight);
      store.unclaimUrl(url, midnight);
      skippedCount += 1;
      return;
    }

    phase.attempts += 1;

    const robotsStarted = Date.now();
    const robots = await checkRobots(url);
    phase.robotsMs += Date.now() - robotsStarted;

    if (robots.verdict === "disallowed") {
      store.setUrlState(url, "blocked");
      skippedCount += 1;
      return;
    }

    if (robots.verdict === "unreachable") {
      if (robots.fromCache) {
        // A sibling's request already found this hostname unreachable (this
        // worker either joined it in flight or read the cached verdict).
        // Nothing went over the network for this URL, so it is not an
        // attempt: hand it back for when the verdict expires, with its retry
        // budget intact. The rest of the site is unaffected.
        store.unclaimUrl(url, robots.retryAt);
        return;
      }

      // A hostname is checked once and cached, but the queue is scheduled by
      // site, which may span thousands of hostnames (every Tumblr blog). When
      // the failure says the *site* is refusing us -- connections reset or
      // stalled, rate limited, timed out: how an IP block looks -- park the
      // whole site until the verdict expires, instead of trying its next
      // hostname, and the next. A DNS, TLS or 5xx failure is about this one
      // hostname, so the site carries on.
      if (SITE_WIDE_FAILURES.has(robots.kind)) {
        store.deferHost(host, robots.retryAt);
        unreachableHostsParked += 1;
      }
      recordFailure(url, attempts, `robots.txt unreachable (${robots.kind}): ${robots.reason}`, {
        kind: robots.kind,
        retryAt: robots.retryAt,
      });
      return;
    }

    // Only real fetches consume a rate permit.
    const waitStarted = Date.now();
    const permitted = await limiter.acquire(shouldStop);
    phase.waitMs += Date.now() - waitStarted;
    if (!permitted) {
      // Shutting down before the fetch: not an attempt.
      store.unclaimUrl(url, Date.now());
      return;
    }

    const fetchStarted = Date.now();
    try {
      const html = await fetchHtml(url);
      phase.fetchMs += Date.now() - fetchStarted;

      const storeStarted = Date.now();
      const parsed = parsePage(html, url, MAX_LINKS_PER_PAGE);
      const content = parsed.text.slice(0, MAX_CONTENT_CHARS);
      const timestamp = Date.now();

      // HTML first: it is the source everything else is derived from, so if
      // anything below changes later it can be redone without another fetch.
      const htmlStored = store.saveRawHtml(url, html, timestamp);
      if (STORE_HTML && !htmlStored) {
        htmlSkippedCount += 1;
      }

      store.saveRawPage({
        url,
        title: parsed.title,
        content,
        extractorVersion: EXTRACTOR_VERSION,
        timestamp,
      });
      store.saveSearchIndex({
        url,
        title: parsed.title,
        summary: summarize(content),
        keywords: extractKeywords(content),
        timestamp,
      });

      store.incrementDomainCount(host, dayKey);
      store.completeUrl(url, timestamp + REINDEX_AFTER_MS);
      processedCount += 1;
      // Keep the re-archive countdown moving between the (now infrequent)
      // full recounts, without touching the database to do it.
      const wasStale = pageState.extractorVersion > 0 && !isCurrent;
      if (wasStale && (!STORE_HTML || htmlStored)) {
        rearchivedCount += 1;
        if (rearchiveRemaining > 0) rearchiveRemaining -= 1;
      }

      // Hidden links are queued too: they are only reported to Exyra, never
      // dropped. (Mobile menus and dialogs often hold pages linked nowhere else.)
      const added = queueLinks([...parsed.links, ...parsed.hiddenLinks], depth, url);
      discoveredCount += added;
      queuePending += added;
      if (parsed.truncated) {
        console.warn(`[QUEST] ${url} has more than ${MAX_LINKS_PER_PAGE} links; rest ignored.`);
        store.setLastNote(url, `link cap: page offered more than ${MAX_LINKS_PER_PAGE} links`);
      }
      // Separate databases, separate failure: the page is already saved, and
      // nothing here should ever cost it a retry.
      if (media) {
        try {
          imagesIndexed += media.images.savePage(url, parsed.title, parsed.images, timestamp);
          feedsFound += media.feeds.addDiscovered(parsed.feeds, url, timestamp);
        } catch (error) {
          mediaErrors += 1;
          if (mediaErrors <= 5) log(`media index failed for ${url}: ${error?.message}`);
        }
      }
      noteExyra(url, parsed.exyra);
      phase.storeMs += Date.now() - storeStarted;
    } catch (error) {
      phase.fetchMs += Date.now() - fetchStarted;
      // What actually came over the wire tells a bomb (2 MB inflated from
      // 2 KB) from a merely big page.
      const wireBytes = Number(error?.request?.socket?.bytesRead || 0);
      noteExyra(url, [...(error?.exyra || []), ...detectFetchError(url, error, { capBytes: MAX_HTML_BYTES, wireBytes })]);
      const oversized = /maxContentLength size of \d+ exceeded/.test(String(error?.message || ""));
      recordFailure(url, attempts, error?.message || "Unknown error", {
        kind: classifyNetworkError(error),
        // Same answer next time: too big, or not a page at all.
        permanent: error?.permanent === true || oversized || FINAL_HTTP_STATUSES.has(error?.response?.status),
      });
    }
  }

  /**
   * One place for "this attempt failed": note why, then either give up for
   * good or book a retry with backoff (never sooner than retryAt, if given).
   */
  function recordFailure(url, attempts, reason, { kind = "other", permanent = false, retryAt = 0 } = {}) {
    failureCount += 1;
    fetchFailByKind.set(kind, (fetchFailByKind.get(kind) || 0) + 1);
    store.setLastNote(url, reason);
    noteExyra(url, detectFromNote(url, reason));

    if (permanent || attempts >= MAX_ATTEMPTS) {
      store.setUrlState(url, "failed");
      console.warn(`[QUEST] Giving up on ${url}: ${reason}`);
      return;
    }

    const index = Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1);
    store.rescheduleUrl(url, Math.max(Date.now() + RETRY_BACKOFF_MS[index], retryAt));
    console.warn(`[QUEST] ${url} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${reason}`);
  }

  // --- workers --------------------------------------------------------------

  let busyWorkers = 0;
  let idleSince = 0;

  async function worker() {
    while (!stopping) {
      if (options.maxPages > 0 && processedCount >= options.maxPages) {
        requestStop(`max-pages-${options.maxPages}`);
        return;
      }

      if (memoryPaused) {
        // Distinct from "nothing claimable": don't touch idleSince here, so
        // --once keeps waiting out the pause instead of concluding the
        // frontier is drained just because memory is tight right now.
        await sleep(IDLE_POLL_MS);
        continue;
      }

      let claim = null;
      try {
        const claimStarted = Date.now();
        claim = store.claimNext(claimStarted, PER_HOST_DELAY_MS);
        // claimNext is synchronous: while it runs, nothing else does. If this
        // creeps up as the crawl grows, it's the next thing to optimise.
        const claimTook = Date.now() - claimStarted;
        phase.claims += 1;
        phase.claimMs += claimTook;
        if (claimTook > phase.claimMaxMs) phase.claimMaxMs = claimTook;
      } catch (error) {
        console.error(`[QUEST] Claim failed: ${error?.message}`);
        await sleep(IDLE_POLL_MS);
        continue;
      }

      if (!claim) {
        // Nothing claimable right now. That usually means hosts are cooling
        // down or everything is booked for a future re-crawl, not that the
        // frontier is empty.
        if (busyWorkers > 0) {
          idleSince = 0;
        } else if (idleSince === 0) {
          idleSince = Date.now();
        }

        if (options.once && busyWorkers === 0 && idleSince > 0) {
          if (Date.now() - idleSince >= DRAIN_GRACE_MS) {
            return;
          }
        }

        await sleep(queuePending === 0 ? EMPTY_QUEUE_SLEEP_MS : IDLE_POLL_MS);
        continue;
      }

      idleSince = 0;
      busyWorkers += 1;
      try {
        await processClaim(claim);
      } catch (error) {
        failureCount += 1;
        console.error(`[QUEST] Unexpected error on ${claim.url}: ${error?.message}`);
        try {
          store.rescheduleUrl(claim.url, Date.now() + RETRY_BACKOFF_MS[0]);
        } catch {
          // Nothing more we can do for this URL.
        }
      } finally {
        busyWorkers -= 1;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // --- shutdown -------------------------------------------------------------

  for (const timer of timers) {
    clearInterval(timer);
  }
  await background.close();
  media?.images.close();
  media?.feeds.close();
  exyraStore?.close();

  const released = store.releaseActiveClaims();
  const finalCounts = store.refreshCachedCounts();
  store.setMetaBatch({
    crawler_state: "idle",
    crawler_last_heartbeat: Date.now(),
    crawler_stop_reason: stopReason || "completed",
    crawler_processed_total: processedCount,
  });

  const elapsedMin = (Date.now() - startedAt) / 60000;
  log("");
  log("Run complete.");
  log(
    `Processed ${processedCount} page(s) in ${elapsedMin.toFixed(1)} min ` +
      `(${elapsedMin > 0 ? (processedCount / elapsedMin).toFixed(1) : "0"}/min).`,
  );
  log(`Failures ${failureCount}, skipped ${skippedCount}, newly discovered ${discoveredCount}.`);
  log(
    `Cache now: ${finalCounts.stat_raw_pages} pages archived, ` +
      `${finalCounts.stat_search_index} indexed, ${finalCounts.stat_queue_pending} queued.`,
  );
  if (released > 0) {
    log(`Released ${released} in-flight claim(s).`);
  }

  process.off("SIGINT", signalHandler);
  process.off("SIGTERM", signalHandler);
  store.close();

  // 130 = stopped on purpose (Ctrl-C / kill), which run.sh takes as "stay
  // stopped". Anything else -- the memory brake, a crash -- it restarts.
  if (stopReason && stopReason.startsWith("signal-")) {
    process.exitCode = 130;
  }
}

main().catch((error) => {
  console.error(`[QUEST] Fatal error: ${error?.stack || error?.message || String(error)}`);
  process.exitCode = 1;
});
