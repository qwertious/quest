"use strict";

/**
 * Exyra: URLs and sites worth scrutiny testing -- crawler traps, tarpits,
 * decompression bombs, prompt-injection bait, bot walls, anything that
 * behaves unlike an ordinary web page.
 *
 * The threshold is deliberately low. Being listed is not a verdict: it
 * records the evidence and queues the URL for closer, sandboxed testing.
 * Every suspect carries the signals that put it there, and a score (the sum
 * of its distinct categories' weights) so the strongest come first.
 *
 *   detectors   pure functions: URL shape, page content, robots.txt, fetch
 *               failures, failure notes already in the crawl queue
 *   ExyraStore  data/exyra.sqlite, written by the crawler, the feed reader
 *               and maintain.js
 *   exportExyra exyra.json + exyra.txt, for the Exyra project
 */

const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { QuestDatabase } = require("./db");
const { siteOf } = require("./site");
const { canonicalUrl } = require("./urls");

// ------------------------------------------------------------- categories

const CATEGORIES = {
  "decompression-bomb": [5, "Inflates far beyond what it sends (sustained ratio of 100:1 or more) -- a gzip/deflate bomb."],
  "manual": [5, "Added by hand, with the evidence in the note."],
  "known-tarpit-software": [4, "Runs anti-crawler tarpit software (Nepenthes, Iocaine), or is a decoy page from Cloudflare's AI Labyrinth."],
  "hidden-prompt-injection": [4, "Text hidden from readers that addresses or instructs AI systems. Sometimes a benign hint for AI agents (some docs sites do this)."],
  "hidden-text": [3, "Hidden text stuffed with spam keywords (casino, pills, loans, ...) -- SEO cloaking, usually a hacked site."],
  "content-mismatch": [3, "Says it is an HTML page but the body is binary, NUL bytes or compressed data."],
  "tarpit": [3, "Kept the connection open past the hard timeout without finishing -- a slow-drip response. Merely slow servers do this too."],
  "robots-bait": [3, "A path robots.txt forbids that is named like a trap (trap, honeypot, tarpit, ...). Many sites do this on purpose to catch bots that ignore the rules; the name alone proves little."],
  "oversized-response": [2, "Exceeded the size cap for its type."],
  "robots-anomaly": [2, "robots.txt that is HTML, binary, or over 512 KB."],
  "link-flood": [2, "Far more links than readable text, or over the per-page link cap -- a link farm or generated maze."],
  "redirect-loop": [2, "Redirects more times than any page needs."],
  "hidden-link-target": [1, "Reached through a link hidden from readers. Mostly ordinary interface (menus, dialogs); only meaningful alongside other evidence."],
  "hidden-links-planted": [1, "A page carrying links hidden from readers and not offered anywhere visible."],
  "prompt-injection": [1, "Visible text addressed to AI readers (\"AI agents must ...\"). Usually documentation or an article about AI, not an attack."],
  "spider-trap-url": [1, "URL shaped like an endless space: repeating path segments, extreme depth or length, far-future calendar dates."],
  "bot-wall": [1, "Answers crawlers with a challenge page (Cloudflare, DataDome, PerimeterX, Akamai, captcha)."],
  "refuses-crawler": [1, "Resets connections, rate-limits (429) or uses non-standard refusals (418, 999) toward this crawler."],
  "stall": [1, "Accepted the connection, then went silent."],
  "ai-blocking": [1, "robots.txt singles out AI crawlers by name, or the page serves Cloudflare AI Labyrinth decoy links."],
  "ai-opt-out": [1, "Declares it does not want AI training/input (Content-Signal)."],
};

const weightOf = (category) => (CATEGORIES[category] ? CATEGORIES[category][0] : 1);

/**
 * Roughly: if this were the only evidence, how likely is it that the URL is a
 * deliberate trap? Combined across a suspect's categories as
 * 1 - product(1 - p), so independent evidence adds up but never past 100%.
 * A heuristic rating for sorting and reading, not a calibrated probability.
 *
 * Deliberately modest: a single weak or name-based signal stays low. Ratings
 * reach 90% only for things that are conclusive on their own (a decompression
 * bomb, tarpit software, a hand-entered entry) or for several independent
 * signals together.
 */
const CONFIDENCE = {
  manual: 0.95,
  "decompression-bomb": 0.9,
  "known-tarpit-software": 0.9,
  "hidden-prompt-injection": 0.45,
  "hidden-text": 0.4,
  "robots-bait": 0.4,
  "content-mismatch": 0.4,
  tarpit: 0.35,
  "hidden-link-target": 0.2,
  "spider-trap-url": 0.2,
  "redirect-loop": 0.2,
  "link-flood": 0.15,
  "oversized-response": 0.15,
  "robots-anomaly": 0.15,
  "hidden-links-planted": 0.1,
  "prompt-injection": 0.1,
  "bot-wall": 0.05,
  "refuses-crawler": 0.05,
  stall: 0.05,
  "ai-blocking": 0.02,
  "ai-opt-out": 0.02,
};

/**
 * At or above this rating a URL is withheld from the crawl: not queued, and
 * blocked if it already was. Below it, being on the list never changes what
 * the crawler fetches or what the search index contains -- the list is for
 * scrutiny testing, not for exclusion. QUEST_EXYRA_WITHHOLD_PERCENT changes it.
 */
