"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { QUEST_DIR } = require("./helpers");
const { siteOf } = require(path.join(QUEST_DIR, "site"));

test("hostnames group into the site that serves them", () => {
  const cases = {
    "enbyrgo.tumblr.com": "tumblr.com",
    "staff.tumblr.com": "tumblr.com",
    "en.wikipedia.org": "wikipedia.org",
    "de.m.wikipedia.org": "wikipedia.org",
    "math.stackexchange.com": "stackexchange.com",
    "example.com": "example.com",
    "EXAMPLE.com.": "example.com",
    "www.bbc.co.uk": "bbc.co.uk",
    "news.abc.net.au": "abc.net.au",
    "www3.nhk.or.jp": "nhk.or.jp",
    "user.github.io": "github.io",
    "127.0.0.1": "127.0.0.1",
    "[::1]": "[::1]",
    localhost: "localhost",
  };
  for (const [host, site] of Object.entries(cases)) {
    assert.strictEqual(siteOf(host), site, host);
  }
});
