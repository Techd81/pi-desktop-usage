"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const Fmt = require("../src/lib/format.js");

test("token formatting switches units at the right boundaries", () => {
  assert.equal(Fmt.formatTokens(0), "0");
  assert.equal(Fmt.formatTokens(999), "999");
  assert.equal(Fmt.formatTokens(1000), "1.0K");
  assert.equal(Fmt.formatTokens(1234), "1.2K");
  assert.equal(Fmt.formatTokens(12345), "12K");
  assert.equal(Fmt.formatTokens(1234567), "1.23M");
  assert.equal(Fmt.formatTokens(1234567890), "1.23B");
  assert.equal(Fmt.formatTokensExact(1234567), "1,234,567");
  assert.equal(Fmt.formatTokens(Number.NaN), "0");
});

test("money keeps small amounts readable and marks missing prices", () => {
  assert.equal(Fmt.formatUsd(null), "—");
  assert.equal(Fmt.formatUsd(undefined), "—");
  assert.equal(Fmt.formatUsd(0), "$0");
  assert.equal(Fmt.formatUsd(0.0001234), "$0.0001");
  assert.equal(Fmt.formatUsd(0.01234), "$0.012");
  assert.equal(Fmt.formatUsd(1.2345), "$1.23");
  assert.equal(Fmt.formatUsd(1234.5), "$1,235");
});

test("percent and delta agree on rounding", () => {
  assert.equal(Fmt.formatPercent(0), "0%");
  assert.equal(Fmt.formatPercent(0.5), "50%");
  assert.equal(Fmt.formatPercent(0.1234), "12.3%");
  assert.equal(Fmt.formatPercent(0.0001), "<0.1%");

  assert.deepEqual(Fmt.formatDelta(110, 100), { pct: 10, direction: "up" });
  assert.deepEqual(Fmt.formatDelta(90, 100), { pct: -10, direction: "down" });
  assert.deepEqual(Fmt.formatDelta(100, 100), { pct: 0, direction: "flat" });
  assert.deepEqual(Fmt.formatDelta(5, 0), { pct: null, direction: null });
});

test("bucket labels follow the bucket width", () => {
  const day = new Date(2026, 9, 2, 14, 30, 0).getTime();
  assert.equal(Fmt.formatBucketLabel(day, "day"), "10/2");
  assert.equal(Fmt.formatBucketLabel(day, "hour"), "14:00");
  assert.equal(Fmt.formatBucketLabel(day, "month"), "2026-10");
  assert.equal(Fmt.formatDayKey(day), "2026-10-02");
  assert.equal(Fmt.formatDateTime(0, "zh"), "");
  assert.ok(Fmt.formatDateTime(day, "en").length > 0);
});
