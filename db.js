"use strict";

/**
 * Thin SQLite driver adapter.
 *
 * Prefers better-sqlite3 when it is installed, and falls back to the built-in
 * node:sqlite module (Node >= 22) so the crawler can run without a native build
 * toolchain. Only the small surface QUEST needs is exposed, using positional
 * parameters everywhere because that is what both drivers agree on.
 */

function loadDriver() {
  try {
    const BetterSqlite3 = require("better-sqlite3");
    // require() only loads the JavaScript; the native binary is loaded lazily
    // on first use. A binary built for another platform (e.g. node_modules
    // synced between a Linux server and a Windows machine) passes require()
    // and then fails here -- so prove it works before committing to it.
    new BetterSqlite3(":memory:").close();
    return { kind: "better-sqlite3", BetterSqlite3 };
  } catch {
    const { DatabaseSync } = require("node:sqlite");
    return { kind: "node:sqlite", DatabaseSync };
  }
}

class QuestDatabase {
  constructor(filePath) {
    const driver = loadDriver();
    this.driverName = driver.kind;
    this.txnDepth = 0;

    if (driver.kind === "better-sqlite3") {
      this.handle = new driver.BetterSqlite3(filePath);
    } else {
      this.handle = new driver.DatabaseSync(filePath);
    }
  }

  exec(sql) {
    this.handle.exec(sql);
  }

  prepare(sql) {
    return this.handle.prepare(sql);
  }

  /** Register a deterministic one-argument SQL function backed by JS. */
  defineFunction(name, impl) {
    // Same signature in both drivers: (name, options, fn).
    this.handle.function(name, { deterministic: true }, impl);
  }

  /** Run a PRAGMA that returns a single scalar value. */
  pragmaValue(pragmaText) {
    const row = this.handle.prepare(`PRAGMA ${pragmaText}`).get();
    if (!row) {
      return null;
    }
    return Object.values(row)[0] ?? null;
  }

  /** Run a PRAGMA purely for its side effect. */
  pragmaSet(pragmaText) {
    this.handle.exec(`PRAGMA ${pragmaText}`);
  }

  /**
   * Run fn inside a transaction. Nested calls use savepoints so callers can
   * compose without knowing whether they are already in one.
   */
  transaction(fn) {
    const depth = this.txnDepth;
    const begin = depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT sp_${depth}`;
    const commit = depth === 0 ? "COMMIT" : `RELEASE sp_${depth}`;
    const rollback =
      depth === 0 ? "ROLLBACK" : `ROLLBACK TO sp_${depth}; RELEASE sp_${depth}`;

    this.exec(begin);
    this.txnDepth += 1;
    try {
      const result = fn();
      this.txnDepth -= 1;
      this.exec(commit);
      return result;
    } catch (error) {
      this.txnDepth -= 1;
      try {
        this.exec(rollback);
      } catch {
        // The original error is the useful one.
      }
      throw error;
    }
  }

  close() {
    this.handle.close();
  }
}

/** node:sqlite hands back Uint8Array where better-sqlite3 hands back Buffer. */
function toBuffer(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

module.exports = {
  QuestDatabase,
  toBuffer,
};
