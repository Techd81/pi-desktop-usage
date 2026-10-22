#!/usr/bin/env node
/**
 * Development-only reconciliation probe.
 *
 * Scans the real session directories into a throwaway cache, then prints the
 * totals this plugin would show and compares them with independent sources:
 *
 *   PI-Desktop  ↔ `pi.sqlite` (`turns.usage_json.totalTokens`)
 *   Pi CLI      ↔ the previous `token-usage-statistics/records.jsonl` cache
 *
 * Nothing is written outside a temporary directory; both session roots are only
 * read. Usage: node scripts/probe.mjs
 */

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { RecordStore } = require("../src/lib/store.js");
const { scanRoot } = require("../src/lib/scan.js");
const { query } = require("../src/lib/aggregate.js");
const { resolveRoots } = require("../src/lib/paths.js");
const cliAdapter = require("../src/adapters/cli.js");
const desktopAdapter = require("../src/adapters/desktop.js");
const Fmt = require("../src/lib/format.js");

const roots = resolveRoots();

function formatRow(label, value) {
  return `${label.padEnd(28)} ${value}`;
}

/** @param {string} label @param {number} actual @param {number | null} expected */
function compare(label, actual, expected) {
  if (expected === null) {
    console.log(formatRow(`${label} (reference)`, "unavailable"));
    return;
  }
  const delta = actual - expected;
  const deltaPercent = expected === 0 ? (actual === 0 ? 0 : Number.POSITIVE_INFINITY) : (delta / expected) * 100;
  const verdict = Math.abs(deltaPercent) < 1 ? "match" : `${delta > 0 ? "+" : ""}${delta} (${deltaPercent.toFixed(2)}%)`;
  console.log(formatRow(`${label} (reference)`, `${Fmt.formatTokensExact(expected)} → ${verdict}`));
}

/** @returns {number | null} */
function desktopReferenceTotal() {
  const database = path.join(os.homedir(), ".pi-desktop", "pi.sqlite");
  if (!fs.existsSync(database)) return null;
  const sqlite = ["sqlite3", "C:/msys64/ucrt64/bin/sqlite3.exe"].find((candidate) => {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    return probe.status === 0;
  });
  if (!sqlite) return null;

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-desktop-usage-probe-db-"));
  for (const suffix of ["", "-wal", "-shm"]) {
    const from = `${database}${suffix}`;
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(temp, `pi.sqlite${suffix}`));
  }
  const result = spawnSync(
    sqlite,
    [
      path.join(temp, "pi.sqlite"),
      "select coalesce(sum(json_extract(usage_json, '$.totalTokens')), 0) from turns where usage_json is not null;",
    ],
    { encoding: "utf8" },
  );
  fs.rmSync(temp, { recursive: true, force: true });
  if (result.status !== 0) return null;
  const value = Number(String(result.stdout).trim());
  return Number.isFinite(value) ? value : null;
}

/** @returns {number | null} */
function cliReferenceTotal() {
  const records = path.join(os.homedir(), ".pi", "agent", "token-usage-statistics", "records.jsonl");
  if (!fs.existsSync(records)) return null;
  let total = 0;
  for (const line of fs.readFileSync(records, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      total += Number(record.totalTokens) || 0;
    } catch {
      // A damaged trailing line in the old cache is ignored, exactly like here.
    }
  }
  return total;
}

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-desktop-usage-probe-"));
const store = new RecordStore({ dir: dataDir });
await store.load();

const startedAt = Date.now();
const cli = await scanRoot({ root: roots.cli, source: "cli", adapter: cliAdapter, store, budgetMs: 600000, startedAt });
const desktop = await scanRoot({
  root: roots.desktop,
  source: "desktop",
  adapter: desktopAdapter,
  store,
  budgetMs: 600000,
  startedAt: Date.now(),
});
await store.flush({ scannedAt: Date.now() });

const usage = query(store.all(), { range: "all", nowMs: Date.now() });
const bySource = new Map(usage.bySource.map((row) => [row.source, row]));
const elapsed = Date.now() - startedAt;

console.log("");
console.log(`roots            cli=${roots.cli}`);
console.log(`                 desktop=${roots.desktop}`);
console.log(formatRow("files (cli)", `${cli.totalFiles} total, ${cli.scannedFiles} read, ${cli.skippedFiles} skipped`));
console.log(formatRow("files (desktop)", `${desktop.totalFiles} total, ${desktop.scannedFiles} read, ${desktop.skippedFiles} skipped`));
console.log(formatRow("records", String(store.size)));
console.log(formatRow("scan time", `${elapsed} ms`));
console.log("");
console.log(formatRow("tokens (cli)", Fmt.formatTokensExact(bySource.get("cli")?.tokens ?? 0)));
console.log(formatRow("tokens (desktop)", Fmt.formatTokensExact(bySource.get("desktop")?.tokens ?? 0)));
console.log(formatRow("tokens (total)", Fmt.formatTokensExact(usage.totals.tokens)));
console.log(formatRow("cost (total)", Fmt.formatUsd(usage.totals.cost)));
console.log(formatRow("requests (total)", Fmt.formatTokensExact(usage.totals.requests)));
console.log("");
console.log("reconciliation");
compare("PI-Desktop", bySource.get("desktop")?.tokens ?? 0, desktopReferenceTotal());
compare("Pi CLI", bySource.get("cli")?.tokens ?? 0, cliReferenceTotal());
console.log("");

await fsp.rm(dataDir, { recursive: true, force: true });
