"use strict";

/** Image search (xImages) and feeds (xWire): extraction, storage, end to end. */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { tmpDb, startSite, runQuest, runFeeds, runMaintain, QUEST_DIR } = require("./helpers");
const { parsePage } = require(path.join(QUEST_DIR, "extract"));
const { parseFeed, NotAFeedError } = require(path.join(QUEST_DIR, "feed_parse"));
const { ImageStore } = require(path.join(QUEST_DIR, "image_store"));
const { FeedStore, DEAD_AFTER_FAILURES } = require(path.join(QUEST_DIR, "feed_store"));

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", "feeds", name), "utf8");
const sibling = (dbPath, name) => path.join(path.dirname(dbPath), name);

describe("image and feed extraction", () => {
  const html = `<html><head><title>Garden diary</title>
    <meta property="og:image" content="/img/lead.jpg">
    <link rel="alternate" type="application/rss+xml" title="Diary" href="/feed/">
    <link rel="alternate" type="application/rss+xml" href="/comments/feed/">
    </head><body>
    <img src="/a.jpg" alt="Sunflowers in August">
    <img src="/b.jpg" alt="image">
    <img src="/c.jpg">
    <img src="/icon.png" alt="Search icon" width="16" height="16">
    <img src="/1x1.gif" alt="tracking">
    <img data-src="/lazy.jpg" src="/placeholder.gif" alt="Lazy loaded beans">
    <img srcset="/s320.jpg 320w, /s1024.jpg 1024w" src="/s320.jpg" alt="Big pumpkin">
    <figure><img src="/fig.jpg"><figcaption>Harvest table</figcaption></figure>
    <img src="/pixel-art.png" alt="Pixel art cat">
    <img src="/logo.svg" alt="Garden club logo">
    <a href="/blog/rss.xml">RSS</a></body></html>`;
  const page = parsePage(html, "https://garden.example/diary/");
  const urls = page.images.map((i) => i.url.replace("https://garden.example", ""));

  test("keeps described images, drops the rest", () => {
    assert.deepStrictEqual(urls, ["/img/lead.jpg", "/a.jpg", "/lazy.jpg", "/s1024.jpg", "/fig.jpg", "/pixel-art.png"]);
    assert.strictEqual(page.images[0].lead, true);
    assert.strictEqual(page.images.find((i) => i.url.endsWith("/fig.jpg")).caption, "Harvest table");
  });

  test("finds declared and feed-shaped feeds, skips comment feeds", () => {
    assert.deepStrictEqual(
      page.feeds.map((f) => [f.url, f.kind]),
      [["https://garden.example/feed/", "rss"], ["https://garden.example/blog/rss.xml", "guess"]],
    );
  });
});

describe("feed parsing", () => {
  test("RSS 2.0: CDATA, namespaces, relative links, media, bad dates, duplicates", () => {
    const feed = parseFeed(fixture("rss2.xml"), "https://garden.example/feed/");
    assert.strictEqual(feed.kind, "rss");
    assert.strictEqual(feed.title, "Garden & Kitchen");
    assert.strictEqual(feed.items.length, 2, "duplicate item not dropped");
    const [first, second] = feed.items;
    assert.strictEqual(first.title, "Tomatoes finally ripe");
    assert.strictEqual(first.author, "Ann");
    assert.strictEqual(first.imageUrl, "https://garden.example/img/tom.jpg");
    assert.strictEqual(first.publishedAt, Date.parse("2026-10-06T09:30:00Z"));
    assert.strictEqual(second.url, "https://garden.example/posts/seeds");
    assert.strictEqual(second.imageUrl, "https://garden.example/img/seeds.jpg");
    assert.strictEqual(second.publishedAt, null);
    assert.strictEqual(second.summary, "Bring your spare seeds Saturday.");
  });

  test("Atom, including YouTube's media:group", () => {
    const feed = parseFeed(fixture("atom.xml"), "https://dev.example/atom.xml");
    assert.strictEqual(feed.kind, "atom");
    assert.strictEqual(feed.homeUrl, "https://dev.example/");
    assert.strictEqual(feed.items[0].url, "https://dev.example/2026/fridays");
    assert.strictEqual(feed.items[0].author, "Bo", "feed-level author not inherited");
    assert.strictEqual(feed.items[1].imageUrl, "https://i.ytimg.com/vi/abc/hqdefault.jpg");
    assert.strictEqual(feed.items[1].summary, "What this video is about.");
  });

  test("RSS 1.0 (RDF) and JSON Feed", () => {
    const rdf = parseFeed(fixture("rdf.xml"), "https://old.example/rss");
    assert.strictEqual(rdf.kind, "rdf");
    assert.strictEqual(rdf.items[0].title, "First");
    const json = parseFeed(fixture("feed.json"), "https://micro.example/feed.json");
    assert.strictEqual(json.kind, "json");
    assert.strictEqual(json.items[0].imageUrl, "https://micro.example/p.jpg");
    assert.strictEqual(json.items[0].author, "Cy");
  });

  test("a logo repeated on most items is dropped, real pictures kept", () => {
    const items = ["a", "b", "c", "d"].map((id, i) =>
      `<item><guid>${id}</guid><title>${id}</title><enclosure type="image/png" url="https://n.example/${i < 3 ? "logo" : "photo"}.png"/></item>`,
    );
    const feed = parseFeed(`<rss><channel><title>N</title>${items.join("")}</channel></rss>`, "https://n.example/rss");
    assert.deepStrictEqual(feed.items.map((i) => i.imageUrl), ["", "", "", "https://n.example/photo.png"]);
  });

  test("an HTML page, plain JSON or other XML is not a feed", () => {
    for (const body of ["<!doctype html><html><body>hi</body></html>", '{"a":1}', "<urlset/>"]) {
      assert.throws(() => parseFeed(body, "https://x.example/"), NotAFeedError, body);
    }
  });
});

