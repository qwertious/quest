"use strict";

/**
 * Turn a fetched feed into { kind, title, homeUrl, description, iconUrl,
 * items[] }. Handles RSS 2.0 (and 0.9x), RSS 1.0 (RDF), Atom and JSON Feed --
 * which between them cover blogs, news sites, podcasts, YouTube channels,
 * Mastodon accounts (every profile has an .rss), forums and code forges.
 *
 * Throws NotAFeedError when the body isn't a feed at all (typically an HTML
 * page behind a feed-shaped URL), so the reader can stop asking.
 *
 * Elements are found by tag name rather than CSS selector: feeds lean on
 * namespaced tags (content:encoded, dc:creator, media:thumbnail) that CSS
 * selectors handle badly.
 */

const cheerio = require("cheerio");

const SUMMARY_CHARS = 500;
const MAX_ITEMS = 100;

class NotAFeedError extends Error {}

// ------------------------------------------------------------------ helpers

function kids(node, ...names) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return (node?.children || []).filter((c) => c.type === "tag" && wanted.has(String(c.name).toLowerCase()));
}

function kid(node, ...names) {
  // First match in the order the names were given, so callers can list
  // preferences ("content:encoded", "description").
  for (const name of names) {
    const found = kids(node, name)[0];
    if (found) return found;
  }
  return null;
}

function textOf($, node) {
  return node ? $(node).text().trim() : "";
}

