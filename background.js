"use strict";

/**
 * The crawler's slow housekeeping, on its own thread.
 *
 * SQLite calls are synchronous: while one runs, the thread that made it can do
 * nothing else. On a big database with a small page cache, even an indexed
 * COUNT(*) has to read its index back from disk -- 10+ seconds on the server,
 * during which every in-flight fetch "timed out" and Ctrl-C went unheard.
 *
 * Here those jobs get their own thread and their own connection. WAL mode lets
 * that connection read while the crawler keeps writing, so a slow count now
 * costs nothing but its own time.
 *
 * This file is both halves: required normally it exports startBackground();
 * loaded as a worker it runs the jobs.
 */

const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");

// The Exyra store, opened on first use by whichever thread runs the export.
let exyraForExport = null;

/** The jobs themselves, shared by the worker and the inline fallback. */
function runJob(store, job, arg) {
  switch (job) {
    case "exyra-export": {
      const { ExyraStore, exportExyra } = require(path.join(__dirname, "exyra"));
      exyraForExport ??= new ExyraStore({ dbPath: arg.dbPath });
      return exportExyra(exyraForExport, arg.basePath);
    }
    case "counts":
      return store.refreshCachedCounts();
    case "rearchive": {
      const remaining = store.countNeedingRearchive(arg);
      store.setMeta("stat_rearchive_remaining", remaining);
      return remaining;
    }
    case "checkpoint":
      return store.checkpoint("PASSIVE");
    default:
      throw new Error(`unknown job ${job}`);
  }
}

/**
 * Start the worker. Returns { run(job, arg), close() }; run() resolves with
 * { result, ms } or with null if that job is still running from last time.
 * If the worker can't start or dies, jobs run inline on `fallbackStore`
 * instead -- blocking again, but still working.
 */
function startBackground({ dbPath, fallbackStore, onLog = () => {} }) {
  const inFlight = new Set();
  const waiting = new Map();
  let nextId = 1;
  let worker = null;

  const fail = (error) => {
    if (!worker) return;
    onLog(`background thread stopped (${error?.message || error}); running housekeeping inline from now on`);
    worker = null;
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };

  try {
    worker = new Worker(__filename, { workerData: { dbPath } });
    worker.on("message", (msg) => {
      const pending = waiting.get(msg.id);
      if (!pending) return;
      waiting.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve({ result: msg.result, ms: msg.ms });
    });
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`exited with code ${code}`)));
    // Never keep the process alive just for housekeeping.
    worker.unref();
  } catch (error) {
    worker = null;
    onLog(`background thread unavailable (${error?.message}); running housekeeping inline`);
  }

  async function run(job, arg) {
    if (inFlight.has(job)) return null;
    inFlight.add(job);
    try {
      if (!worker) {
        const started = Date.now();
        return { result: runJob(fallbackStore, job, arg), ms: Date.now() - started, inline: true };
      }
      const id = nextId++;
      const reply = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
      // Keep the process alive while a job is out, and only then: an idle
      // worker mustn't hold the process open, but a pending reply must.
      worker.ref();
      worker.postMessage({ id, job, arg });
      return await reply;
    } finally {
      inFlight.delete(job);
      if (worker && inFlight.size === 0) worker.unref();
    }
  }

  async function close() {
    const w = worker;
    worker = null;
    if (w) {
      w.removeAllListeners("exit");
      await w.terminate();
    }
  }

  return { run, close, get threaded() { return worker !== null; } };
}

if (!isMainThread && workerData?.dbPath) {
  const { QuestSqliteStore } = require(path.join(__dirname, "sqlite_store"));
  // The main thread has already migrated the schema.
  const store = new QuestSqliteStore({ dbPath: workerData.dbPath, migrate: false });
  parentPort.on("message", ({ id, job, arg }) => {
    const started = Date.now();
    try {
      const result = runJob(store, job, arg);
      parentPort.postMessage({ id, result, ms: Date.now() - started });
    } catch (error) {
      parentPort.postMessage({ id, error: error?.message || String(error), ms: Date.now() - started });
    }
  });
}

module.exports = { startBackground, runJob };
