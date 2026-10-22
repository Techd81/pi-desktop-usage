"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { createBackend } = require("../src/backend.js");
const { makeTempDir, copyFixture } = require("./helpers.js");

const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = () => Date.now();
/**
 * A fake host: only the surface the plugin actually uses.
 */
async function setup({ failDesktop = false } = {}) {
  const tmp = await makeTempDir();
  const cliRoot = path.join(tmp, "cli");
  const desktopRoot = path.join(tmp, "desktop");
  await copyFixture("cli", cliRoot);
  await copyFixture("desktop", desktopRoot);

  const dataDir = path.join(tmp, "data");
  /** @type {Record<string, any>} */
  const settings = {};
  /** @type {any[]} */
  const settingsWrites = [];
  /** @type {string[]} */
  const operations = [];

  const pi = {
    plugin: {
      getDataPath: async () => dataDir,
      getSettings: async () => settings,
      setSettings: async (patch) => {
        settingsWrites.push(patch);
        Object.assign(settings, patch);
        return { ok: true };
      },
    },
    workspace: { get: async () => ({ path: "D:\\demo" }) },
    desktop: {
      listOperations: async () => [
        { id: "providers/list", description: "List providers", risk: "read" },
        { id: "session/list", description: "List sessions", risk: "read" },
        { id: "project/list", description: "List projects", risk: "read" },
      ],
      invoke: async ({ operation }) => {
        operations.push(operation);
        if (failDesktop) throw new Error("PERMISSION_DENIED");
        if (operation === "providers/list") return { providers: [{ id: "prov-1", name: "Acme" }] };
        if (operation === "project/list") return { projects: [{ id: "project-1", path: "D:/demo" }] };
        if (operation === "session/list") return { sessions: [{ id: SESSION_ID, projectId: "project-1" }] };
        return null;
      },
    },
  };

  const backend = createBackend({
    pi,
    roots: { cli: cliRoot, desktop: desktopRoot },
    now: NOW,
  });

  return { backend, dataDir, settings, settingsWrites, operations, tmp, cliRoot, desktopRoot, pi };
}

test("hello reports both roots, availability and default preferences", async () => {
  const { backend } = await setup();
  const hello = await backend.invoke("usage.hello", {});

  assert.equal(hello.ok, true);
  assert.equal(hello.version, "0.1.0");
  assert.equal(hello.availability.cli, true);
  assert.equal(hello.availability.desktop, true);
  assert.deepEqual(hello.prefs, { range: "7d", sources: [], accent: "blue", theme: "system", fromMs: 0, toMs: 0 });
  assert.equal(hello.scan.records, 0);
  assert.ok(Array.isArray(hello.limitations) && hello.limitations.length > 0);
});

test("scan fills the cache from both roots and get aggregates without rescanning", async () => {
  const { backend, operations } = await setup();

  const scan = await backend.invoke("usage.scan", {});
  assert.equal(scan.ok, true);
  assert.equal(scan.partial, false);
  assert.equal(scan.records, 7);
  assert.equal(scan.progress.appendedRecords, 7);

  const usage = await backend.invoke("usage.get", { range: "all", nowMs: NOW() });
  assert.equal(usage.totals.tokens, 12077);
  assert.equal(usage.totals.requests, 7);
  assert.equal(usage.totals.costComplete, false, "one CLI message carries no price");
  assert.equal(usage.bySource.length, 2);
  assert.equal(usage.bySource.find((row) => row.source === "desktop").tokens, 11847);
  assert.equal(usage.bySource.find((row) => row.source === "cli").tokens, 230);
  operations.length = 0;
  const warm = await backend.invoke("usage.get", { range: "all", nowMs: NOW() });
  assert.equal(warm.totals.tokens, 12077);
  assert.equal(operations.length, 0, "a warm query reuses the cached enrichment");
  const desktopModel = usage.byModel.find((row) => row.source === "desktop");
  assert.equal(desktopModel.provider, "Acme", "provider ids are resolved through providers/list");

  const desktopProject = usage.byProject.find((row) => row.source === "desktop");
  assert.equal(desktopProject.projectPath, "D:/demo");
  const cliProject = usage.byProject.find((row) => row.source === "cli");
  assert.equal(cliProject.projectPath, "D:\\demo");
  assert.equal(usage.meta.enrichment.available, true);
});

test("preferences round-trip through the host settings", async () => {
  const { backend, settings, settingsWrites } = await setup();
  const updated = await backend.invoke("usage.prefs.set", { range: "30d", sources: ["desktop", "bogus"] });

  assert.equal(updated.ok, true);
  assert.deepEqual(updated.prefs, { range: "30d", sources: ["desktop"], accent: "blue", theme: "system", fromMs: 0, toMs: 0 });
  assert.deepEqual(settings.usagePrefs, { range: "30d", sources: ["desktop"], accent: "blue", theme: "system", fromMs: 0, toMs: 0 });
  assert.equal(settingsWrites.length, 1);

  const hello = await backend.invoke("usage.hello", {});
  assert.deepEqual(hello.prefs, { range: "30d", sources: ["desktop"], accent: "blue", theme: "system", fromMs: 0, toMs: 0 });
});