describe("image store", () => {
  test("one picture on two pages is one image, found by both pages' words", () => {
    const store = new ImageStore({ dbPath: sibling(tmpDb("img"), "images.sqlite") });
    const pic = { url: "https://cdn.example/sun.jpg", alt: "Sunflowers", caption: "", width: null, height: null };
    store.savePage("https://a.example/1", "Summer garden", [pic]);
    store.savePage("https://b.example/2", "Yellow flowers", [{ ...pic, alt: "Big blooms" }]);
    assert.strictEqual(store.counts().images, 1);
    assert.strictEqual(store.search("sunflowers")[0].url, pic.url);
    assert.strictEqual(store.search("blooms")[0].page_url, "https://b.example/2");
    // Re-crawled without the image: that page stops vouching for it.
    store.savePage("https://b.example/2", "Yellow flowers", []);
    assert.strictEqual(store.search("blooms").length, 0);
    assert.strictEqual(store.search("sunflowers").length, 1);
    store.close();
  });
});

describe("feed store", () => {
  const feedOf = (items) => ({ kind: "rss", title: "T", homeUrl: "", description: "", iconUrl: "", items });
  const item = (guid, publishedAt, title = guid) => ({ guid, url: "", title, summary: "", imageUrl: "", author: "", publishedAt });

  test("counts only new posts, updates edits, clamps future dates", () => {
    const store = new FeedStore({ dbPath: sibling(tmpDb("feedstore"), "feeds.sqlite") });
    store.addDiscovered([{ url: "https://f.example/rss", kind: "rss" }], "https://f.example/");
    const { id } = store.dueFeeds()[0];
    const now = Date.now();
    assert.strictEqual(store.recordSuccess(id, feedOf([item("a", now - 7200e3), item("b", now + 86400e3)]), {}, now), 2);
    assert.strictEqual(store.recordSuccess(id, feedOf([item("a", now - 7200e3, "edited"), item("c", now)]), {}, now), 1);
    const posts = store.db.prepare("SELECT guid, title, published_at FROM posts ORDER BY guid").all();
    assert.deepStrictEqual(posts.map((p) => p.title), ["edited", "b", "c"]);
    assert.ok(posts[1].published_at <= now, "future date not clamped");
    assert.strictEqual(store.dueFeeds(now).length, 0, "not rescheduled");
    store.close();
  });

  test("checks a feed about as often as it posts", () => {
    const store = new FeedStore({ dbPath: sibling(tmpDb("cadence"), "feeds.sqlite") });
    store.addDiscovered([{ url: "https://hourly.example/rss", kind: "rss" }, { url: "https://rare.example/rss", kind: "rss" }], "");
    const [hourly, rare] = store.dueFeeds();
    const now = Date.now();
    store.recordSuccess(hourly.id, feedOf([0, 1, 2, 3, 4].map((h) => item(`h${h}`, now - h * 3600e3))), {}, now);
    store.recordSuccess(rare.id, feedOf([0, 1, 2].map((m) => item(`m${m}`, now - m * 30 * 86400e3))), {}, now);
    assert.strictEqual(store.intervalFor(hourly.id), 30 * 60e3);
    assert.strictEqual(store.intervalFor(rare.id), 24 * 3600e3);
    store.close();
  });

  test("failures back off, and enough of them in a row end it", () => {
    const store = new FeedStore({ dbPath: sibling(tmpDb("failing"), "feeds.sqlite") });
    store.addDiscovered([{ url: "https://down.example/rss", kind: "rss" }], "");
    const { id } = store.dueFeeds()[0];
    const now = Date.now();
    let state = null;
    for (let i = 0; i < DEAD_AFTER_FAILURES; i += 1) state = store.recordFailure(id, "timeout", {}, now);
    assert.strictEqual(state, "dead");
    assert.strictEqual(store.dueFeeds(now + 365 * 86400e3).length, 0, "dead feed still due");
    store.close();
  });
});

