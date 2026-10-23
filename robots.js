"use strict";

/**
 * robots.txt per RFC 9309, plus the network-error classification it relies
 * on. Shared by the crawler (quest.js) and the feed reader (feeds.js), so
 * both obey the same rules and fail the same way.
 *
 *   2xx/3xx -> parse the rules                             ("ok")
 *   4xx     -> unavailable: the crawler MAY fetch anything ("unavailable")
 *   5xx, 429, or a network error -> unreachable: MUST assume complete
 *              disallow                                    ("unreachable")
 */

const axios = require("axios");

/**
 * Put a network failure into a bucket that says which layer broke. The bucket
 * is what makes a failure log diagnostic: "dns" and "connect" mean the request
 * never reached the host, "stall" means it connected and then heard nothing,
 * and those point at very different causes.
 */
function classifyNetworkError(error) {
  const status = error?.response?.status;
  if (status === 429) return "http429";
  if (status >= 500) return "http5xx";
  if (status >= 400) return "http4xx";

  const code = String(error?.code || "");
  const message = String(error?.message || "");
  if (code === "ERR_CANCELED" || error?.name === "CanceledError") return "hard-timeout";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_FAIL") return "dns";
  if (code === "ETIMEDOUT" || code === "ENETUNREACH" || code === "EHOSTUNREACH") return "connect";
  if (code === "ECONNREFUSED") return "refused";
  // axios's idle timer, which Node only arms after the connection is up: the
  // host accepted the connection and then sent nothing.
  if (code === "ECONNABORTED" || /timeout of \d+ms exceeded/.test(message)) return "stall";
  if (code === "ECONNRESET" || code === "EPIPE" || /socket hang up/i.test(message)) return "reset";
  if (/^(CERT_|ERR_TLS|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED)/.test(code) || code === "EPROTO") return "tls";
  return "other";
}

// Escapes `*` too: compileRule then turns each escaped `\*` into `.*`. With
// `*` left raw, robots.txt wildcards never became wildcards -- `/*.pdf$`
// matched only "//.pdf", so wildcard Disallow rules were silently ignored --
// and `/**` was an invalid regex that made the whole host unreachable.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A rule as the cheapest thing that can match it. Most rules are plain path
 * prefixes ("/admin/"), kept as a string and checked with startsWith; only
 * rules using * or $ get a compiled RegExp. A RegExp per rule cost ~240
 * bytes, and some sites' robots.txt run to tens of thousands of rules -- a
 * few hundred of those in the cache were most of the crawler's memory.
 * `length` is the rule as written, which decides precedence (longest wins).
 */
function compileRule(type, rulePath) {
  const length = rulePath.length;
  let rule = rulePath.trim();
  if (!rule.startsWith("/")) {
    rule = `/${rule}`;
  }
  const hasEndAnchor = rule.endsWith("$");
  if (!rule.includes("*") && !hasEndAnchor) {
    return { type, length, prefix: rule };
  }
  if (hasEndAnchor) {
    rule = rule.slice(0, -1);
  }
  const withWildcards = escapeRegex(rule).replace(/\\\*/g, ".*");
  return { type, length, regex: new RegExp(hasEndAnchor ? `^${withWildcards}$` : `^${withWildcards}`) };
}

function parseRobotsTxt(robotsTxt) {
  const rules = [];
  let appliesToUs = false;

  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (key === "user-agent") {
      const ua = value.toLowerCase();
      appliesToUs = ua === "*" || ua === "quest" || ua === "quest-demo";
      continue;
    }

    if (!appliesToUs) {
      continue;
    }

    if (key === "allow" || key === "disallow") {
      if (key === "disallow" && value === "") {
        continue;
      }
      rules.push(compileRule(key, value));
    }
  }

  return rules;
}

function isPathAllowedByRules(pathname, rules) {
  let winner = null;

  for (const rule of rules) {
    if (rule.regex ? rule.regex.test(pathname) : pathname.startsWith(rule.prefix)) {
      const length = rule.length;
      if (!winner || length > winner.length) {
        winner = { type: rule.type, length };
      } else if (length === winner.length && rule.type === "allow") {
        winner = { type: rule.type, length };
      }
    }
  }

  return winner ? winner.type === "allow" : true;
}

/**
 * Read at most `limit` bytes of a response body, then hang up. When the body
 * is cut short, the last (partial) line is dropped: half of
 * "Disallow: /private" is "Disallow: /", which would block the whole site.
 */
async function readCapped(stream, limit) {
  return (await readCappedInfo(stream, limit)).text;
}

