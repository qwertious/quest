"use strict";

/**
 * The unit of politeness: which hostnames are really one site.
 *
 * Every Tumblr blog has its own hostname (name.tumblr.com), and so do
 * Wikipedia's languages, Stack Exchange's communities and Blogspot's blogs.
 * Scheduling per hostname treated each of those as an independent site, so
 * thousands of "sites" took turns on the same servers. Tumblr answered by
 * blocking the crawler's IP outright. So the scheduler, the cooldown and the
 * daily budget all key on the site instead: the registrable domain.
 *
 * This is a deliberate approximation of the Public Suffix List, with no
 * dependency: the last two labels, or the last three under a two-letter
 * country code with a generic second level (bbc.co.uk, abc.net.au,
 * nhk.or.jp). Where it guesses wrong it groups too much, never too little --
 * e.g. all of *.github.io is one site -- which only errs on the polite side.
 * robots.txt is still fetched and obeyed per hostname.
 */

const GENERIC_SECOND_LEVELS = new Set([
  "ac", "biz", "co", "com", "edu", "gen", "go", "gob", "gov", "govt", "info",
  "int", "law", "ltd", "mil", "mus", "ne", "net", "nhs", "nic", "nom", "or",
  "org", "plc", "police", "res", "sch", "school", "web",
]);

function siteOf(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  // IP addresses (v6 arrives bracketed) are their own site.
  if (!host || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)) {
    return host;
  }
  const labels = host.split(".");
  if (labels.length <= 2) {
    return host;
  }
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (tld.length === 2 && GENERIC_SECOND_LEVELS.has(second)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

module.exports = { siteOf };