test("a free-form accent survives validation and anything else falls back", async () => {
  const { backend, settings } = await setup();

  const saved = await backend.invoke("usage.prefs.set", { accent: "#7C5CFF" });
  assert.equal(saved.prefs.accent, "#7c5cff");
  assert.equal(settings.usagePrefs.accent, "#7c5cff");

  const named = await backend.invoke("usage.prefs.set", { accent: "violet" });
  assert.equal(named.prefs.accent, "violet");

  const unknown = await backend.invoke("usage.prefs.set", { accent: "chartreuse" });
  assert.equal(unknown.prefs.accent, "blue");

  const shortHex = await backend.invoke("usage.prefs.set", { accent: "#fff" });
  assert.equal(shortHex.prefs.accent, "blue");
});

test("a refused enrichment leaves the counts untouched and falls back to the provider id", async () => {
  const { backend } = await setup({ failDesktop: true });
  await backend.invoke("usage.scan", {});
  const usage = await backend.invoke("usage.get", { range: "all", nowMs: NOW() });
  assert.equal(usage.totals.tokens, 12077);
  const desktopModel = usage.byModel.find((row) => row.source === "desktop");
  assert.equal(desktopModel.provider, "prov-1");
  assert.equal(usage.meta.enrichment.available, false);
  assert.ok(usage.meta.enrichment.errors.length > 0);
});

test("an unknown channel fails softly", async () => {
  const { backend } = await setup();
  const result = await backend.invoke("usage.nope", {});
  assert.equal(result.ok, false);
  assert.equal(result.code, "UNSUPPORTED");
});

test("a source filter is honoured end to end", async () => {
  const { backend } = await setup();
  await backend.invoke("usage.scan", {});
  const usage = await backend.invoke("usage.get", { range: "all", sources: ["cli"], nowMs: NOW() });
  assert.equal(usage.totals.tokens, 230);
  assert.equal(usage.bySource.length, 1);
  assert.equal(usage.bySource[0].source, "cli");
});

test("rebuild clears the cache and rescans", async () => {
  const { backend } = await setup();
  await backend.invoke("usage.scan", {});
  const rebuilt = await backend.invoke("usage.scan", { rebuild: true });
  assert.equal(rebuilt.records, 7);
  assert.equal(rebuilt.progress.appendedRecords, 7);
});

test("an unknown accent falls back to the default palette", async () => {
  const { backend } = await setup();
  const fallback = await backend.invoke("usage.prefs.set", { accent: "neon" });
  assert.deepEqual(fallback.prefs, { range: "7d", sources: [], accent: "blue", theme: "system", fromMs: 0, toMs: 0 });
  const violet = await backend.invoke("usage.prefs.set", { accent: "violet" });
  assert.equal(violet.prefs.accent, "violet");
});

test("an unknown theme falls back to following the system", async () => {
  const { backend } = await setup();
  const fallback = await backend.invoke("usage.prefs.set", { theme: "neon" });
  assert.equal(fallback.prefs.theme, "system");
  const dark = await backend.invoke("usage.prefs.set", { theme: "dark" });
  assert.equal(dark.prefs.theme, "dark");
});

test("a custom range keeps its explicit window", async () => {
  const { backend } = await setup();
  await backend.invoke("usage.scan", {});
  const fromMs = Date.parse("2026-10-01T00:00:00.000Z");
  const toMs = Date.parse("2026-10-01T23:59:59.000Z");

  const saved = await backend.invoke("usage.prefs.set", { range: "custom", fromMs, toMs });
  assert.equal(saved.prefs.range, "custom");
  assert.equal(saved.prefs.fromMs, fromMs);
  assert.equal(saved.prefs.toMs, toMs);

  const usage = await backend.invoke("usage.get", {});
  assert.equal(usage.range, "custom");
  assert.equal(usage.fromMs, fromMs);
  assert.equal(usage.toMs, toMs);
  assert.equal(usage.totals.tokens, 230, "only the CLI records fall inside that day");
});

test("a custom range without a usable window reports the fallback range", async () => {
  const { backend } = await setup();
  const usage = await backend.invoke("usage.get", { range: "custom", fromMs: 0, toMs: 0, nowMs: NOW() });

  assert.equal(usage.range, "7d");
  assert.equal(usage.bucket, "day");
  assert.equal(usage.series.length, 7);
});

test("concurrent first calls initialise the cache once, not once per caller", async () => {
  const { backend, pi } = await setup();
  // Count the real entry point instead of inspecting internals: two cold callers
  // racing on `ensureStore` used to build a store each and share one directory.
  let dataPathCalls = 0;
  const original = pi.plugin.getDataPath;
  pi.plugin.getDataPath = async () => {
    dataPathCalls += 1;
    return original();
  };

  const [hello, usage, scan] = await Promise.all([
    backend.invoke("usage.hello", {}),
    backend.invoke("usage.get", { range: "7d" }),
    backend.invoke("usage.scan", {}),
  ]);

  assert.equal(hello.ok, true);
  assert.ok(usage && typeof usage.totals === "object", "get answers without a scan");
  assert.equal(scan.ok, true);
  // Only one resolution is asserted here: `scan` mutates the record count, so any
  // equality between what `hello` and `get` saw would depend on which finished first.
  assert.equal(dataPathCalls, 1, "the data directory is resolved once");
});