describe("end to end", () => {
  let site;
  before(async () => {
    site = await startSite();
  });
  after(async () => {
    await site.close();
  });

  test("crawling indexes images and finds feeds; the reader fetches them politely", async () => {
    const dbPath = tmpDb("media-e2e");
    const crawl = await runQuest(dbPath, [`${site.base}/gallery`, "--once", "--max-pages=1"]);
    assert.strictEqual(crawl.code, 0, crawl.out);

    let images = new ImageStore({ dbPath: sibling(dbPath, "images.sqlite") });
    assert.ok(images.search("sunflowers").length === 1, "described image missing");
    assert.ok(images.search("marrow").length === 1, "captioned image missing");
    assert.strictEqual(images.search("arrow").length, 0, "tiny icon indexed");
    images.close();

    let feeds = new FeedStore({ dbPath: sibling(dbPath, "feeds.sqlite") });
    assert.deepStrictEqual(
      feeds.db.prepare("SELECT url, kind FROM feeds ORDER BY url").all().map((f) => [f.url.replace(site.base, ""), f.kind]),
      [["/blog/rss.xml", "guess"], ["/feed.xml", "rss"]],
    );
    feeds.close();

    const first = await runFeeds(dbPath, ["--once"]);
    assert.strictEqual(first.code, 0, first.out);
    feeds = new FeedStore({ dbPath: sibling(dbPath, "feeds.sqlite") });
    assert.deepStrictEqual(feeds.stateCounts(), { active: 1, invalid: 1 });
    assert.strictEqual(feeds.postCount(), 2);
    const post = feeds.db.prepare("SELECT url, title FROM posts ORDER BY published_at DESC LIMIT 1").get();
    assert.deepStrictEqual({ ...post }, { url: `${site.base}/news/marrow`, title: "Marrow wins first prize" });
    // Make it due again: the second fetch should be a conditional one.
    feeds.db.exec("UPDATE feeds SET next_fetch_at = 0 WHERE state = 'active'");
    feeds.close();

    const second = await runFeeds(dbPath, ["--once"]);
    assert.strictEqual(second.code, 0, second.out);
    assert.strictEqual(site.feedHits.notModified, 1, "ETag not sent back");
    feeds = new FeedStore({ dbPath: sibling(dbPath, "feeds.sqlite") });
    assert.strictEqual(feeds.postCount(), 2, "posts duplicated");
    feeds.close();
  });

  test("--index-media backfills from stored HTML, and resumes rather than redoes", async () => {
    const dbPath = tmpDb("backfill");
    await runQuest(dbPath, [`${site.base}/gallery`, "--once", "--max-pages=1"], { QUEST_INDEX_MEDIA: "false" });
    assert.ok(!fs.existsSync(sibling(dbPath, "images.sqlite")), "media indexed with QUEST_INDEX_MEDIA=false");

    const run = await runMaintain(dbPath, ["--index-media"]);
    assert.strictEqual(run.code, 0, run.out);
    assert.match(run.out, /Done: 1 pages, 3 images, 2 new feeds/);
    const images = new ImageStore({ dbPath: sibling(dbPath, "images.sqlite") });
    assert.strictEqual(images.search("sunflowers").length, 1);
    images.close();

    const again = await runMaintain(dbPath, ["--index-media"]);
    assert.match(again.out, /Done: 0 pages/);
    const status = await runMaintain(dbPath, ["--media-status"]);
    assert.match(status.out, /backfill: complete/);
  });
});
