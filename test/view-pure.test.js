"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const panel = require("../views/app.js");

test("shares are clamped and safe against a zero denominator", () => {
  assert.equal(panel.shareOf(50, 100), 0.5);
  assert.equal(panel.shareOf(150, 100), 1);
  assert.equal(panel.shareOf(-5, 100), 0);
  assert.equal(panel.shareOf(5, 0), 0);
  assert.equal(panel.shareOf(Number.NaN, 100), 0);
});

test("line and area paths use the full plot box", () => {
  assert.equal(panel.linePath([], 100, 50, 10), "");
  assert.equal(panel.linePath([10, 0], 100, 50, 10), "M0.00,0.00 L100.00,50.00");
  assert.equal(panel.linePath([5], 100, 50, 10), "M50.00,25.00");
  assert.match(panel.areaPath([10, 5], 100, 50, 10), /^M0\.00,0\.00 L100\.00,25\.00 L100\.00,50\.00 L0,50\.00 Z$/);
});

test("pointer mapping picks the nearest bucket and clamps at the edges", () => {
  assert.equal(panel.indexAt(-20, 200, 5), 0);
  assert.equal(panel.indexAt(0, 200, 5), 0);
  assert.equal(panel.indexAt(100, 200, 5), 2);
  assert.equal(panel.indexAt(200, 200, 5), 4);
  assert.equal(panel.indexAt(500, 200, 5), 4);
  assert.equal(panel.indexAt(50, 0, 5), 0);
});

test("donut segments tile the whole circumference", () => {
  const circumference = 2 * Math.PI * 70;
  const segments = panel.donutGeometry([1, 1, 2], circumference);
  assert.equal(segments.length, 3);
  assert.ok(Math.abs(segments.reduce((sum, segment) => sum + segment.length, 0) - circumference) < 1e-6);
  assert.equal(segments[0].fraction, 0.25);
  assert.equal(segments[1].dashoffset.toFixed(3), (-segments[0].length).toFixed(3));
  assert.match(segments[2].dasharray, /^\d+\.\d{3} \d+\.\d{3}$/);

  const empty = panel.donutGeometry([0, 0], 100);
  assert.equal(empty[0].fraction, 0);
  assert.equal(empty[0].length, 0);
});

test("heat levels spread values over five steps", () => {
  assert.deepEqual(panel.heatLevels([0, 0, 0]), [0, 0, 0]);
  // Quartiles of the five active days, not fractions of the biggest one.
  assert.deepEqual(panel.heatLevels([10, 40, 60, 80, 100]), [1, 1, 2, 3, 4]);
  assert.deepEqual(panel.heatLevels([7, 7, 7]), [4, 4, 4], "nothing to rank, one real tone");
});

test("one runaway day does not flatten the rest of the year", () => {
  // 39 ordinary days and one that is ~800x the median, the case a real user hit.
  const values = Array.from({ length: 40 }, (_unused, index) => 1_000_000 + index * 10_000);
  values[7] = 828_000_000;
  const levels = panel.heatLevels(values);
  const counts = [0, 0, 0, 0, 0];
  for (const level of levels) counts[level] += 1;

  assert.equal(levels[7], 4, "the spike keeps the darkest step");
  assert.deepEqual(counts, [0, 10, 10, 10, 10], "the ordinary days still fill every step");
});

test("heat levels ignore blanks and junk", () => {
  const levels = panel.heatLevels([0, Number.NaN, -5, 3, 9]);
  assert.deepEqual(levels.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(levels.slice(3), [1, 4], "two active days rank end to end");
});

test("axis ticks stay inside the series", () => {
  assert.deepEqual(panel.tickIndices(0, 8), []);
  assert.deepEqual(panel.tickIndices(3, 8), [0, 1, 2]);
  const ticks = panel.tickIndices(31, 8);
  assert.equal(ticks.length, 8);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 30);
  assert.deepEqual([...ticks].sort((a, b) => a - b), ticks);
});

test("escaping neutralises markup in user controlled strings", () => {
  assert.equal(panel.esc('<img src=x onerror="1">'), "&lt;img src=x onerror=&quot;1&quot;&gt;");
  assert.equal(panel.esc("a&b"), "a&amp;b");
  assert.equal(panel.esc(null), "");
});