const WITHHOLD_AT = (() => {
  const percent = Number(process.env.QUEST_EXYRA_WITHHOLD_PERCENT);
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent / 100 : 0.9;
})();

/** Suspicion in [0, 1] from a set of categories. */
function suspicionOf(categories) {
  let clear = 1;
  for (const category of new Set(categories)) clear *= 1 - (CONFIDENCE[category] ?? 0.1);
  return 1 - clear;
}

// ------------------------------------------------------------ URL shape

/**
 * Spider-trap signals from the URL alone. `strong` marks the clear-cut cases
 * (a path repeating the same segments is an endless generated space). It is
 * for reporting: the crawler still queues these unless the rating reaches
 * WITHHOLD_AT, which a URL's shape alone never does.
 */
function detectUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { signals: [], strong: false };
  }
  const signals = [];
  let strong = false;
  const segments = url.pathname.split("/").filter(Boolean);

  // Measured decoded: percent-encoding triples the length of every non-Latin
  // URL, which made ordinary Thai or Cyrillic pages look like traps.
  let readable = rawUrl;
  try {
    readable = decodeURI(rawUrl);
  } catch {
    // keep the raw form
  }
  if (readable.length > 400) {
    signals.push({ category: "spider-trap-url", detail: `URL is ${readable.length} characters long` });
  }
  if (segments.length > 15) {
    signals.push({ category: "spider-trap-url", detail: `path is ${segments.length} segments deep` });
    strong = segments.length > 25;
  }
  // a/b/a/b/a/b or x/x/x: a block of 1-3 segments repeated 3+ times in a row.
  outer: for (let size = 1; size <= 3; size += 1) {
    for (let start = 0; start + size * 3 <= segments.length; start += 1) {
      const block = segments.slice(start, start + size).join("/");
      let repeats = 1;
      while (segments.slice(start + repeats * size, start + (repeats + 1) * size).join("/") === block) repeats += 1;
      if (repeats >= 3) {
        signals.push({ category: "spider-trap-url", detail: `path repeats "${block}" ${repeats} times` });
        strong = true;
        break outer;
      }
    }
  }
  // Calendars that page forever: a year far outside anything real.
  const year = [...url.searchParams.entries()].find(([k]) => /^(y|year|yr|cal_?year)$/i.test(k));
  const pathYear = url.pathname.match(/\/(\d{4})\/(0?[1-9]|1[0-2])(\/|$)/);
  const y = Number(year?.[1] ?? pathYear?.[1]);
  if (y && (y > new Date().getUTCFullYear() + 5 || y < 1900)) {
    signals.push({ category: "spider-trap-url", detail: `calendar year ${y}` });
    strong = true;
  }
  if ([...url.searchParams.keys()].length >= 12) {
    signals.push({ category: "spider-trap-url", detail: `${[...url.searchParams.keys()].length} query parameters` });
  }
  return { signals, strong };
}

// ----------------------------------------------------------- page content

