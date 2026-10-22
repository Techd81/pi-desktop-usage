"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { query, startOfDay, startOfYear, addDays } = require("../src/lib/aggregate.js");
const { makeRecord } = require("./helpers.js");

const NOW = new Date(2026, 9, 22, 15, 30, 0, 0).getTime();
const at = (daysAgo, hour) => {
  const date = new Date(addDays(startOfDay(NOW), -daysAgo));
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
};

const records = [
  makeRecord(at(0, 10), { entryId: "today-10", model: "m1" }),
  makeRecord(at(0, 15), { entryId: "today-15", model: "m1", inputTokens: 50, outputTokens: 5 }),
  makeRecord(at(1, 12), { entryId: "day-1", model: "m2" }),
  makeRecord(at(5, 9), { entryId: "day-5", model: "m2" }),
  makeRecord(at(9, 9), { entryId: "day-9", model: "m2" }),
  makeRecord(at(30, 9), { entryId: "day-30", model: "m3", source: "desktop", projectPath: "D:\\proj" }),
];

test("today: hourly buckets, local midnight boundary and a previous-day comparison", () => {
  const result = query(records, { range: "today", nowMs: NOW });

  assert.equal(result.fromMs, startOfDay(NOW));
  assert.equal(result.bucket, "hour");
  assert.equal(result.series.length, 16, "hours 00:00 through 15:00");

  assert.equal(result.series[10].total, 110);
  assert.equal(result.series[15].total, 55);
  assert.equal(result.series[12].total, 0);
  assert.equal(result.series[10].requests, 1);
  assert.equal(result.series[15].requests, 1);
  assert.equal(result.series[12].requests, 0);
  assert.equal(
    result.series.reduce((sum, point) => sum + point.requests, 0),
    result.totals.requests,
    "per-bucket requests add up to the range total",
  );

  assert.equal(result.totals.tokens, 165);
  assert.equal(result.totals.requests, 2);
  assert.equal(result.previous.tokens, 110, "yesterday 12:00 is the previous window");
});

test("7d: daily buckets cover today and the six days before it", () => {
  const result = query(records, { range: "7d", nowMs: NOW });

  assert.equal(result.bucket, "day");
  assert.equal(result.series.length, 7);
  assert.equal(result.totals.tokens, 110 + 55 + 110 + 110, "day-9 falls outside the window");
  assert.equal(result.previous.tokens, 110, "day-9 is the previous window");
});

test("all: starts at the earliest record and stays on daily buckets", () => {
  const result = query(records, { range: "all", nowMs: NOW });
  assert.equal(result.fromMs, startOfDay(at(30, 9)));
  assert.equal(result.bucket, "day");
  assert.equal(result.series.length, 31);
  assert.equal(result.totals.tokens, 110 + 55 + 110 + 110 + 110 + 110);
  assert.equal(result.previous.tokens, 0);
});

test("source filter narrows every aggregate", () => {
  const result = query(records, { range: "all", sources: ["desktop"], nowMs: NOW });
  assert.equal(result.totals.tokens, 110);
  assert.equal(result.bySource.length, 1);
  assert.equal(result.bySource[0].source, "desktop");
  assert.equal(result.byModel.length, 1);
  assert.equal(result.byModel[0].model, "m3");
});

test("a record without a price keeps its tokens and flags the cost as incomplete", () => {
  const withGap = [
    ...records,
    makeRecord(at(0, 11), { entryId: "gap", costUsd: null, costStatus: "unknown" }),
  ];
  const result = query(withGap, { range: "today", nowMs: NOW });

  assert.equal(result.totals.tokens, 165 + 110);
  assert.equal(result.totals.costComplete, false);
  assert.equal(result.totals.costMissing, 1);
  assert.ok(Math.abs(result.totals.cost - 0.002) < 1e-9);
});

test("model and project rankings group by source and carry average cost", () => {
  const mixed = [
    makeRecord(at(0, 10), { entryId: "a", model: "m1", costUsd: 0.002, projectPath: "D:\\alpha" }),
    makeRecord(at(0, 11), { entryId: "b", model: "m1", costUsd: 0.004, projectPath: "D:\\alpha" }),
    makeRecord(at(0, 12), {
      entryId: "c",
      model: "m1",
      source: "desktop",
      provider: "prov-1",
      projectPath: null,
    }),
  ];
  const result = query(mixed, { range: "today", nowMs: NOW });

  assert.equal(result.byModel.length, 2, "the same model on two sources is two rows");
  const cliRow = result.byModel.find((row) => row.source === "cli");
  assert.equal(cliRow.requests, 2);
  assert.ok(Math.abs(cliRow.avgCost - 0.003) < 1e-9);

  const projectRow = result.byProject.find((row) => row.projectPath === "D:\\alpha");
  assert.equal(projectRow.projectName, "alpha");
  assert.equal(projectRow.requests, 2);
  assert.ok(result.byProject.some((row) => row.projectPath === null));
});