test("translations fall back to Chinese and interpolate variables", () => {
  assert.equal(panel.t("zh", "metricCost"), "总成本");
  assert.equal(panel.t("en", "metricCost"), "Total cost");
  assert.equal(panel.t("xx", "metricCost"), "总成本");
  assert.equal(panel.t("en", "missing-key"), "missing-key");
  assert.equal(panel.t("zh", "trendTitle", { range: "7D" }), "7D 趋势");
  assert.equal(panel.t("en", "trendTitle", { range: "7D" }), "7D trend");
  assert.equal(panel.t("zh", "trendTitle", { unused: 1 }), "{range} 趋势");
});

test("bar layout keeps every bar inside its slot", () => {
  assert.deepEqual(panel.barLayout(0, 300), { slot: 0, width: 0 });
  const wide = panel.barLayout(3, 300);
  assert.equal(wide.slot, 100);
  assert.equal(wide.width, 26);
  const tight = panel.barLayout(30, 300);
  assert.ok(tight.width >= 2 && tight.width < 10);
});

test("month headers land on the week column that starts the month", () => {
  const days = Array.from({ length: 40 }, (_, index) => ({
    dateMs: new Date(2026, 0, 1 + index).getTime(),
    tokens: index,
  }));
  const { leading, starts } = panel.monthStarts(days);
  assert.equal(leading, 4, "2026-01-01 is a Thursday");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].week, 0);
  assert.equal(starts[1].week, Math.floor((4 + 31) / 7));
  assert.deepEqual(panel.monthStarts([]), { leading: 0, starts: [] });
});

test("asset URLs are derived from the panel script location", () => {
  assert.equal(panel.assetBaseFrom("file:///D:/p/views/app.js"), "file:///D:/p/views/assets/");
  assert.equal(panel.assetBaseFrom("https://host/plugins/x/views/app.js"), "https://host/plugins/x/views/assets/");
  assert.equal(panel.assetBaseFrom("./app.js"), "./assets/");
  assert.equal(panel.assetBaseFrom("app.js"), "./assets/");
  assert.equal(panel.assetBaseFrom(""), "./assets/");
});

test("local date inputs round-trip through datetime-local text", () => {
  const midnight = new Date(2026, 9, 22, 0, 0).getTime();
  assert.equal(panel.toLocalInput(midnight), "2026-10-22T00:00");
  assert.equal(panel.toLocalInput(new Date(2026, 0, 5, 7, 9).getTime()), "2026-01-05T07:09");
  assert.equal(panel.fromLocalInput("2026-10-22T17:45"), new Date(2026, 9, 22, 17, 45).getTime());
  assert.equal(panel.fromLocalInput(panel.toLocalInput(midnight)), midnight);
  assert.equal(panel.fromLocalInput("2026-10-22"), Number.NaN);
  assert.equal(panel.fromLocalInput(""), Number.NaN);
});

test("day helpers stay on local midnight", () => {
  const afternoon = new Date(2026, 9, 22, 17, 45, 30, 400).getTime();
  assert.equal(panel.startOfLocalDay(afternoon), new Date(2026, 9, 22).getTime());
  assert.equal(panel.endOfLocalDay(afternoon), new Date(2026, 9, 22, 23, 59, 59, 999).getTime());
  assert.equal(panel.shiftDays(panel.startOfLocalDay(afternoon), -6), new Date(2026, 9, 16).getTime());
  assert.equal(panel.shiftDays(new Date(2026, 0, 31).getTime(), 1), new Date(2026, 1, 1).getTime());
  assert.equal(
    panel.combineDayWithTime(new Date(2026, 9, 1).getTime(), new Date(2026, 9, 22, 17, 45).getTime()),
    new Date(2026, 9, 1, 17, 45).getTime(),
  );
});

test("the calendar grid covers six aligned week rows", () => {
  const cells = panel.monthGrid(new Date(2026, 9, 15).getTime());
  assert.equal(cells.length, 42);
  assert.equal(new Date(cells[0].dateMs).getDay(), 0, "the grid starts on a Sunday");
  assert.equal(new Date(cells[6].dateMs).getDay(), 6, "and every row ends on a Saturday");
  assert.equal(cells[0].dateMs, new Date(2026, 8, 27).getTime(), "2026-10-01 is a Thursday");
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[4].dateMs, new Date(2026, 9, 1).getTime());
  assert.equal(cells[4].inMonth, true);
  assert.equal(cells.filter((cell) => cell.inMonth).length, 31);
  cells.forEach((cell) => assert.equal(new Date(cell.dateMs).getHours(), 0));
});

