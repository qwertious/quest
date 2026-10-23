"use strict";

/**
 * How the crawler decides which URLs are worth queueing, shared with
 * maintain.js so a requeue pass treats URLs exactly as a crawl would.
 */

const path = require("node:path");

const SKIPPED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".pdf", ".zip", ".rar",
  ".7z", ".mp3", ".wav", ".ogg", ".mp4", ".webm", ".mov", ".avi", ".css",
  ".js", ".json", ".xml", ".ico",
]);

function canonicalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    parsed.search = "";

    if (
      (parsed.protocol === "http:" && parsed.port === "80") ||
      (parsed.protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }

    if (parsed.pathname && parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    if (parsed.pathname === "/") {
      return parsed.origin;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

function hasSkippedExtension(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return ext ? SKIPPED_EXTENSIONS.has(ext) : false;
  } catch {
    return true;
  }
}

module.exports = { canonicalUrl, hasSkippedExtension, SKIPPED_EXTENSIONS };
