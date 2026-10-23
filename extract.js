"use strict";

const cheerio = require("cheerio");
const { detectPage, makeHiddenCheck } = require("./exyra");

/**
 * Structure-preserving text extraction from HTML.
 *
 * Bump EXTRACTOR_VERSION whenever the output of extractText() changes in a way
 * that makes previously-extracted text stale. Pages record the version they
 * were extracted with, so `maintain.js --reextract` can find and redo exactly
 * the ones that are behind -- from stored HTML, with no re-crawling.
 *
 * Version history:
 *   1  $("body").text() + collapse all whitespace to single spaces.
 *      Concatenated text nodes with no separator, so every element boundary
 *      silently deleted a word break ("<a>Home</a><a>About</a>" -> "HomeAbout")
 *      and all line structure was destroyed.
 *   2  Block elements produce paragraph breaks, inline elements produce a
 *      space, <pre> is preserved verbatim.
 */
const EXTRACTOR_VERSION = 2;

/** Elements that should start and end a line of their own. */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "canvas", "dd", "details",
  "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer",
  "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li",
  "main", "nav", "ol", "output", "p", "pre", "section", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul", "video",
]);

/** Never contributes text. */
const DROPPED_ELEMENTS = new Set(["script", "style", "noscript", "template", "svg", "iframe"]);

// Sentinels for stashing <pre> content past whitespace normalization. Control
// characters, so they cannot collide with anything in real page text.
const PRE_OPEN = String.fromCharCode(1);
const PRE_CLOSE = String.fromCharCode(2);

/**
 * Walk the DOM emitting text with real separators.
 *
 * The previous implementation's fatal flaw was cheerio's .text(), which
 * concatenates descendant text nodes with nothing between them. Emitting an
 * explicit separator at every element boundary -- a newline for block
 * elements, a space for inline ones -- is what keeps words apart.
 */
function extractText(html) {
  return extractTextFrom(cheerio.load(html));
}

function extractTextFrom($) {
  const body = $("body")[0] || $.root()[0];
  if (!body) {
    return "";
  }

  const parts = [];
  const preserved = [];

  function walk(node) {
    if (node.type === "text") {
      parts.push(String(node.data || "").replace(/[ \t\r\n]+/g, " "));
      return;
    }
    if (node.type !== "tag") {
      return;
    }

    const tag = String(node.name || "").toLowerCase();
    if (DROPPED_ELEMENTS.has(tag)) {
      return;
    }

    if (tag === "br") {
      parts.push("\n");
      return;
    }

    if (tag === "pre") {
      // Keep code and preformatted text exactly as authored: indentation is
      // meaningful, and normalization below would flatten it.
      const index = preserved.length;
      preserved.push(
        $(node).text().replace(/\r\n/g, "\n").replace(/\s+$/, ""),
      );
      parts.push(`\n\n${PRE_OPEN}${index}${PRE_CLOSE}\n\n`);
      return;
    }

    const isBlock = BLOCK_ELEMENTS.has(tag);
    parts.push(isBlock ? "\n\n" : " ");
    for (const child of node.children || []) {
      walk(child);
    }
    parts.push(isBlock ? "\n\n" : " ");
  }

  walk(body);

  const normalized = parts
    .join("")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  const restore = new RegExp(`${PRE_OPEN}(\\d+)${PRE_CLOSE}`, "g");
  return normalized.replace(restore, (_, i) => preserved[Number(i)] ?? "");
}

/** Page title, or "Untitled". */
function extractTitle(html) {
  return extractTitleFrom(cheerio.load(html));
}

function extractTitleFrom($) {
  return $("title").first().text().trim() || "Untitled";
}

/** Absolute, de-fragmented outbound links. */
function extractLinks(html, pageUrl, limit = Infinity) {
  return extractLinksFrom(cheerio.load(html), pageUrl, limit);
}

/**
 * Links a reader could follow, plus (separately) links the page hides from
 * readers -- the hidden attribute or an inline display:none and the like on
 * the link or around it. Hidden links are how crawler traps are baited, so
 * they are never queued, only reported to Exyra.
 */