test("picker presets resolve to explicit windows", () => {
  const now = new Date(2026, 9, 22, 17, 45).getTime();
  assert.deepEqual(panel.presetWindow("all", now), { range: "all", fromMs: 0, toMs: 0 });
  assert.deepEqual(panel.presetWindow("24h", now), { range: "custom", fromMs: now - 86400000, toMs: now });
  assert.deepEqual(panel.presetWindow("today", now), {
    range: "custom",
    fromMs: new Date(2026, 9, 22).getTime(),
    toMs: now,
  });
  assert.equal(panel.presetWindow("7d", now).fromMs, new Date(2026, 9, 16).getTime());
  assert.equal(panel.presetWindow("14d", now).fromMs, new Date(2026, 9, 9).getTime());
  assert.equal(panel.presetWindow("30d", now).fromMs, new Date(2026, 8, 23).getTime());
  assert.equal(panel.presetWindow("unknown", now).fromMs, new Date(2026, 9, 16).getTime());
  ["today", "24h", "7d", "14d", "30d"].forEach((id) => {
    const window = panel.presetWindow(id, now);
    assert.equal(window.range, "custom");
    assert.ok(window.toMs > window.fromMs, `${id} keeps a positive window`);
  });
});

test("custom range labels describe the window", () => {
  assert.equal(panel.customRangeText(new Date(2026, 9, 1).getTime(), new Date(2026, 9, 7, 23).getTime()), "10/1 – 10/7");
  assert.equal(panel.customRangeText(new Date(2026, 9, 22).getTime(), new Date(2026, 9, 22, 17).getTime()), "10/22");
  assert.equal(panel.customRangeText(0, 0), "");
  assert.equal(panel.customRangeText(new Date(2026, 9, 7).getTime(), new Date(2026, 9, 1).getTime()), "");
});

test("free-form accents accept six digit hex only", () => {
  assert.equal(panel.isHexColor("#7c5cff"), true);
  assert.equal(panel.isHexColor("#7C5CFF"), true);
  assert.equal(panel.isHexColor("#fff"), false);
  assert.equal(panel.isHexColor("7c5cff"), false);
  assert.equal(panel.isHexColor("violet"), false);
  assert.equal(panel.isHexColor(null), false);
});

test("a tiny slice keeps a visible arc without breaking the ring", () => {
  const circumference = 2 * Math.PI * 66;
  const segments = panel.donutGeometry([26000, 35], circumference);

  assert.equal(segments[1].fraction, 35 / 26035);
  assert.ok(segments[1].length >= 4, "0.13% of the ring still renders");
  assert.ok(Math.abs(segments[0].length + segments[1].length - circumference) < 1e-6);

  const zeroed = panel.donutGeometry([26000, 0], circumference);
  assert.equal(zeroed[1].length, 0, "a zero slice stays empty");
  assert.ok(Math.abs(zeroed[0].length - circumference) < 1e-6);
});

test("the smoothed trend path stays inside the plot box", () => {
  assert.equal(panel.smoothPath([], 100, 50, 10), "");
  assert.equal(panel.smoothPath([10], 100, 50, 10), "M50.00,0.00");
  assert.equal(panel.smoothPath([10, 0], 100, 50, 10), "M0.00,0.00 L100.00,50.00");

  const spiky = [0, 0, 100, 0, 0, 40, 0];
  const path = panel.smoothPath(spiky, 320, 200, 100);
  assert.match(path, /^M0\.00,200\.00 C/);
  const numbers = path.match(/-?\d+\.\d{2}/g).map(Number);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  ys.forEach((value) => {
    assert.ok(value >= -0.01 && value <= 200.01, `control point ${value} stays inside the box`);
  });
  assert.match(panel.smoothAreaPath(spiky, 320, 200, 100), / L320\.00,200\.00 L0,200\.00 Z$/);
});

/**
 * Minimal usage payload for the card renderers.
 */