/** HTML (or text that may contain it) -> plain, single-spaced, capped. */
function plain(htmlOrText, max = SUMMARY_CHARS) {
  const raw = String(htmlOrText || "");
  const text = /<[a-z!/]/i.test(raw) ? cheerio.load(raw).root().text() : raw;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 40))}…`;
}

function firstImageIn(html, base) {
  if (!/<img/i.test(String(html || ""))) return "";
  const $ = cheerio.load(String(html));
  return resolve($("img[src]").first().attr("src"), base);
}

function resolve(raw, base) {
  const value = String(raw || "").trim();
  if (!value || /^(data|javascript):/i.test(value)) return "";
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

/** Epoch ms, or null when absent or unparseable. */
function parseDate(value) {
  const ms = Date.parse(String(value || "").trim());
  return Number.isFinite(ms) ? ms : null;
}

function imageFromMedia(item, base) {
  for (const enclosure of kids(item, "enclosure")) {
    if (/^image\//i.test(enclosure.attribs?.type || "")) return resolve(enclosure.attribs.url, base);
  }
  for (const media of kids(item, "media:content", "media:thumbnail")) {
    const medium = media.attribs?.medium || "";
    const type = media.attribs?.type || "";
    if (media.name === "media:thumbnail" || medium === "image" || /^image\//.test(type)) {
      return resolve(media.attribs?.url, base);
    }
  }
  // media:group wraps them on YouTube and some podcasts.
  for (const group of kids(item, "media:group")) {
    const found = imageFromMedia(group, base);
    if (found) return found;
  }
  const itunes = kid(item, "itunes:image");
  return itunes ? resolve(itunes.attribs?.href, base) : "";
}

// --------------------------------------------------------------------- RSS

function parseRssItem($, item, base) {
  const link = resolve(textOf($, kid(item, "link")), base);
  const guid = textOf($, kid(item, "guid"));
  const body = textOf($, kid(item, "content:encoded")) || textOf($, kid(item, "description"));
  return {
    guid: guid || link || textOf($, kid(item, "title")),
    url: link || (/^https?:\/\//.test(guid) ? guid : ""),
    title: plain(textOf($, kid(item, "title")), 300),
    summary: plain(body),
    imageUrl: imageFromMedia(item, base) || firstImageIn(body, link || base),
    author: plain(textOf($, kid(item, "dc:creator", "author", "itunes:author")), 120),
    publishedAt: parseDate(textOf($, kid(item, "pubdate", "dc:date", "published", "updated"))),
  };
}

function parseRss($, root, base) {
  const channel = kid(root, "channel") || root;
  const home = resolve(textOf($, kid(channel, "link")), base);
  // RSS 1.0 puts items beside the channel, not inside it.
  const items = [...kids(channel, "item"), ...kids(root, "item")];
  const image = kid(channel, "image");
  return {
    kind: root.name.toLowerCase() === "rdf:rdf" ? "rdf" : "rss",
    title: plain(textOf($, kid(channel, "title")), 200),
    homeUrl: home,
    description: plain(textOf($, kid(channel, "description")), 300),
    iconUrl: resolve(textOf($, kid(image, "url")), base) || resolve(kid(channel, "itunes:image")?.attribs?.href, base),
    items: items.slice(0, MAX_ITEMS).map((item) => parseRssItem($, item, home || base)),
  };
}

// -------------------------------------------------------------------- Atom

function atomLink(node, base) {
  const links = kids(node, "link");
  const alternate =
    links.find((l) => (l.attribs?.rel || "alternate") === "alternate" && !/xml|json/.test(l.attribs?.type || "")) ||
    links.find((l) => (l.attribs?.rel || "alternate") === "alternate");
  return resolve(alternate?.attribs?.href, base);
}

function parseAtom($, root, base) {
  const home = atomLink(root, base);
  const entries = kids(root, "entry");
  const feedAuthor = textOf($, kid(kid(root, "author"), "name"));
  return {
    kind: "atom",
    title: plain(textOf($, kid(root, "title")), 200),
    homeUrl: home,
    description: plain(textOf($, kid(root, "subtitle")), 300),
    iconUrl: resolve(textOf($, kid(root, "icon", "logo")), base),
    items: entries.slice(0, MAX_ITEMS).map((entry) => {
      const url = atomLink(entry, home || base);
      // YouTube keeps the description in media:group > media:description.
      const body =
        textOf($, kid(entry, "content", "summary")) || textOf($, kid(kid(entry, "media:group"), "media:description"));
      return {
        guid: textOf($, kid(entry, "id")) || url,
        url,
        title: plain(textOf($, kid(entry, "title")), 300),
        summary: plain(body),
        imageUrl: imageFromMedia(entry, base) || firstImageIn(body, url || base),
        author: plain(textOf($, kid(kid(entry, "author"), "name")) || feedAuthor, 120),
        publishedAt: parseDate(textOf($, kid(entry, "published", "updated"))),
      };
    }),
  };
}

// --------------------------------------------------------------- JSON Feed

function parseJsonFeed(data, base) {
  const home = resolve(data.home_page_url, base);
  return {
    kind: "json",
    title: plain(data.title, 200),
    homeUrl: home,
    description: plain(data.description, 300),
    iconUrl: resolve(data.icon || data.favicon, base),
    items: (Array.isArray(data.items) ? data.items : []).slice(0, MAX_ITEMS).map((item) => {
      const url = resolve(item.url || item.external_url, home || base);
      const body = item.content_html || item.content_text || item.summary || "";
      const author = (item.authors && item.authors[0]) || item.author || {};
      return {
        guid: String(item.id ?? url ?? item.title ?? ""),
        url,
        title: plain(item.title, 300),
        summary: plain(item.summary || body),
        imageUrl: resolve(item.image || item.banner_image, base) || firstImageIn(item.content_html, url || base),
        author: plain(author.name, 120),
        publishedAt: parseDate(item.date_published || item.date_modified),
      };
    }),
  };
}

// --------------------------------------------------------------------- main

function parseFeed(body, feedUrl) {
  const text = String(body || "").replace(/^﻿/, "").trimStart();

  if (text.startsWith("{")) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new NotAFeedError("invalid JSON");
    }
    if (!/jsonfeed\.org/.test(String(data.version || "")) && !Array.isArray(data.items)) {
      throw new NotAFeedError("JSON, but not a JSON Feed");
    }
    return finish(parseJsonFeed(data, feedUrl));
  }

  if (/^<(!doctype html|html)[\s>]/i.test(text)) {
    throw new NotAFeedError("an HTML page, not a feed");
  }

  const $ = cheerio.load(text, { xml: true });
  const root = $.root().children().filter((_, n) => n.type === "tag")[0];
  const name = String(root?.name || "").toLowerCase();
  if (name === "rss" || name === "rdf:rdf" || name === "channel") return finish(parseRss($, root, feedUrl));
  if (name === "feed") return finish(parseAtom($, root, feedUrl));
  throw new NotAFeedError(name ? `XML, but <${name}> is not a feed` : "not XML or JSON");
}

/**
 * Drop items with no identity, dedupe by guid, and fall back sensibly. An
 * image on most of a feed's items is the site's logo or a placeholder, not
 * a picture of the post -- it would put the same banner on every card.
 */
function finish(feed) {
  const seen = new Set();
  feed.items = feed.items.filter((item) => {
    if (!item.guid || seen.has(item.guid)) return false;
    seen.add(item.guid);
    if (!item.title) item.title = item.summary.slice(0, 120);
    return Boolean(item.title || item.url);
  });
  if (feed.items.length >= 3) {
    const uses = new Map();
    for (const item of feed.items) if (item.imageUrl) uses.set(item.imageUrl, (uses.get(item.imageUrl) || 0) + 1);
    for (const item of feed.items) {
      if (item.imageUrl && uses.get(item.imageUrl) > feed.items.length / 2) item.imageUrl = "";
    }
  }
  return feed;
}

module.exports = { parseFeed, NotAFeedError };