test("heatmap covers the current year to date", () => {
  // 295 is counted by hand, not recomputed from the helpers under test: 2026 is a
  // common year, so Jan 1 → Oct 22 is 31+28+31+30+31+30+31+31+30 days plus one
  // inclusive day. A drift in `startOfYear` or in the daily loop then fails here
  // instead of agreeing with itself.
  const EXPECTED_DAYS = 295;
  const result = query(records, { range: "7d", nowMs: NOW });
  assert.equal(result.heatmap.length, EXPECTED_DAYS);
  assert.equal(result.heatmap[EXPECTED_DAYS - 1].dateMs, startOfDay(NOW));
  assert.equal(result.heatmap[EXPECTED_DAYS - 1].tokens, 165);
  assert.equal(result.heatmap[EXPECTED_DAYS - 1].requests, 2);
  assert.equal(result.heatmap[EXPECTED_DAYS - 1].cost, 0.002);
  assert.equal(result.heatmap[EXPECTED_DAYS - 1].costComplete, true);
  assert.equal(result.heatmap[0].requests, 0, "a quiet day stays at zero");
});

test("a heatmap day carries the models behind it, largest first", () => {
  const many = [
    makeRecord(at(0, 9), { entryId: "big-1", model: "big", inputTokens: 500 }),
    makeRecord(at(0, 10), { entryId: "big-2", model: "big", inputTokens: 500 }),
    makeRecord(at(0, 11), { entryId: "mid", model: "mid", inputTokens: 300 }),
    makeRecord(at(0, 12), { entryId: "third", model: "third", inputTokens: 200 }),
    makeRecord(at(0, 13), { entryId: "t4", model: "t4", inputTokens: 100 }),
    makeRecord(at(0, 14), { entryId: "t5", model: "t5", inputTokens: 50 }),
    makeRecord(at(0, 15), { entryId: "t6", model: "t6", inputTokens: 10 }),
  ];
  const result = query(many, { range: "7d", nowMs: NOW });
  const day = result.heatmap[result.heatmap.length - 1];

  assert.equal(day.models.length, 5, "five rows per square, the rest fold into a remainder");
  assert.equal(day.models[0].model, "big", "largest model first");
  assert.equal(day.models[0].tokens, 1020);
  assert.equal(day.otherTokens, 20, "the tail is kept, not dropped");
  assert.equal(
    day.models.reduce((sum, row) => sum + row.tokens, 0) + day.otherTokens,
    day.tokens,
    "rows and remainder add up to the day",
  );
  assert.deepEqual(result.heatmap[0].models, [], "a quiet day lists nothing");
});

test("an empty dataset still returns usable zeroed buckets", () => {
  const result = query([], { range: "7d", nowMs: NOW });
  assert.equal(result.series.length, 7);
  assert.equal(result.totals.tokens, 0);
  assert.equal(result.totals.costComplete, true);
  assert.equal(result.byModel.length, 0);
  assert.equal(result.heatmap.length, 295);
});

test("an explicit window of two days or less is bucketed by hour", () => {
  const fromMs = new Date(2026, 9, 22, 9, 0, 0).getTime();
  const toMs = new Date(2026, 9, 22, 12, 0, 0).getTime();
  const result = query(records, { range: "custom", fromMs, toMs, nowMs: NOW });

  assert.equal(result.bucket, "hour");
  assert.equal(result.fromMs, fromMs);
  assert.equal(result.toMs, toMs);
  // 09:00, 10:00, 11:00, 12:00 — four inclusive hourly buckets.
  assert.equal(result.series.length, 4);
  assert.equal(result.totals.tokens, 110, "only the 10:00 record is inside 09:00-12:00");
});

test("an explicit multi-day window stays on daily buckets", () => {
  const fromMs = new Date(2026, 9, 15, 0, 0, 0).getTime();
  const toMs = new Date(2026, 9, 22, 0, 0, 0).getTime();
  const result = query(records, { range: "custom", fromMs, toMs, nowMs: NOW });
  assert.equal(result.bucket, "day");
  // 15, 16, 17, 18, 19, 20, 21 and 22 October — eight inclusive daily buckets.
  assert.equal(result.series.length, 8);
});

test("today compares against an equal-length previous window", () => {
  const early = makeRecord(at(1, 8), { entryId: "prev-early", inputTokens: 500, outputTokens: 0 });
  const inside = makeRecord(at(1, 12), { entryId: "prev-noon", inputTokens: 100, outputTokens: 10 });
  const result = query([early, inside], { range: "today", nowMs: NOW });

  // NOW is 15:30, so the baseline is yesterday 08:30-24:00, not the whole day:
  // the 08:00 record stays outside it and only the 12:00 one is counted.
  assert.equal(result.previous.tokens, 110);
  assert.equal(result.totals.tokens, 0);
});

test("a two-day custom window keeps every hourly bucket", () => {
  const fromMs = new Date(2026, 9, 20, 9, 30, 0).getTime();
  const toMs = new Date(2026, 9, 22, 9, 30, 0).getTime();
  const result = query([], { range: "custom", fromMs, toMs, nowMs: NOW });

  assert.equal(result.bucket, "hour");
  assert.equal(result.series.length, 49, "09:00 on the 20th through 09:00 on the 22nd");
  const last = result.series[result.series.length - 1];
  assert.ok(last.startMs <= toMs && last.startMs > toMs - 3600000, "the newest hour is bucketed");
});

test("a custom window longer than a year switches to month buckets", () => {
  const fromMs = new Date(2024, 0, 1).getTime();
  const toMs = new Date(2026, 9, 22).getTime();
  const result = query([], { range: "custom", fromMs, toMs, nowMs: NOW });

  assert.equal(result.bucket, "month");
  assert.equal(result.series[0].startMs, fromMs);
  assert.equal(result.series.length, 34, "January 2024 through October 2026");
  assert.ok(result.series[result.series.length - 1].startMs <= toMs);
});
