"use strict";

/**
 * QUEST_CONTACT: every operator names their own contact, and nothing crawls
 * without one.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert");
const { operatorContact, userAgentFor } = require("../operator");
const { tmpDb, runQuest, runFeeds } = require("./helpers");

describe("operator contact", () => {
  test("accepts a web page or an email address", () => {
    assert.strictEqual(operatorContact({ QUEST_CONTACT: " https://example.org/crawler " }), "https://example.org/crawler");
    assert.strictEqual(operatorContact({ QUEST_CONTACT: "crawler@example.org" }), "crawler@example.org");
  });

  test("rejects a missing or malformed contact", () => {
    for (const value of [undefined, "", "   ", "example.org", "not an address", "ftp://example.org"]) {
      assert.strictEqual(operatorContact({ QUEST_CONTACT: value }), null, String(value));
    }
  });

  test("builds the usual crawler User-Agent", () => {
    assert.strictEqual(
      userAgentFor("https://example.org/crawler", "educational scraper"),
      "Quest/1.0 (+https://example.org/crawler; educational scraper)",
    );
    assert.strictEqual(
      userAgentFor("crawler@example.org", "feed reader"),
      "Quest/1.0 (+mailto:crawler@example.org; feed reader)",
    );
  });

  test("the crawler refuses to start without one", async () => {
    const run = await runQuest(tmpDb(), ["--once"], { QUEST_CONTACT: "" });
    assert.strictEqual(run.code, 2, run.out);
    assert.match(run.out, /QUEST_CONTACT is not set/);
  });

  test("the feed reader refuses to start without one", async () => {
    const run = await runFeeds(tmpDb(), ["--once"], { QUEST_CONTACT: "" });
    assert.strictEqual(run.code, 2, run.out);
    assert.match(run.out, /QUEST_CONTACT is not set/);
  });
});