function extractLinksFrom($, pageUrl, limit = Infinity) {
  const links = new Set();
  const hiddenLinks = new Set();
  const isHidden = makeHiddenCheck($);
  let truncated = false;

  $("a[href]").each((_, element) => {
    const href = ($(element).attr("href") || "").trim();
    if (!href || href.startsWith("#")) {
      return;
    }

    const lowered = href.toLowerCase();
    if (
      lowered.startsWith("javascript:") ||
      lowered.startsWith("mailto:") ||
      lowered.startsWith("tel:") ||
      lowered.startsWith("data:")
    ) {
      return;
    }

    try {
      const resolved = new URL(href, pageUrl);
      resolved.hash = "";
      if (isHidden(element)) {
        if (hiddenLinks.size < 100) hiddenLinks.add(resolved.toString());
        return;
      }
      links.add(resolved.toString());
    } catch {
      // Ignore malformed links.
    }

    if (links.size >= limit) {
      truncated = true;
      return false;
    }
  });

  return { links: [...links], hiddenLinks: [...hiddenLinks], truncated };
}

// ------------------------------------------------------------------- images

const MAX_IMAGES_PER_PAGE = 40;
// Below this (when the page states a size) it's an icon, bullet or button.
const MIN_IMAGE_DIMENSION = 100;
// Narrow on purpose: pixels and spacers are mostly caught already by the size
// and text rules, and a broad word list rejects real pictures ("pixel-art",
// "clear-sky"). This catches the classic files and ad/tracking paths.
const JUNK_IMAGE_URL =
  /\/(1x1|spacer|pixel|blank|transparent|clear)\.(gif|png)(\?|$)|\/(favicon|sprites?)[^/]*$|\/(ads?|adserver|analytics|beacon|tracking)\//i;
// Alt text that says nothing about the picture.
const GENERIC_ALT = new Set([
  "image", "img", "photo", "picture", "pic", "logo", "icon", "thumbnail",
  "thumb", "banner", "placeholder", "untitled", "spacer", "graphic", "avatar",
]);

function cleanText(value, max = 300) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function meaningful(text) {
  return text.length >= 3 && !GENERIC_ALT.has(text.toLowerCase()) && /[a-z\p{L}]/iu.test(text);
}

/** The largest candidate in a srcset ("a.jpg 320w, b.jpg 1024w" -> b.jpg). */
function bestFromSrcset(srcset) {
  let best = null;
  for (const part of String(srcset || "").split(",")) {
    const [url, descriptor = "1x"] = part.trim().split(/\s+/);
    if (!url) continue;
    const size = parseFloat(descriptor) * (descriptor.endsWith("w") ? 1 : 1000);
    if (!best || size > best.size) best = { url, size: Number.isFinite(size) ? size : 0 };
  }
  return best ? best.url : "";
}