async function readCappedInfo(stream, limit) {
  const chunks = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    const room = limit - size;
    if (chunk.length >= room) {
      chunks.push(chunk.subarray(0, room));
      truncated = true;
      break; // leaving the loop destroys the stream
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  let text = Buffer.concat(chunks).toString("utf8");
  if (truncated) {
    text = text.slice(0, text.lastIndexOf("\n") + 1);
  }
  return { text, truncated };
}

/**
 * A robots.txt checker with its own cache. One per process.
 *
 * check(url) answers "allowed", "disallowed", or "unreachable" -- the third
 * is distinct because it is about the network path right now, not the site's
 * policy, so the URL deserves a retry later rather than being blocked.
 */
function createRobotsChecker({
  userAgent,
  httpAgent,
  httpsAgent,
  timeoutMs = 6000,
  hardTimeoutMs = 10000,
  cacheTtlMs = 24 * 60 * 60 * 1000,
  unreachableTtlMs = 60 * 60 * 1000,
  cacheMax = 5000,
  // Total rules across the cache, so a run of huge robots.txt files can't
  // take the memory that 5000 ordinary ones would.
  cacheMaxRules = 250000,
  // RFC 9309 requires parsing at least 500 KiB.
  maxBytes = 512 * 1024,
  // Called with (origin, text, { truncated }) for every robots.txt read --
  // how Exyra sees bait paths and anomalies without a second request.
  onFetched = null,
}) {
  const cache = new Map();
  const inFlight = new Map();
  let cachedRules = 0;
  // Outcomes by layer, so a systemic network problem shows up in the log
  // instead of silently degrading into "allow everything".
  const unreachableByKind = new Map();

  function remember(origin, entry) {
    const previous = cache.get(origin);
    if (previous) {
      cachedRules -= previous.rules.length;
      cache.delete(origin);
    }
    // Oldest first (a Map keeps insertion order), until both limits hold.
    while (cache.size > 0 && (cache.size >= cacheMax || cachedRules + entry.rules.length > cacheMaxRules)) {
      const [oldestKey, oldest] = cache.entries().next().value;
      cachedRules -= oldest.rules.length;
      cache.delete(oldestKey);
    }
    cache.set(origin, entry);
    cachedRules += entry.rules.length;
  }

  async function fetchRobots(origin) {
    let entry;
    try {
      const response = await axios.get(`${origin}/robots.txt`, {
        timeout: timeoutMs,
        signal: AbortSignal.timeout(hardTimeoutMs),
        headers: { "User-Agent": userAgent, Accept: "text/plain,text/*" },
        responseType: "stream",
        validateStatus: (status) => status >= 200 && status < 400,
        httpAgent,
        httpsAgent,
      });
      // An oversized file (or a robots.txt that redirects to a big HTML page)
      // used to count as "unreachable", which means disallow-all.
      const { text, truncated } = await readCappedInfo(response.data, maxBytes);
      if (onFetched) {
        try {
          onFetched(origin, text, { truncated });
        } catch {
          // An observer must never break robots.txt handling.
        }
      }
      entry = { status: "ok", rules: parseRobotsTxt(text), expiresAt: Date.now() + cacheTtlMs };
    } catch (error) {
      const kind = classifyNetworkError(error);
      if (kind === "http4xx") {
        entry = { status: "unavailable", rules: [], expiresAt: Date.now() + cacheTtlMs };
      } else {
        // "refused" lands here too: nothing is listening, so the page fetch
        // would fail identically -- no point attempting it.
        entry = {
          status: "unreachable",
          rules: [],
          kind,
          reason:
            kind === "hard-timeout"
              ? `no complete answer within ${hardTimeoutMs}ms`
              : String(error?.message || kind).slice(0, 160),
          expiresAt: Date.now() + unreachableTtlMs,
        };
        unreachableByKind.set(kind, (unreachableByKind.get(kind) || 0) + 1);
      }
    }

    remember(origin, entry);
    return entry;
  }

  async function getRobots(origin) {
    const cached = cache.get(origin);
    if (cached && Date.now() < cached.expiresAt) {
      return { ...cached, fromCache: true };
    }

    // One fetch per host at a time. Without this, workers that claim sibling
    // URLs while the first robots.txt request is still in flight each miss
    // the cache, each fetch it again, and each get charged a failed attempt
    // for the same outage. Joiners share the result and are reported as
    // fromCache, because they made no request of their own.
    const pending = inFlight.get(origin);
    if (pending) {
      return { ...(await pending), fromCache: true };
    }

    const request = fetchRobots(origin);
    inFlight.set(origin, request);
    try {
      return { ...(await request), fromCache: false };
    } finally {
      inFlight.delete(origin);
    }
  }

  async function check(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { verdict: "disallowed" };
    }
    const robots = await getRobots(parsed.origin);
    if (robots.status === "unreachable") {
      return {
        verdict: "unreachable",
        kind: robots.kind,
        reason: robots.reason,
        fromCache: robots.fromCache,
        retryAt: robots.expiresAt,
      };
    }
    return {
      verdict: isPathAllowedByRules(parsed.pathname || "/", robots.rules) ? "allowed" : "disallowed",
    };
  }

  return { check, getRobots, cache, unreachableByKind, ruleCount: () => cachedRules };
}

module.exports = {
  classifyNetworkError,
  createRobotsChecker,
  isPathAllowedByRules,
  parseRobotsTxt,
  readCapped,
};