function cardUsage() {
  const row = (extra) => ({
    requests: 1,
    cost: 0.1,
    costComplete: true,
    costMissing: 0,
    ...extra,
  });
  return {
    range: "7d",
    bucket: "day",
    fromMs: new Date(2026, 9, 16).getTime(),
    toMs: new Date(2026, 9, 22, 15).getTime(),
    totals: row({ tokens: 200, requests: 4, cost: 0.4, input: 120, output: 40, cacheRead: 20, cacheWrite: 20 }),
    previous: row({ tokens: 100, cost: 0.2, requests: 2 }),
    series: [],
    heatmap: [],
    bySource: [
      row({ source: "desktop", tokens: 150, requests: 3, cost: 0.3 }),
      row({ source: "cli", tokens: 50, requests: 1, cost: 0.1 }),
    ],
    byProject: [
      row({ projectPath: "D:\\aa", projectName: "aa", source: "cli", tokens: 100 }),
      row({ projectPath: "D:\\bb", projectName: "bb", source: "cli", tokens: 60 }),
      row({ projectPath: "D:\\cc", projectName: "cc", source: "cli", tokens: 30 }),
      row({ projectPath: "D:\\dd", projectName: "dd", source: "cli", tokens: 10 }),
    ],
    byModel: [row({ model: "m1", source: "cli", tokens: 200 })],
  };
}

test("card markup never leaks source code as visible text", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const usage = cardUsage();
  // A stray statement pasted into a template literal renders as text: it is valid
  // JavaScript, so nothing else catches it.
  const forbidden = /=>|\bconst \b|\bfunction \b|\.reduce\(|\breturn \b/;
  for (const name of ["sourceRankCardHtml", "projectRankCardHtml", "metricsHtml"]) {
    const html = view[name](usage);
    const leaked = html.split("\n").filter((line) => forbidden.test(line));
    assert.deepEqual(leaked, [], `${name} rendered code as text`);
    // A dropped closing tag still parses, but it silently reparents the rest of
    // the card: a balanced count is the cheapest way to notice.
    const open = (html.match(/<div\b/g) ?? []).length;
    const close = (html.match(/<\/div>/g) ?? []).length;
    assert.equal(open, close, `${name} has unbalanced div tags`);
    const sections = (html.match(/<section\b/g) ?? []).length;
    const sectionClose = (html.match(/<\/section>/g) ?? []).length;
    assert.equal(sections, sectionClose, `${name} has unbalanced section tags`);
  }
});

test("the project card lists three rows but shares are of the whole window", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const html = view.projectRankCardHtml(cardUsage());

  const rows = html.match(/data-action="rank-row"/g) ?? [];
  assert.equal(rows.length, 3, "only the top three fit on screen");
  // 100 of 200 tokens overall, not 100 of the 190 the three rows add up to.
  assert.ok(html.includes('data-share="50%"'), "the share is of the whole window");
  assert.ok(!html.includes('data-name="dd"'), "the fourth project stays out of the list");
});

test("the source card summarises requests, cost and tokens together", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const html = view.sourceRankCardHtml(cardUsage());
  assert.ok(html.includes("合计"));
  assert.ok(html.includes("4 次请求"), "the summary counts every request");
  assert.ok(html.includes("$0.40"), "exact cost when every row is priced");
  assert.ok(html.includes("200"), "the total token figure is present");
});

/**
 * A full panel payload: every card needs its own data slice to render.
 */
function richUsage() {
  const base = cardUsage();
  const day = (index) => new Date(2026, 9, 1 + index).getTime();
  return {
    ...base,
    meta: { records: 12 },
    series: Array.from({ length: 7 }, (_unused, index) => ({
      startMs: new Date(2026, 9, 16 + index).getTime(),
      key: `k${index}`,
      tokens: 10 + index,
      input: 5,
      output: 2,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.01 * (index + 1),
      requests: 1,
    })),
    heatmap: Array.from({ length: 10 }, (_unused, index) => ({
      dateMs: day(index),
      tokens: index * 10,
      cost: index * 0.01,
      requests: index,
      costComplete: true,
    })),
  };
}

/**
 * Stack-based tag balance check. A dropped closing tag still parses, so nothing
 * else notices that the rest of the card moved somewhere it does not belong.
 * @param {string} html
 * @returns {string[]} problems, empty when balanced
 */
function unbalancedTags(html) {
  const voids = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
    "path", "circle", "line", "rect", "polyline", "polygon", "stop", "use", "ellipse",
  ]);
  const stack = [];
  const problems = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = tag.exec(html)) !== null) {
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (voids.has(name) || match[4] === "/") continue;
    if (closing) {
      const top = stack.pop();
      if (top !== name) problems.push(`</${name}> closes <${top ?? "nothing"}>`);
      continue;
    }
    stack.push(name);
  }
  for (const name of stack) problems.push(`<${name}> is never closed`);
  return problems;
}

