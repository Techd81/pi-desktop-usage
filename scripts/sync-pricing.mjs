#!/usr/bin/env node
/**
 * Regenerate `src/lib/pricing-builtin.js` from cc-switch's seeded rate card.
 *
 * cc-switch keeps its list prices in one Rust function,
 * `src-tauri/src/database/schema.rs → seed_model_pricing`, plus a
 * `repair_current_model_pricing` table that carries the current price of the few
 * models it once seeded wrong. Both are parsed here, because a repair row is the
 * authoritative value: cc-switch rewrites those rows on startup, so a table that
 * ignored them would disagree with the app it was copied from.
 *
 * Usage:
 *   node scripts/sync-pricing.mjs                 # fetch main from GitHub
 *   node scripts/sync-pricing.mjs --source <path> # parse a local schema.rs
 *   node scripts/sync-pricing.mjs --check         # exit 1 when the file is stale
 *
 * Rows the plugin prices but cc-switch does not are kept: dropping one would
 * silently turn a priced model into an unpriced one, and these are the models
 * that actually show up in the local session files.
 */

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = path.join(ROOT, "src", "lib", "pricing-builtin.js");
const DEFAULT_SOURCE =
  "https://raw.githubusercontent.com/farion1231/cc-switch/main/src-tauri/src/database/schema.rs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const sourceIndex = args.indexOf("--source");
const source = sourceIndex === -1 ? DEFAULT_SOURCE : args[sourceIndex + 1];

/**
 * Read the source text from a URL or a path.
 * @param {string} location
 * @returns {Promise<string>}
 */
async function readSource(location) {
  if (/^https?:\/\//i.test(location)) {
    const response = await fetch(location, { redirect: "follow" });
    if (!response.ok) throw new Error(`GET ${location} → ${response.status}`);
    return await response.text();
  }
  return await readFile(path.resolve(location), "utf8");
}

/**
 * Tuples of a `let name = [ ... ];` block, comments stripped so a quoted note
 * can never be mistaken for data.
 *
 * @param {string} rust
 * @param {string} marker the `fn ...` line that opens the block
 * @returns {string[][]}
 */
function tuplesOf(rust, marker) {
  const start = rust.indexOf(marker);
  if (start === -1) throw new Error(`marker not found in cc-switch source: ${marker}`);
  const open = rust.indexOf("[", start);
  const close = rust.indexOf("\n        ];", open);
  if (open === -1 || close === -1) throw new Error(`unterminated table after ${marker}`);
  const block = rust
    .slice(open, close)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  /** @type {string[][]} */
  const tuples = [];
  for (const match of block.matchAll(/\(([\s\S]*?)\)\s*,/g)) {
    const fields = [...match[1].matchAll(/"([^"]*)"/g)].map((quoted) => quoted[1]);
    if (fields.length >= 6) tuples.push(fields);
  }
  return tuples;
}

/**
 * A decimal string as written by cc-switch ("0.20", "12.50", "0") in the
 * shortest exact form, without going through a float.
 * @param {string} label
 * @param {string} value
 * @returns {string}
 */
function rate(label, value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${label}: not a decimal price: ${raw}`);
  if (!raw.includes(".")) return String(Number(raw));
  const trimmed = raw.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" ? "0" : trimmed;
}

/**
 * @param {string[]} row (model_id, display_name, input, output, cache_read, cache_write, ...)
 * @returns {[string, { input: string, output: string, cacheRead: string, cacheWrite: string }]}
 */
function toEntry(row) {
  const [model, , input, output, cacheRead, cacheWrite] = row;
  return [
    model,
    {
      input: rate(`${model}.input`, input),
      output: rate(`${model}.output`, output),
      cacheRead: rate(`${model}.cacheRead`, cacheRead),
      cacheWrite: rate(`${model}.cacheWrite`, cacheWrite),
    },
  ];
}

const rust = await readSource(source);
/** @type {Map<string, Record<string, string>>} */
const upstream = new Map();
for (const row of tuplesOf(rust, "fn seed_model_pricing")) upstream.set(...toEntry(row));
// Repair rows win: they hold the price cc-switch itself has moved to.
for (const row of tuplesOf(rust, "fn repair_current_model_pricing")) upstream.set(...toEntry(row));

const { BUILTIN_PRICING } = await import(`file://${TARGET.replace(/\\/g, "/")}?t=${Date.now()}`);
/** @type {Map<string, Record<string, number>>} */
const merged = new Map(Object.entries(BUILTIN_PRICING));
/** @type {Array<[string, Record<string, string>]>} */
const rows = [];
let repaired = 0;
let keptLocal = 0;
for (const [model, entry] of [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  const next = upstream.get(model);
  if (!next) {
    keptLocal += 1;
    rows.push([
      model,
      {
        input: String(entry.input),
        output: String(entry.output),
        cacheRead: String(entry.cacheRead),
        cacheWrite: String(entry.cacheWrite),
      },
    ]);
    continue;
  }
  const changed = ["input", "output", "cacheRead", "cacheWrite"].some(
    (field) => Number(entry[field]) !== Number(next[field]),
  );
  if (changed) repaired += 1;
  rows.push([model, next]);
}
const added = [...upstream.keys()].filter((model) => !merged.has(model)).sort();
for (const model of added) rows.push([model, upstream.get(model)]);
rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const body = rows
  .map(
    ([model, entry]) =>
      `  "${model}": { input: ${entry.input}, output: ${entry.output}, cacheRead: ${entry.cacheRead}, cacheWrite: ${entry.cacheWrite} },`,
  )
  .join("\n");

const contents = `"use strict";

/**
 * Built-in list prices, USD per one million tokens.
 *
 * The panel works without any of this — a session that records its own price is
 * always believed first — but a model that never reports a cost (local weights,
 * token-only providers) would otherwise stay unpriced forever. This table is the
 * floor under the user's own rates: whatever they type for a model overrides it,
 * and clearing their row falls back here.
 *
 * Generated from the seeded rate card of cc-switch (MIT, © 2025 Jason Young),
 * https://github.com/farion1231/cc-switch — \`src-tauri/src/database/schema.rs\`,
 * \`seed_model_pricing\` plus the \`repair_current_model_pricing\` corrections.
 * Re-run \`npm run pricing\` to resync; \`npm run pricing -- --check\` fails when
 * this file no longer matches upstream.
 *
 * Prices change; the table is a starting point, not a billing guarantee.
 */

/** @type {Record<string, { input: number, output: number, cacheRead: number, cacheWrite: number }>} */
const BUILTIN_PRICING = {
${body}
};

module.exports = { BUILTIN_PRICING };
`;
const previous = await readFile(TARGET, "utf8");
if (checkOnly) {
  if (previous !== contents) {
    console.error(`pricing-builtin.js is stale: ${added.length} new model(s), ${repaired} re-priced`);
    process.exit(1);
  }
  console.log(`pricing-builtin.js is in sync with ${source} (${rows.length} models)`);
  process.exit(0);
}

await writeFile(TARGET, contents, "utf8");
console.log(
  `synced ${rows.length} models from ${source}\n  new: ${added.length}${
    added.length ? ` (${added.join(", ")})` : ""
  }\n  re-priced: ${repaired}\n  kept from the local table: ${keptLocal}`,
);
