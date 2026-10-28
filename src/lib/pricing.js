"use strict";

/**
 * Model pricing: what one million tokens of a model costs, and which price
 * actually governs a record.
 *
 * The session files this plugin reads usually carry the price the provider
 * charged, but not always: local models report tokens only, some agents never
 * record a cost, and a few providers stop reporting one entirely. Two layers
 * close that gap without rewriting history:
 *
 *   1. the built-in list prices in `pricing-builtin.js` (so the panel prices
 *      common models out of the box), and
 *   2. the user's own rates, which win field by field and fall back to the
 *      built-in row for anything left empty.
 *
 * A record that already carries a price always keeps it; only the unpriced ones
 * are estimated, and every estimate keeps the "≈" mark on screen.
 *
 * Shape of a table: `{ [modelId]: { model, input, output, cacheRead, cacheWrite } }`,
 * every rate in USD per one million tokens.
 */

const { BUILTIN_PRICING } = require("./pricing-builtin.js");

/** $100k per million tokens: a typo guard for the input field, not a policy. */
const MAX_RATE_PER_MILLION = 100000;

/** The four buckets every rate card carries, in panel order. */
const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];


/**
 * One rate: a non-negative number of dollars per million tokens, or null when
 * the field is empty or unusable.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseRate(value) {
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "" || raw === null || raw === undefined) return null;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.min(MAX_RATE_PER_MILLION, Math.round(amount * 1e6) / 1e6);
}

/**
 * Clean up whatever the panel (or an old settings file) handed over: drop empty
 * entries, clamp junk, and keep the table keyed by model id.
 *
 * A bucket the user left empty keeps no key at all — that absence is what tells
 * `mergePricing` to inherit the built-in rate. Writing a 0 there would price the
 * bucket for free the moment someone filled in a different field.
 *
 * @param {unknown} value
 * @returns {Record<string, { model: string, input?: number, output?: number, cacheRead?: number, cacheWrite?: number }>}
 */
function normalizePricing(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  /** @type {Record<string, any>} */
  const table = {};
  for (const [key, entry] of Object.entries(input)) {
    const model = String(key ?? "").trim();
    if (!model) continue;
    const source = entry && typeof entry === "object" ? /** @type {any} */ (entry) : {};
    /** @type {Record<string, number>} */
    const rates = {};
    for (const field of RATE_FIELDS) {
      const rate = parseRate(source[field]);
      if (rate !== null) rates[field] = rate;
    }
    // A row whose every field is empty is not a price; it is an empty form row.
    if (Object.keys(rates).length === 0) continue;
    table[model] = { model, ...rates };
  }
  return table;
}

/**
 * Built-in list prices with the user's own rates layered on top, field by field:
 * a rate they typed wins for that bucket, an empty field inherits the built-in
 * one. Leaving a model alone keeps working after a table update.
 *
 * @param {unknown} userPricing
 * @returns {Record<string, { model: string, input: number, output: number, cacheRead: number, cacheWrite: number }>}
 */
function mergePricing(userPricing) {
  /** @type {Record<string, { model: string, input: number, output: number, cacheRead: number, cacheWrite: number }>} */
  const merged = {};
  for (const [model, entry] of Object.entries(BUILTIN_PRICING)) {
    merged[model] = {
      model,
      input: entry.input,
      output: entry.output,
      cacheRead: entry.cacheRead,
      cacheWrite: entry.cacheWrite,
    };
  }
  const overrides =
    userPricing && typeof userPricing === "object" && !Array.isArray(userPricing)
      ? /** @type {Record<string, any>} */ (userPricing)
      : {};
  for (const [key, raw] of Object.entries(overrides)) {
    const model = String(key ?? "").trim();
    if (!model) continue;
    const base = merged[model] ?? { model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const pick = (field) => {
      const value = parseRate(raw?.[field]);
      return value === null ? base[field] : value;
    };
    merged[model] = {
      model,
      input: pick("input"),
      output: pick("output"),
      cacheRead: pick("cacheRead"),
      cacheWrite: pick("cacheWrite"),
    };
  }
  return merged;
}

/**
 * Precomputed lookup for one table: `resolve(model)` costs one map hit plus at
 * most one pass over the keys, instead of re-lowercasing every built-in name for
 * every unpriced record in a query.
 *
 * Exact match first, then case-insensitive, then the longest base model that the
 * id extends (`gpt-4o-2024-08-06` → `gpt-4o`, `claude-x@20250601` → `claude-x`).
 * The longest base wins, so a dated `gpt-4o-mini-…` never falls back to `gpt-4o`.
 *
 * @param {Record<string, any>} table
 * @returns {(model: string | null | undefined) => any}
 */
function createResolver(table) {
  /** @type {Map<string, any>} */
  const exact = new Map();
  /** @type {Array<[string, any]>} */
  const ordered = [];
  for (const [mapKey, entry] of Object.entries(table ?? {})) {
    const key = String(entry?.model ?? mapKey ?? "").toLowerCase();
    if (!key) continue;
    exact.set(key, entry);
    ordered.push([key, entry]);
  }
  ordered.sort((a, b) => b[0].length - a[0].length);
  /** @type {Map<string, any>} */
  const answered = new Map();

  /** @param {string} name */
  const lookup = (name) => {
    const direct = exact.get(name);
    if (direct) return direct;
    for (const [key, entry] of ordered) {
      if (name.startsWith(`${key}-`) || name.startsWith(`${key}@`) || name.startsWith(`${key}:`)) return entry;
    }
    return null;
  };

  return (model) => {
    const name = String(model ?? "").trim().toLowerCase();
    if (!name) return null;
    if (answered.has(name)) return answered.get(name);
    let hit = lookup(name);
    // A qualified id (`anthropic/claude-sonnet-4`, `openrouter:gpt-5`) names the
    // same model, so retry once without the provider prefix before giving up.
    if (!hit) {
      const cut = name.search(/[:/]/);
      if (cut > 0) hit = lookup(name.slice(cut + 1));
    }
    answered.set(name, hit);
    return hit;
  };
}

/**
 * The price that governs one model id.
 *
 * @param {Record<string, any>} table
 * @param {string | null | undefined} model
 */
function resolvePrice(table, model) {
  return createResolver(table)(model);
}

/**
 * What one record costs under one rate card. Null when the record carries no
 * tokens to price (all four buckets empty), so an empty row never invents $0.
 *
 * @param {{ input?: number, output?: number, cacheRead?: number, cacheWrite?: number }} entry
 * @param {{ inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number }} record
 * @returns {number | null}
 */
function estimateCost(entry, record) {
  if (!entry || !record) return null;
  const tokens = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  const input = tokens(record.inputTokens);
  const output = tokens(record.outputTokens);
  const cacheRead = tokens(record.cacheReadTokens);
  const cacheWrite = tokens(record.cacheWriteTokens);
  if (input + output + cacheRead + cacheWrite === 0) return null;
  const cost =
    (input * (Number(entry.input) || 0) +
      output * (Number(entry.output) || 0) +
      cacheRead * (Number(entry.cacheRead) || 0) +
      cacheWrite * (Number(entry.cacheWrite) || 0)) /
    1e6;
  if (!Number.isFinite(cost)) return null;
  // Eight decimals: a single cheap request stays visible instead of rounding to 0.
  return Math.round(cost * 1e8) / 1e8;
}

module.exports = {
  MAX_RATE_PER_MILLION,
  BUILTIN_PRICING,
  parseRate,
  normalizePricing,
  mergePricing,
  createResolver,
  resolvePrice,
  estimateCost,
};
