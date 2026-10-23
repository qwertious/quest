"use strict";

/**
 * Who runs this copy of QUEST. Every request carries a contact so a site owner
 * with a problem can reach whoever is crawling them. There is deliberately no
 * default: each operator sets their own, so nobody's traffic is ever
 * attributed to someone else.
 *
 *   QUEST_CONTACT=https://example.org/crawler   a page about your crawler
 *   QUEST_CONTACT=crawler@example.org           or an email address
 */

const CONTACT_PATTERN = /^(https?:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/i;

/** The configured contact, or null when it is missing or not a URL/address. */
function operatorContact(env = process.env) {
  const value = String(env.QUEST_CONTACT ?? "").trim();
  return CONTACT_PATTERN.test(value) ? value : null;
}

/** "Quest/1.0 (+<contact>; <purpose>)", the usual crawler User-Agent shape. */
function userAgentFor(contact, purpose) {
  const link = contact.includes("://") ? contact : `mailto:${contact}`;
  return `Quest/1.0 (+${link}; ${purpose})`;
}

/**
 * The User-Agent for a script that is about to make requests. Exits with a
 * message when QUEST_CONTACT is unset, before anything is fetched.
 */
function requireUserAgent(purpose) {
  const contact = operatorContact();
  if (contact === null) {
    console.error(
      "QUEST_CONTACT is not set. QUEST will not crawl anonymously or under someone else's name.\n" +
        "Set it to a web page or email address where site owners can reach you, e.g.\n" +
        "  QUEST_CONTACT=https://example.org/crawler node quest.js",
    );
    process.exit(2);
  }
  return userAgentFor(contact, purpose);
}

module.exports = { operatorContact, userAgentFor, requireUserAgent };