test("every card in the panel closes all of its tags", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";

  const html = view.bodyHtml(richUsage());
  assert.deepEqual(unbalancedTags(html), []);
  // The card inventory, so a missing or duplicated section is visible here.
  assert.equal((html.match(/<section class="card/g) ?? []).length, 7, "heatmap, trend, bars, 2 ranks, 2 donuts");
  assert.equal((html.match(/<article class="card metric"/g) ?? []).length, 8);
  assert.equal((html.match(/<section class="metrics"/g) ?? []).length, 1);
  assert.equal((html.match(/<div class="grid-2"/g) ?? []).length, 2);
  assert.equal((html.match(/data-action="rank-row"/g) ?? []).length, 5, "2 sources + 3 projects");
  assert.equal((html.match(/data-action="heat-day"/g) ?? []).length, 10, "one button per heat cell");

  const empty = view.bodyHtml(null);
  assert.deepEqual(unbalancedTags(empty), []);
  assert.ok(empty.includes("empty"), "the no-data state still renders its own block");
});

test("no card renders JavaScript as visible text", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const html = view.bodyHtml(richUsage());
  const forbidden = /=>|\.reduce\(|\bconst \b|\bfunction \b/;
  const leaked = html.split("\n").filter((line) => forbidden.test(line));
  assert.deepEqual(leaked, []);
});

test("every volume card carries a direction pill and paints its mini-trend to match", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";

  const up = view.metricsHtml(richUsage());
  assert.equal(
    (up.match(/class="delta-badge is-up"/g) ?? []).length,
    7,
    "seven volume cards rise against the previous window",
  );
  assert.equal((up.match(/class="delta-badge is-down"/g) ?? []).length, 0);
  assert.ok(up.includes("var(--delta-up)"), "the sparkline repeats the direction");
  assert.ok(up.includes("+120"), "no baseline falls back to the absolute change");
  assert.ok(up.includes('title="较上期 ↑'), "the comparison is spelled out in the title");

  const falling = richUsage();
  falling.totals = {
    ...falling.totals,
    tokens: 50,
    cost: 0.1,
    requests: 1,
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
  };
  falling.previous = {
    ...falling.previous,
    tokens: 200,
    cost: 0.4,
    requests: 4,
    input: 120,
    output: 40,
    cacheRead: 20,
    cacheWrite: 20,
  };
  const down = view.metricsHtml(falling);
  assert.equal((down.match(/class="delta-badge is-down"/g) ?? []).length, 7, "a fall reads as a fall");
  assert.ok(down.includes("var(--delta-down)"));
  assert.deepEqual(unbalancedTags(down), []);
});

test("a hidden slice stops claiming a share instead of showing a dimmed one", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.hidden.clear();
  view.state.hidden.add("source|cli");

  const html = view.bodyHtml(richUsage());
  assert.ok(html.includes("slice-row is-off"), "the row is marked off");
  assert.match(html, /class="pct">—</, "a hidden slice claims no percentage");

  view.state.hidden.clear();
  const restored = view.bodyHtml(richUsage());
  assert.ok(!restored.includes("slice-row is-off"));
});

test("the heat hover card lists the day level and its models with shares", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const html = view.heatTipHtml(
    {
      dateMs: new Date(2026, 7, 2).getTime(),
      tokens: 1000,
      cost: 1,
      requests: 4,
      costComplete: true,
      models: [
        { model: "deepseek-v4-flash", source: "cli", provider: "pi", tokens: 700 },
        { model: "gpt-5.6", source: "desktop", provider: "pi", tokens: 200 },
      ],
      otherTokens: 100,
    },
    2,
  );

  assert.ok(html.includes("2026-08-02"), "the card names the day");
  assert.ok(html.includes("等级 2"));
  assert.ok(html.includes("pi · deepseek-v4-flash"));
  assert.ok(html.includes("70%"), "each row carries its share of the day");
  assert.ok(html.includes("其他模型"), "the tail folds into one row");
  assert.equal((html.match(/tip-model-bar/g) ?? []).length, 3, "one bar per row");
  assert.deepEqual(unbalancedTags(html), []);

  const quiet = view.heatTipHtml({ dateMs: Date.now(), tokens: 0, cost: 0, requests: 0, models: [] }, 0);
  assert.ok(!quiet.includes("模型明细"), "an empty day has no model block");
});