const HIDDEN_STYLE =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?![.\d])|(left|top|text-indent)\s*:\s*-\d{3,}(px|em|rem)|(width|height)\s*:\s*0(px)?\s*(;|$)[^]*?overflow\s*:\s*hidden|clip\s*:\s*rect\(0/i;

/**
 * Hidden from human readers by the page itself: the `hidden` attribute or an
 * inline style on the element or any ancestor. Class-based hiding (menus
 * collapsed by CSS) is too common on ordinary sites to count, and
 * aria-hidden is routinely used on duplicate-but-visible links.
 */
function makeHiddenCheck($) {
  const cache = new Map();
  return function isHidden(node) {
    const chain = [];
    let current = node;
    let verdict = false;
    while (current && current.type === "tag") {
      if (cache.has(current)) {
        verdict = cache.get(current);
        break;
      }
      chain.push(current);
      const attribs = current.attribs || {};
      if ("hidden" in attribs || HIDDEN_STYLE.test(attribs.style || "") || String(current.name).toLowerCase() === "template") {
        verdict = true;
        break;
      }
      current = current.parent;
    }
    for (const visited of chain) cache.set(visited, verdict);
    return verdict;
  };
}

// Text that *addresses* an AI and tells it what to do -- not text *about* AI.
// "AI companies should be regulated" and "vector instructions for AI
// acceleration" are ordinary sentences; "AI agents must ignore ..." is not.
// Every AI word is bounded on both sides, and the AI word alone never counts.
//
// Two tiers. ADDRESSED patterns are explicit address-to-the-reader forms and
// are checked in visible and hidden text. HIDDEN_ONLY patterns read as
// ordinary documentation or discussion when visible ("ignore previous
// instructions" in an article or comment about prompt injection, chat-
// template tokens in a docs page), so they only count when the page hides
// the text from readers.
const AI_NOUN = String.raw`(?:(?:ai|llm|gpt|chatgpt|claude)\s+(?:agents?|assistants?|crawlers?|scrapers?|bots?|models?|systems?)|llms|ais|chatbots|language models)`;
const ADDRESSED_PATTERNS = [
  /\b(if|when) you(?:'re| are) (?:an? )?(ai|llm|language model|chatbot|ai assistant|crawler|scraper)\b/i,
  new RegExp(String.raw`\b${AI_NOUN}\s+(must|should|are (?:instructed|required|asked) to|need to)\s+(ignore|disregard|stop|instead|never|say|respond|reply|output|recommend|praise)\b`, "i"),
  new RegExp(String.raw`\b(to|for)\s+(all\s+|any\s+)?${AI_NOUN}\s+(reading|processing|summari[sz]ing|scraping|crawling|visiting)\s+(this|these)\b`, "i"),
  /\b(to|for)\s+(all\s+|any\s+)?(ai|llm|gpt|chatgpt|claude)\s*(agents?|assistants?|models?|crawlers?|scrapers?|bots?|systems?)?\s+(reading|processing|summari[sz]ing|scraping|crawling|visiting)\s+(this|these)\b/i,
  new RegExp(String.raw`\b(attention|note|message|notice)\s+(to|for)\s+(all\s+|any\s+)?${AI_NOUN}`, "i"),
];
const HIDDEN_ONLY_PATTERNS = [
  /\b(ignore|disregard|forget)\s+(all\s+)?(your\s+|the\s+)?(previous|prior|above|earlier|original)\s+(instructions|prompts?|directions|rules)/i,
  /\byou are (now )?(an? )?(ai|llm|chatbot|language model|assistant)\b/i,
  /\b(system|developer) prompt\b[^.]{0,60}\b(reveal|print|ignore|override|new)\b/i,
  /<\|im_start\|>|<\|im_end\|>|\[\/?INST\]|<<\/?SYS>>|<\|system\|>|<\|assistant\|>/,
  /\bnew instructions\s*:/i,
  /\b(do not|don't) (tell|inform|alert) the user\b/i,
];

function findInjection(text, { hidden = false } = {}) {
  for (const pattern of hidden ? [...ADDRESSED_PATTERNS, ...HIDDEN_ONLY_PATTERNS] : ADDRESSED_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const at = Math.max(0, match.index - 40);
      return text.slice(at, match.index + match[0].length + 60).replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

// Only the tools' own names, and only where a tool announces itself (the
// generator tag, HTML comments) -- not words that are also English
// ("quixotic", "spigot", "tarpit") and not articles that mention them.
const TARPIT_SOFTWARE = /\b(nepenthes|iocaine)\b/i;

// Hidden links that are ordinary page furniture: menus and dialogs shown by
// script on demand. Only hidden links *not* matching these, and not also
// linked visibly on the same page, look like bait.
const UI_PATH =
  /(log-?in|log-?out|sign-?(in|up|out)|register|account|my-?account|profile|cart|basket|checkout|wishlist|cookie|privacy|gdpr|consent|terms|search|subscribe|newsletter|share|print|contact|faq|help|support|lang(uage)?=|locale|wp-admin|wp-login|cdn-cgi\/l\/email-protection)/i;
// Cloudflare AI Labyrinth: hidden links into generated decoy pages.
const LABYRINTH_PATH = /\/cdn-cgi\/content\?id=/i;
// Hidden text stuffed with these is SEO cloaking, usually on a hacked site.
const SPAM_WORDS =
  /\b(casino|casinos|gambling|betting|sportsbook|slots?|poker|roulette|blackjack|viagra|cialis|levitra|kamagra|porn|xxx|escort|payday|replica (?:watches|bags)|essay writing|pills?|pharmacy|crypto casino|bet365|1xbet|gratis spins|free spins)\b/gi;

/**
 * Page-level signals. `links` are this page's visible links and
 * `hiddenLinks` the ones it hides from readers (extract.js).
 */
function detectPage($, pageUrl, { text = "", links = [], hiddenLinks = [], html = "", linkCapHit = false } = {}) {
  const signals = [];
  const isHidden = makeHiddenCheck($);
  const visible = new Set(links);

  // Cloudflare AI Labyrinth: a site that turns it on gets hidden links into
  // generated decoy pages. The decoys are the trap; the page carrying them is
  // an ordinary page on a site that opted in, and is only noted as such.
  const labyrinth = hiddenLinks.filter((u) => LABYRINTH_PATH.test(u));
  if (labyrinth.length > 0) {
    let origin = "";
    try {
      origin = new URL(pageUrl).origin;
    } catch {
      // leave empty
    }
    if (origin) {
      signals.push({ target: `${origin}/`, category: "ai-blocking", detail: `serves Cloudflare AI Labyrinth decoy links (e.g. on ${pageUrl})` });
    }
    // One suspect per site: the id in the query string is different every time.
    const decoyPages = new Set();
    for (const link of labyrinth) {
      try {
        decoyPages.add(`${new URL(link).origin}/cdn-cgi/content`);
      } catch {
        // skip malformed
      }
    }
    for (const target of decoyPages) {
      signals.push({ category: "known-tarpit-software", target, detail: `Cloudflare AI Labyrinth decoy link (e.g. ${labyrinth[0].slice(0, 90)}), hidden on ${pageUrl}` });
    }
  }
  const bait = hiddenLinks.filter((u) => {
    if (visible.has(u) || LABYRINTH_PATH.test(u)) return false;
    try {
      const url = new URL(u);
      return !UI_PATH.test(url.pathname + url.search);
    } catch {
      return false;
    }
  });
  if (bait.length > 0) {
    signals.push({ category: "hidden-links-planted", detail: `${bait.length} hidden link(s) not offered visibly, e.g. ${bait[0]}` });
    for (const target of bait.slice(0, 10)) {
      signals.push({ category: "hidden-link-target", target, detail: `hidden link on ${pageUrl}` });
    }
  }

  // Hidden text: injection in it, and spam stuffed into it. <noscript> is
  // fallback markup, not hidden content.
  let hiddenText = "";
  $("[hidden], [style]").each((_, el) => {
    if (hiddenText.length > 20000) return false;
    if (!isHidden(el) || isHidden(el.parent) || $(el).closest("noscript, script, style, template").length > 0) return;
    hiddenText += ` ${$(el).text()}`;
  });
  hiddenText = hiddenText.replace(/<[^>]{0,300}>/g, " ").replace(/\s+/g, " ").trim();
  const spam = new Set((hiddenText.match(SPAM_WORDS) || []).map((w) => w.toLowerCase()));
  if (spam.size >= 2) {
    signals.push({ category: "hidden-text", detail: `hidden spam (${[...spam].slice(0, 6).join(", ")}): "${hiddenText.slice(0, 120)}"` });
  }
  const hiddenInjection = hiddenText && findInjection(hiddenText, { hidden: true });
  if (hiddenInjection) {
    signals.push({ category: "hidden-prompt-injection", detail: `"${hiddenInjection}"` });
  } else {
    const injection = findInjection(text.slice(0, 200000));
    if (injection) signals.push({ category: "prompt-injection", detail: `"${injection}"` });
  }

  // Links far outnumbering the words around them.
  const words = (text.match(/\S+/g) || []).length;
  if (linkCapHit) {
    signals.push({ category: "link-flood", detail: "over the per-page link cap" });
  } else if (links.length >= 300 && words / links.length < 1.5) {
    signals.push({ category: "link-flood", detail: `${links.length} links for ${words} words` });
  }

  // Self-identified tarpit software, in the generator tag or HTML comments
  // (not the title or body: an article about these tools is not the tool).
  const generator = $('meta[name="generator"]').attr("content") || "";
  const comments = (String(html).slice(0, 200000).match(/<!--[\s\S]{0,300}?-->/g) || []).slice(0, 50).join(" ");
  const software = TARPIT_SOFTWARE.exec(`${generator} ${comments}`);
  if (software) signals.push({ category: "known-tarpit-software", detail: `names "${software[0]}" in its generator tag or comments` });

  return signals;
}

// ------------------------------------------------------------ robots.txt

// Path segments that name a trap outright. Whole segments only: "/trap/" is
// one; "/trapeze-classes/" and "/maze-runner/" are not. Words that are also
// ordinary English or brand names (maze, poison, labyrinth, blackhole) are
// left out: a site's own robots.txt is not evidence that its pages are traps.
const BAIT_SEGMENTS = new Set([
  "trap", "traps", "honeypot", "honeypots", "honey-pot", "honey-pots", "tarpit", "tarpits", "tar-pit",
  "spidertrap", "spider-trap", "spider-traps", "bottrap", "bot-trap", "bot-traps", "crawlertrap",
  "crawler-trap", "crawler-traps", "badbots", "bad-bots", "bad-bot", "aitrap", "ai-trap", "llmtrap",
  "llm-trap", "nepenthes", "iocaine", "donotcrawl", "do-not-crawl", "donotfollow", "do-not-follow",
  "donotenter", "do-not-enter",
]);

/** Does this robots.txt Disallow value name a trap? */
function isBaitRule(rule) {
  const path = String(rule || "").replace(/\$$/, "").replace(/\*+/g, "");
  return path.split("/").some((segment) => BAIT_SEGMENTS.has(segment.toLowerCase()));
}

const AI_AGENTS =
  /^(gptbot|chatgpt-user|oai-searchbot|claudebot|claude-web|claude-searchbot|anthropic-ai|ccbot|google-extended|perplexitybot|perplexity-user|bytespider|amazonbot|applebot-extended|meta-externalagent|facebookbot|cohere-ai|cohere-training-data-crawler|diffbot|omgili|omgilibot|timpibot|youbot|imagesiftbot|ai2bot|duckassistbot|mistralai-user|petalbot)$/i;

/** Signals from a robots.txt body. Suspect URLs are origin + path. */
function detectRobots(origin, text, { truncated = false } = {}) {
  const signals = [];
  const body = String(text || "");
  if (truncated) signals.push({ target: `${origin}/robots.txt`, category: "robots-anomaly", detail: "robots.txt over 512 KB" });
  if (/^\s*<(!doctype|html)/i.test(body)) {
    signals.push({ target: `${origin}/robots.txt`, category: "robots-anomaly", detail: "robots.txt is an HTML page" });
    return signals;
  }
  if (/\u0000/.test(body.slice(0, 4096))) {
    signals.push({ target: `${origin}/robots.txt`, category: "robots-anomaly", detail: "robots.txt contains NUL bytes" });
    return signals;
  }

  let agents = [];
  let lastWasAgent = false;
  const aiNamed = new Set();
  const bait = new Set();
  for (const raw of body.split(/\r?\n/).slice(0, 20000)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === "user-agent") {
      agents = lastWasAgent ? [...agents, value] : [value];
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "disallow" && value) {
      for (const agent of agents) if (AI_AGENTS.test(agent)) aiNamed.add(agent);
      if (isBaitRule(value)) bait.add(value);
    }
    if (key === "content-signal" && /ai-(train|input)\s*=\s*no/i.test(value)) {
      signals.push({ target: `${origin}/`, category: "ai-opt-out", detail: `Content-Signal: ${value}` });
    }
  }
  for (const rule of [...bait].slice(0, 20)) {
    // A URL a crawler could actually land on: wildcards and the end anchor
    // dropped, not cut at the first "*" -- "/*trap" cut there is just "/",
    // which made a site's home page the suspect.
    let path = rule.replace(/\$$/, "").replace(/\*+/g, "").replace(/\/{2,}/g, "/");
    if (!path.startsWith("/")) path = `/${path}`;
    if (path === "/") continue;
    signals.push({ target: `${origin}${path}`, category: "robots-bait", detail: `robots.txt: Disallow: ${rule}` });
  }
  if (aiNamed.size > 0) {
    signals.push({ target: `${origin}/`, category: "ai-blocking", detail: `disallows ${[...aiNamed].slice(0, 6).join(", ")}${aiNamed.size > 6 ? ` +${aiNamed.size - 6}` : ""}` });
  }
  return signals;
}

// ----------------------------------------------------------- fetch errors

const BOT_WALL_BODY =
  /challenge-platform|cf-chl|just a moment\.\.\.|attention required! \| cloudflare|px-captcha|perimeterx|datadome|captcha-delivery|pardon our interruption|access denied[\s\S]{0,200}reference #|ddos-guard|sucuri website firewall|are you a robot|verify you are human|g-recaptcha|h-captcha|turnstile/i;

/**
 * Signals from a failed fetch. Size failures report how much actually came
 * over the wire, so a bomb (2 MB from 2 KB) is told apart from a merely big
 * page (2 MB from 1.5 MB).
 */
function detectFetchError(url, error, { capBytes = 0, wireBytes = 0 } = {}) {
  const signals = [];
  const message = String(error?.message || "");
  const status = error?.response?.status;
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    // keep empty
  }

  if (/maxContentLength size of \d+ exceeded|too large|over the size cap/i.test(message)) {
    const ratio = wireBytes > 0 && capBytes > 0 ? capBytes / wireBytes : 0;
    if (ratio >= 100) {
      signals.push({ category: "decompression-bomb", detail: `${capBytes} bytes inflated from ~${wireBytes} on the wire (${Math.round(ratio)}:1)` });
    } else {
      signals.push({ category: "oversized-response", detail: `over ${capBytes} bytes${wireBytes ? ` (~${wireBytes} on the wire${ratio >= 10 ? `, ${Math.round(ratio)}:1` : ""})` : ""}` });
    }
  }
  if (/hard timeout/i.test(message)) signals.push({ category: "tarpit", detail: message.slice(0, 160) });
  else if (/timeout of \d+ms exceeded/.test(message)) signals.push({ category: "stall", detail: message.slice(0, 160) });
  if (/maximum number of redirects/i.test(message)) signals.push({ category: "redirect-loop", detail: message.slice(0, 160) });

  if (status) {
    const headers = error.response.headers || {};
    const body = typeof error.response.data === "string" ? error.response.data.slice(0, 20000) : "";
    if (headers["cf-mitigated"] === "challenge" || ((status === 403 || status === 503 || status === 429) && BOT_WALL_BODY.test(body))) {
      const vendor = (BOT_WALL_BODY.exec(body) || [headers["cf-mitigated"] ? "cloudflare challenge" : "challenge"])[0];
      signals.push({ target: `${origin}/`, category: "bot-wall", detail: `HTTP ${status}: ${vendor}` });
    } else if (status === 429 || status === 418 || status === 999 || status === 430) {
      signals.push({ target: `${origin}/`, category: "refuses-crawler", detail: `HTTP ${status}${headers["retry-after"] ? `, Retry-After ${headers["retry-after"]}` : ""}` });
    }
  }
  return signals;
}

/** Binary or NUL-filled content claiming to be text. Returns a reason or null. */
function sniffNotText(body) {
  const sample = String(body || "").slice(0, 8192);
  if (sample.length === 0) return null;
  let nul = 0;
  let control = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0) nul += 1;
    else if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  if (nul / sample.length > 0.01) return `${Math.round((nul / sample.length) * 100)}% NUL bytes`;
  if (control / sample.length > 0.05) return `${Math.round((control / sample.length) * 100)}% control characters (binary)`;
  if (/^\u001f\u008b|^\u001f�/.test(sample)) return "a gzip stream served as text";
  return null;
}

// --------------------------------------------- failure notes already saved

/** What the crawl queue's last_note says, mapped to Exyra signals. */
function detectFromNote(url, note) {
  const signals = [];
  const text = String(note || "");
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    return signals;
  }
  if (/hard timeout/i.test(text) && !/robots\.txt/i.test(text)) signals.push({ category: "tarpit", detail: text.slice(0, 160) });
  if (/link cap/i.test(text)) signals.push({ category: "link-flood", detail: text.slice(0, 160) });
  if (/maxContentLength size of \d+ exceeded/i.test(text)) {
    signals.push({ category: /robots\.txt/i.test(text) ? "robots-anomaly" : "oversized-response", detail: text.slice(0, 160) });
  }
  if (/maximum number of redirects/i.test(text)) signals.push({ category: "redirect-loop", detail: text.slice(0, 160) });
  if (/^timeout of \d+ms exceeded/i.test(text)) signals.push({ category: "stall", detail: text.slice(0, 160) });
  if (/robots\.txt unreachable \((reset|stall|hard-timeout|http429)\)/i.test(text) || /status code (429|418|999)\b/.test(text)) {
    signals.push({ target: `${origin}/`, category: "refuses-crawler", detail: text.slice(0, 160) });
  }
  return signals;
}

// ------------------------------------------------------------------ store

class ExyraStore {
  constructor({ dbPath }) {
    this.db = new QuestDatabase(dbPath);
    this.db.pragmaSet("journal_mode = WAL");
    this.db.pragmaSet("synchronous = NORMAL");
    this.db.pragmaSet("busy_timeout = 10000");
    this.db.pragmaSet("cache_size = -4000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS suspects (
        url TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        categories TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        referrer TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL,
        category TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        UNIQUE (url, category)
      );
      CREATE INDEX IF NOT EXISTS idx_suspects_score ON suspects(score DESC);
      CREATE INDEX IF NOT EXISTS idx_suspects_site ON suspects(site);
      CREATE INDEX IF NOT EXISTS idx_signals_category ON signals(category, url);
    `);
    const columns = this.db.prepare("PRAGMA table_info(suspects)").all().map((c) => c.name);
    if (!columns.includes("suspicion")) {
      this.db.exec("ALTER TABLE suspects ADD COLUMN suspicion REAL NOT NULL DEFAULT 0");
      const update = this.db.prepare("UPDATE suspects SET suspicion = ? WHERE url = ?");
      this.db.transaction(() => {
        for (const row of this.db.prepare("SELECT url, categories FROM suspects").all()) {
          update.run(suspicionOf(row.categories.split(",").filter(Boolean)), row.url);
        }
      });
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_suspects_suspicion ON suspects(suspicion DESC, score DESC)");
    this.withheld = new Set();
    this.rescoreIfRatingsChanged();
    this.refreshWithheld();
    // The site (exyra/) reads the threshold, category names, weights and
    // descriptions from here.
    this.setMeta("withhold_at", String(Math.round(WITHHOLD_AT * 100)));
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES ('categories', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(categoryTable()));
    this.upsertSignalStmt = this.db.prepare(`
      INSERT INTO signals(url, category, detail, source, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url, category) DO UPDATE SET last_seen = excluded.last_seen,
        detail = CASE WHEN length(excluded.detail) > length(signals.detail) THEN excluded.detail ELSE signals.detail END
    `);
    this.categoriesForStmt = this.db.prepare("SELECT category FROM signals WHERE url = ?");
    this.suspectExistsStmt = this.db.prepare("SELECT 1 FROM suspects WHERE url = ?");
    this.upsertSuspectStmt = this.db.prepare(`
      INSERT INTO suspects(url, site, score, categories, first_seen, last_seen, hits, referrer, suspicion) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(url) DO UPDATE SET score = excluded.score, categories = excluded.categories, suspicion = excluded.suspicion,
        last_seen = excluded.last_seen, hits = suspects.hits + 1,
        referrer = CASE WHEN suspects.referrer = '' THEN excluded.referrer ELSE suspects.referrer END
    `);
  }

  /**
   * Record signals in one transaction. Each signal names its URL in `target`,
   * or defaults to `url`. Returns how many suspects were new.
   */
  record(url, signals, { source = "crawler", referrer = "", now = Date.now() } = {}) {
    if (!signals || signals.length === 0) return 0;
    return this.db.transaction(() => {
      const touched = new Set();
      let fresh = 0;
      for (const signal of signals) {
        const target = signal.target || url;
        if (!/^https?:\/\//i.test(target) || !CATEGORIES[signal.category]) continue;
        this.upsertSignalStmt.run(target, signal.category, String(signal.detail || "").slice(0, 400), source, now, now);
        touched.add(target);
      }
      for (const target of touched) {
        const categories = this.categoriesForStmt.all(target).map((r) => r.category).sort();
        const score = categories.reduce((sum, c) => sum + weightOf(c), 0);
        let site = "";
        try {
          site = siteOf(new URL(target).hostname);
        } catch {
          continue;
        }
        const before = this.suspectExistsStmt.get(target);
        const suspicion = suspicionOf(categories);
        this.upsertSuspectStmt.run(target, site, score, categories.join(","), now, now, target === url ? referrer : url, suspicion);
        this.noteRating(target, suspicion);
        if (!before) fresh += 1;
      }
      return fresh;
    });
  }

  // ------------------------------------------------- withheld from crawling

  /**
   * A URL just gained evidence: add it to the withheld set if it now reaches
   * the line. Only ever adds -- recording signals never lowers a rating, and
   * several URLs can share one canonical form (query strings are dropped), so
   * removals go through refreshWithheld() instead.
   */
  noteRating(url, suspicion) {
    if (suspicion >= WITHHOLD_AT - 1e-9) this.withheld.add(canonicalUrl(url) || url);
  }

  /** Reload the withheld set from the database (other processes add suspects). */
  refreshWithheld() {
    const rows = this.db.prepare("SELECT url FROM suspects WHERE suspicion >= ?").all(WITHHOLD_AT - 1e-9);
    this.withheld = new Set(rows.map((r) => canonicalUrl(r.url) || r.url));
    return this.withheld.size;
  }

  /** At or above the withhold rating: the crawler skips this URL. */
  isWithheld(url) {
    return this.withheld.size > 0 && this.withheld.has(canonicalUrl(url) || url);
  }

  /** Recompute every suspect's score and rating after the rating table changes. */
  rescoreIfRatingsChanged() {
    const version = createHash("sha1")
      .update(JSON.stringify([CONFIDENCE, Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v[0]]))]))
      .digest("hex");
    if (this.getMeta("ratings_version") === version) return false;

    // One row per distinct combination of categories (a few hundred), then
    // updated in rowid chunks so the crawler's own writes never wait long.
    this.db.exec("CREATE TEMP TABLE IF NOT EXISTS combo (categories TEXT PRIMARY KEY, score REAL, suspicion REAL)");
    this.db.exec("DELETE FROM combo");
    const insert = this.db.prepare("INSERT INTO combo VALUES (?, ?, ?)");
    for (const { categories } of this.db.prepare("SELECT DISTINCT categories FROM suspects").all()) {
      const list = categories.split(",").filter(Boolean);
      insert.run(categories, list.reduce((sum, c) => sum + weightOf(c), 0), suspicionOf(list));
    }
    const max = Number(this.db.prepare("SELECT MAX(rowid) AS m FROM suspects").get()?.m || 0);
    const update = this.db.prepare(`
      UPDATE suspects SET
        score = COALESCE((SELECT score FROM combo WHERE combo.categories = suspects.categories), score),
        suspicion = COALESCE((SELECT suspicion FROM combo WHERE combo.categories = suspects.categories), suspicion)
      WHERE rowid > ? AND rowid <= ?
    `);
    for (let from = 0; from < max; from += 20000) {
      this.db.transaction(() => update.run(from, from + 20000));
    }
    this.setMeta("ratings_version", version);
    return true;
  }

  /** Rescore these URLs from the signals they have left; remove those with none. */
  rescoreUrls(urls) {
    const rescore = this.db.prepare("UPDATE suspects SET categories = ?, score = ?, suspicion = ? WHERE url = ?");
    const remove = this.db.prepare("DELETE FROM suspects WHERE url = ?");
    let removed = 0;
    for (const url of urls) {
      const categories = this.categoriesForStmt.all(url).map((r) => r.category).sort();
      if (categories.length === 0) {
        remove.run(url);
        removed += 1;
      } else {
        const suspicion = suspicionOf(categories);
        rescore.run(categories.join(","), categories.reduce((sum, c) => sum + weightOf(c), 0), suspicion, url);
      }
    }
    // Ratings only fall here, so rebuild the set rather than patch it.
    this.refreshWithheld();
    return removed;
  }

  /**
   * Withdraw evidence: every signal in a category (optionally only from one
   * source, or matching an extra SQL condition on the signals table), with the
   * affected suspects rescored -- and removed if nothing is left against them.
   * For when a detector turns out to be wrong.
   */
  dropSignals(category, source = null, { where: extraWhere = "", params: extraParams = [] } = {}) {
    return this.db.transaction(() => {
      const where = ["category = ?", source ? "source = ?" : null, extraWhere ? `(${extraWhere})` : null].filter(Boolean).join(" AND ");
      const args = [category, ...(source ? [source] : []), ...extraParams];
      const urls = this.db.prepare(`SELECT DISTINCT url FROM signals WHERE ${where}`).all(...args).map((r) => r.url);
      this.db.prepare(`DELETE FROM signals WHERE ${where}`).run(...args);
      return { signals: urls.length, removed: this.rescoreUrls(urls) };
    });
  }

  /**
   * Re-judge stored evidence against the current detectors, using the detail
   * text each signal kept, and withdraw whatever no longer qualifies. For
   * after a detector is tightened: no rescan of pages needed. Categories that
   * can't be re-judged from their text (stalls, refusals, URL shapes, ...)
   * are left alone.
   */
  recheckSignals() {
    const quoted = (detail) => String(detail).replace(/^"|"$/g, "");
    const keep = {
      "robots-bait": (row) => {
        const rule = /Disallow: (\S+)/.exec(row.detail)?.[1];
        return Boolean(rule) && isBaitRule(rule) && rule.replace(/\*+/g, "").replace(/\$$/, "") !== "/";
      },
      "prompt-injection": (row) => findInjection(quoted(row.detail)) !== null,
      "hidden-prompt-injection": (row) => findInjection(quoted(row.detail), { hidden: true }) !== null,
      // Decoy links are the trap; the page that carries them is not.
      "known-tarpit-software": (row) => /\/cdn-cgi\/content/i.test(row.url) || TARPIT_SOFTWARE.test(row.detail),
    };
    const dropped = {};
    const urls = new Set();
    const remove = this.db.prepare("DELETE FROM signals WHERE id = ?");
    for (const [category, keeps] of Object.entries(keep)) {
      const ids = [];
      for (const row of this.db.prepare("SELECT id, url, detail FROM signals WHERE category = ?").all(category)) {
        if (!keeps(row)) {
          ids.push(row.id);
          urls.add(row.url);
        }
      }
      dropped[category] = ids.length;
      for (let i = 0; i < ids.length; i += 5000) {
        this.db.transaction(() => {
          for (const id of ids.slice(i, i + 5000)) remove.run(id);
        });
      }
    }
    // Decoy links used to be one suspect per random ?id=; fold them into one
    // suspect per site (/cdn-cgi/content).
    const decoys = this.db
      .prepare("SELECT id, url, detail, source FROM signals WHERE category = 'known-tarpit-software' AND url LIKE '%/cdn-cgi/content?%'")
      .all();
    const folded = new Map();
    for (const row of decoys) {
      let base = "";
      try {
        base = `${new URL(row.url).origin}/cdn-cgi/content`;
      } catch {
        continue;
      }
      if (!folded.has(base)) folded.set(base, { detail: row.detail, source: row.source });
      urls.add(row.url);
    }
    for (let i = 0; i < decoys.length; i += 5000) {
      this.db.transaction(() => {
        for (const row of decoys.slice(i, i + 5000)) remove.run(row.id);
      });
    }
    dropped.decoysFolded = decoys.length;
    for (const [base, info] of folded) this.record(base, [{ category: "known-tarpit-software", detail: info.detail }], { source: info.source });

    let removed = 0;
    const all = [...urls];
    for (let i = 0; i < all.length; i += 2000) {
      removed += this.db.transaction(() => this.rescoreUrls(all.slice(i, i + 2000)));
    }
    return { dropped, removed };
  }

  counts() {
    const byCategory = {};
    for (const row of this.db.prepare("SELECT category, COUNT(*) c FROM signals GROUP BY category ORDER BY c DESC").all()) {
      byCategory[row.category] = Number(row.c);
    }
    return { suspects: Number(this.db.prepare("SELECT COUNT(*) c FROM suspects").get().c), byCategory };
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
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

/** Category name -> weight, confidence and description, for the export and the site. */
function categoryTable() {
  return Object.fromEntries(
    Object.entries(CATEGORIES).map(([k, [weight, description]]) => [k, { weight, confidence: CONFIDENCE[k] ?? 0.1, description }]),
  );
}

// ----------------------------------------------------------------- export

/**
 * exyra.json (everything, with evidence) and exyra.txt (score, categories,
 * URL -- strongest first). Written to temp files and renamed, so a reader
 * never sees half a file.
 */
function exportExyra(store, basePath) {
  const signals = new Map();
  for (const row of store.db.prepare("SELECT url, category, detail, source, first_seen FROM signals").iterate()) {
    if (!signals.has(row.url)) signals.set(row.url, []);
    signals.get(row.url).push({ category: row.category, detail: row.detail, source: row.source, firstSeen: new Date(Number(row.first_seen)).toISOString() });
  }
  const entries = [];
  for (const row of store.db.prepare("SELECT * FROM suspects ORDER BY suspicion DESC, score DESC, last_seen DESC").iterate()) {
    entries.push({
      url: row.url,
      site: row.site,
      suspicionPercent: Math.round(row.suspicion * 100),
      score: row.score,
      categories: row.categories.split(",").filter(Boolean),
      firstSeen: new Date(Number(row.first_seen)).toISOString(),
      lastSeen: new Date(Number(row.last_seen)).toISOString(),
      hits: row.hits,
      referrer: row.referrer || undefined,
      signals: signals.get(row.url) || [],
    });
  }
  const generatedAt = new Date().toISOString();
  const byCategory = {};
  for (const entry of entries) for (const c of entry.categories) byCategory[c] = (byCategory[c] || 0) + 1;

  const jsonPath = `${basePath}.json`;
  const txtPath = `${basePath}.txt`;
  fs.writeFileSync(
    `${jsonPath}.tmp`,
    JSON.stringify(
      {
        generatedAt,
        source: "QUEST (crawler, feed reader, stored-HTML scans)",
        note: "Listed for scrutiny testing. Being listed records suspicion and evidence; it is not a verdict. Handle every URL as live: probe with byte and time caps, or not at all.",
        count: entries.length,
        byCategory,
        suspicionNote: "suspicionPercent combines each category's rough confidence as 1 - product(1 - p): a heuristic rating, not a calibrated probability.",
        categories: categoryTable(),
        entries,
      },
      null,
      1,
    ),
  );
  const lines = [
    `# Exyra suspects from QUEST, generated ${generatedAt}`,
    `# ${entries.length} URLs, most suspicious first. suspicion%<TAB>score<TAB>categories<TAB>url`,
    "# Listed for scrutiny, not a verdict. Probe with byte/time caps or not at all.",
    "",
    ...entries.map((e) => `${e.suspicionPercent}%\t${e.score}\t${e.categories.join(",")}\t${e.url}`),
  ];
  fs.writeFileSync(`${txtPath}.tmp`, `${lines.join("\n")}\n`);
  fs.renameSync(`${jsonPath}.tmp`, jsonPath);
  fs.renameSync(`${txtPath}.tmp`, txtPath);
  store.setMeta("last_export", generatedAt);
  return { count: entries.length, byCategory, jsonPath, txtPath };
}

module.exports = {
  CATEGORIES,
  WITHHOLD_AT,
  isBaitRule,
  CONFIDENCE,
  suspicionOf,
  ExyraStore,
  detectFetchError,
  detectFromNote,
  detectPage,
  detectRobots,
  detectUrl,
  exportExyra,
  makeHiddenCheck,
  sniffNotText,
};
