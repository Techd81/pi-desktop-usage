"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const pricing = require("../src/lib/pricing.js");

test("a rate is a non-negative dollars-per-million number, or nothing", () => {
  assert.equal(pricing.parseRate("3"), 3);
  assert.equal(pricing.parseRate(" 0.0000005 "), 0.000001, "rates are kept to six decimals");
  assert.equal(pricing.parseRate(""), null, "an empty field is not a zero rate");
  assert.equal(pricing.parseRate("   "), null);
  assert.equal(pricing.parseRate("-1"), null);
  assert.equal(pricing.parseRate("abc"), null);
  assert.equal(pricing.parseRate(Number.NaN), null);
  assert.equal(pricing.parseRate(null), null);
  assert.equal(pricing.parseRate(pricing.MAX_RATE_PER_MILLION * 2), pricing.MAX_RATE_PER_MILLION);
});

test("the table keeps only rows that name a model and carry a rate", () => {
  const table = pricing.normalizePricing({
    "gpt-4o": { input: "2.5", output: "10", cacheRead: "1.25" },
    "gemini-2.5-pro": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    empty: {},
    junk: { input: "abc", output: "-3" },
    "  spaced  ": { output: "4" },
  });

  assert.deepEqual(Object.keys(table).sort(), ["gemini-2.5-pro", "gpt-4o", "spaced"]);
  assert.equal(table["gpt-4o"].input, 2.5);
  assert.equal("cacheWrite" in table["gpt-4o"], false, "an empty bucket carries no rate at all");
  assert.equal(table.spaced.model, "spaced", "the key is trimmed and kept as the model");
  assert.deepEqual(pricing.normalizePricing(null), {});
  assert.deepEqual(pricing.normalizePricing([1, 2]), {});
});

test("resolve picks exact, then case-insensitive, then the longest dated base", () => {
  const table = pricing.normalizePricing({
    "gpt-4o": { input: 2.5 },
    "gpt-4o-mini": { input: 0.15 },
    "Claude-Sonnet-4": { input: 3 },
  });

  assert.equal(pricing.resolvePrice(table, "gpt-4o").input, 2.5);
  assert.equal(pricing.resolvePrice(table, "GPT-4O-MINI").input, 0.15, "case-insensitive match");
  assert.equal(pricing.resolvePrice(table, "claude-sonnet-4").input, 3);
  assert.equal(pricing.resolvePrice(table, "gpt-4o-2024-08-06").input, 2.5, "dated variant of a base model");
  assert.equal(
    pricing.resolvePrice(table, "gpt-4o-mini-2024-07-18").input,
    0.15,
    "the longest base wins, not the shortest",
  );
  assert.equal(pricing.resolvePrice(table, "claude-sonnet-4@20250514").input, 3);
  assert.equal(pricing.resolvePrice(table, "unknown-model"), null);
  assert.equal(pricing.resolvePrice(table, ""), null);
  assert.equal(pricing.resolvePrice({}, "gpt-4o"), null);
});

test("a record costs its four buckets at the table's rates", () => {
  const entry = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const cost = pricing.estimateCost(entry, {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  });
  assert.equal(cost, 3 + 15 + 0.3 + 3.75);

  const small = pricing.estimateCost(entry, { inputTokens: 100, outputTokens: 10 });
  assert.ok(Math.abs(small - (100 * 3e-6 + 10 * 15e-6)) < 1e-12);

  assert.equal(pricing.estimateCost(entry, { inputTokens: 0, outputTokens: 0 }), null, "nothing to price");
  assert.equal(pricing.estimateCost(null, { inputTokens: 5 }), null);
  assert.equal(pricing.estimateCost(entry, null), null);
});

test("the built-in table ships real list prices and sane rates", () => {
  const table = pricing.BUILTIN_PRICING;
  const models = Object.keys(table);
  assert.ok(models.length >= 100, `expected a real table, got ${models.length} models`);

  for (const [model, entry] of Object.entries(table)) {
    for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
      const value = entry[field];
      assert.ok(Number.isFinite(value) && value >= 0, `${model}.${field} is a non-negative number`);
    }
    assert.ok(entry.output > 0 || entry.input > 0, `${model} prices at least one bucket above zero`);
  }

  // Spot-check the rows that make the feature visible on real data.
  assert.deepEqual(table["claude-sonnet-4-20250514"], {
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  });
  assert.deepEqual(table["deepseek-v4.1-flash"], { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
});

test("user rates override the built-in row field by field", () => {
  const merged = pricing.mergePricing({ "deepseek-v4.1-flash": { input: "0.5" }, "my-local": { output: "2" } });

  assert.equal(merged["deepseek-v4.1-flash"].input, 0.5, "the typed rate wins");
  assert.equal(merged["deepseek-v4.1-flash"].output, 1.2, "an empty field keeps the built-in rate");
  assert.equal(merged["deepseek-v4.1-flash"].cacheRead, 0.006);
  assert.deepEqual(merged["my-local"], { model: "my-local", input: 0, output: 2, cacheRead: 0, cacheWrite: 0 });
  assert.equal(merged["claude-sonnet-4-20250514"].input, 3, "untouched rows are the built-in ones");
});

test("createResolver answers like resolvePrice without rebuilding the lookup", () => {
  const table = pricing.mergePricing({});
  const resolve = pricing.createResolver(table);

  assert.equal(resolve("claude-sonnet-4-20250514").input, 3);
  assert.equal(resolve("CLAUDE-SONNET-4-20250514").input, 3, "case-insensitive");
  assert.equal(resolve("gpt-5-2026-01-01")?.input, table["gpt-5"]?.input, "dated variant falls back to its base");
  assert.equal(resolve("totally-unknown-model"), null);
  assert.equal(resolve(""), null);
});

test("a saved partial rate keeps inheriting the built-in buckets", () => {
  // The panel's draft goes through sanitizePrefs before it ever reaches
  // mergePricing, so "an empty field keeps the built-in rate" has to survive
  // that normalization step — a filled bucket must not freeze the rest at zero.
  const saved = pricing.normalizePricing({ "claude-sonnet-4-20250514": { input: "5" } });
  assert.deepEqual(
    saved,
    { "claude-sonnet-4-20250514": { model: "claude-sonnet-4-20250514", input: 5 } },
    "only the typed bucket is stored",
  );

  const merged = pricing.mergePricing(saved)["claude-sonnet-4-20250514"];
  assert.equal(merged.input, 5, "the typed rate wins");
  assert.equal(merged.output, 15, "an untouched bucket keeps the built-in rate");
  assert.equal(merged.cacheRead, 0.3);
  assert.equal(merged.cacheWrite, 3.75);
});

test("a qualified model id resolves through its provider prefix", () => {
  const resolve = pricing.createResolver(pricing.mergePricing({}));

  assert.equal(resolve("anthropic/claude-sonnet-4-20250514").input, 3);
  assert.equal(resolve("openrouter:gpt-5").input, pricing.BUILTIN_PRICING["gpt-5"].input);
  assert.equal(resolve("totally/unknown-model"), null);
});

test("the resolver reads a bare built-in table, not only a merged one", () => {
  assert.equal(pricing.resolvePrice(pricing.BUILTIN_PRICING, "gpt-5").input, pricing.BUILTIN_PRICING["gpt-5"].input);
});