function absoluteHttpUrl(raw, base) {
  const value = String(raw || "").trim();
  if (!value || /^(data|blob|javascript|about):/i.test(value)) return "";
  try {
    const url = new URL(value, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/**
 * Images worth searching for, with the text that describes them.
 *
 * An image is only searchable by its words, so one with no meaningful alt
 * text, title or caption is dropped -- as are tracking pixels, spacers,
 * icons and SVGs (almost always logos and UI). The page's declared lead
 * image (og:image) is always kept and described by the page title.
 */
function extractImagesFrom($, pageUrl) {
  const found = new Map();
  const add = (image) => {
    if (!image.url || found.has(image.url) || found.size >= MAX_IMAGES_PER_PAGE) return;
    if (JUNK_IMAGE_URL.test(image.url) || /\.svg(\?|$)/i.test(image.url)) return;
    found.set(image.url, image);
  };

  const lead = absoluteHttpUrl(
    $('meta[property="og:image"]').attr("content") || $('meta[name="twitter:image"]').attr("content"),
    pageUrl,
  );
  if (lead) {
    add({
      url: lead,
      alt: cleanText($('meta[property="og:image:alt"]').attr("content")),
      caption: "",
      width: parseInt($('meta[property="og:image:width"]').attr("content"), 10) || null,
      height: parseInt($('meta[property="og:image:height"]').attr("content"), 10) || null,
      lead: true,
    });
  }

  $("img").each((_, element) => {
    if (found.size >= MAX_IMAGES_PER_PAGE) return false;
    const img = $(element);
    // Lazy-loading sites keep the real image in a data- attribute.
    const srcset = img.attr("srcset") || img.attr("data-srcset");
    const raw =
      bestFromSrcset(srcset) ||
      img.attr("data-src") || img.attr("data-original") || img.attr("data-lazy-src") || img.attr("src");
    const url = absoluteHttpUrl(raw, pageUrl);
    if (!url) return;

    const width = parseInt(img.attr("width"), 10) || null;
    const height = parseInt(img.attr("height"), 10) || null;
    if ((width && width < MIN_IMAGE_DIMENSION) || (height && height < MIN_IMAGE_DIMENSION)) return;

    const alt = cleanText(img.attr("alt"));
    const title = cleanText(img.attr("title"));
    const caption = cleanText(img.closest("figure").find("figcaption").first().text());
    const words = [alt, title, caption].filter(meaningful);
    if (words.length === 0) return;

    add({
      url,
      alt: meaningful(alt) ? alt : meaningful(title) ? title : "",
      caption: meaningful(caption) ? caption : "",
      width,
      height,
      lead: false,
    });
  });

  return [...found.values()];
}

// -------------------------------------------------------------------- feeds

const FEED_TYPES = {
  "application/rss+xml": "rss",
  "application/atom+xml": "atom",
  "application/feed+json": "json",
  "application/rdf+xml": "rdf",
};
// Links that are almost always feeds even without a <link> declaring them.
const FEED_LIKE_HREF =
  /(\/feed\/?|\/rss\/?|\.rss|\.atom|\/(atom|rss|feed|index)\.xml|\/feeds\/posts\/default)(\?.*)?$/i;
const MAX_FEEDS_PER_PAGE = 10;

/**
 * Feeds this page points at: RSS, Atom, RSS 1.0 (RDF) and JSON Feed. Declared
 * <link rel="alternate"> feeds are certain; feed-shaped <a> links are only
 * candidates, confirmed or discarded by the feed reader when it fetches them.
 * Comment feeds are skipped -- they are replies, not posts.
 */
function extractFeedsFrom($, pageUrl) {
  const found = new Map();
  const add = (url, kind, title) => {
    if (!url || found.has(url) || found.size >= MAX_FEEDS_PER_PAGE) return;
    if (/\/comments\/feed\/?$|[?&]comments?=/i.test(url)) return;
    found.set(url, { url, kind, title: cleanText(title, 200) });
  };

  $('link[rel~="alternate"][href]').each((_, element) => {
    const type = String($(element).attr("type") || "").toLowerCase().split(";")[0].trim();
    const kind = FEED_TYPES[type];
    if (kind) add(absoluteHttpUrl($(element).attr("href"), pageUrl), kind, $(element).attr("title"));
  });

  $("a[href]").each((_, element) => {
    if (found.size >= MAX_FEEDS_PER_PAGE) return false;
    const url = absoluteHttpUrl($(element).attr("href"), pageUrl);
    if (url && FEED_LIKE_HREF.test(new URL(url).pathname + new URL(url).search)) {
      add(url, "guess", $(element).text());
    }
  });

  return [...found.values()];
}

/**
 * Everything the crawler needs from one page, parsing the HTML exactly once.
 * At hundreds of thousands of pages, separate cheerio.load() calls per thing
 * extracted is a cost worth avoiding.
 */
function parsePage(html, pageUrl, linkLimit = Infinity) {
  const $ = cheerio.load(html);
  const text = extractTextFrom($);
  const linkInfo = extractLinksFrom($, pageUrl, linkLimit);
  return {
    title: extractTitleFrom($),
    text,
    images: extractImagesFrom($, pageUrl),
    feeds: extractFeedsFrom($, pageUrl),
    ...linkInfo,
    exyra: detectPage($, pageUrl, { text, html, linkCapHit: linkInfo.truncated, ...linkInfo }),
  };
}

/**
 * For passes over stored HTML: media (images, feeds) and/or Exyra signals,
 * from one parse. Text is only extracted when Exyra needs it.
 */
function analyzeStored(html, pageUrl, { media = true, exyra = true, linkLimit = 500 } = {}) {
  const $ = cheerio.load(html);
  const out = { title: extractTitleFrom($) };
  if (media) {
    out.images = extractImagesFrom($, pageUrl);
    out.feeds = extractFeedsFrom($, pageUrl);
  }
  if (exyra) {
    const linkInfo = extractLinksFrom($, pageUrl, linkLimit);
    out.exyra = detectPage($, pageUrl, { text: extractTextFrom($), html, linkCapHit: linkInfo.truncated, ...linkInfo });
  }
  return out;
}

/** Just the media (images and feeds), for backfilling from stored HTML. */
function parseMedia(html, pageUrl) {
  return analyzeStored(html, pageUrl, { media: true, exyra: false });
}

module.exports = {
  EXTRACTOR_VERSION,
  extractText,
  extractTitle,
  extractLinks,
  parsePage,
  parseMedia,
  analyzeStored,
};
