"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const { RecordStore } = require("../src/lib/store.js");
const { scanRoot, scanFile, readFrom, listSessionFiles } = require("../src/lib/scan.js");
const cliAdapter = require("../src/adapters/cli.js");
const desktopAdapter = require("../src/adapters/desktop.js");
const { makeTempDir, copyFixture } = require("./helpers.js");

const CLI_FILE = path.join("sessions", "--D--demo--", "2026-10-01T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl");
const DESKTOP_FILE = path.join("sessions", "22222222-2222-4222-8222-222222222222.jsonl");

/**
 * @param {string} root
 */
async function setup(root) {
  const tmp = await makeTempDir();
  const cliRoot = path.join(tmp, "cli");
  const desktopRoot = path.join(tmp, "desktop");
  await copyFixture("cli", cliRoot);
  await copyFixture("desktop", desktopRoot);
  const store = new RecordStore({ dir: path.join(tmp, "cache") });
  await store.load();
  return { tmp, cliRoot, desktopRoot, store };
}

test("a cold scan reads both roots and a warm scan skips everything", async () => {
  const { cliRoot, desktopRoot, store } = await setup();

  const cold = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(cold.totalFiles, 1);
  assert.equal(cold.scannedFiles, 1);
  assert.equal(cold.appendedRecords, 4);
  assert.equal(cold.errors.length, 1, "the broken line is reported, not fatal");

  const first = await scanRoot({ root: desktopRoot, source: "desktop", adapter: desktopAdapter, store });
  assert.equal(first.appendedRecords, 3);
  assert.equal(store.size, 7);

  const warmCli = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  const warmDesktop = await scanRoot({ root: desktopRoot, source: "desktop", adapter: desktopAdapter, store });
  assert.equal(warmCli.skippedFiles, 1);
  assert.equal(warmDesktop.skippedFiles, 1);
  assert.equal(warmCli.appendedRecords + warmDesktop.appendedRecords, 0);
  assert.equal(store.size, 7);
});

test("an appended line is read incrementally, without reparsing the file", async () => {
  const { cliRoot, store } = await setup();
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(store.size, 4);

  const target = path.join(cliRoot, CLI_FILE);
  const extra = {
    type: "message",
    id: "a6",
    message: {
      role: "assistant",
      provider: "acme",
      model: "m4",
      usage: { input: 11, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0002 } },
      timestamp: 1790849280000,
    },
  };
  await fs.appendFile(target, `${JSON.stringify(extra)}\n`, "utf8");

  const incremental = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(incremental.appendedRecords, 1);
  assert.equal(store.size, 5);
  assert.ok(store.all().some((record) => record.entryId === "a6" && record.totalTokens === 12));
  assert.equal(store.invalidLines, 0);
});

test("a truncated file drops its stale records instead of double counting", async () => {
  const { cliRoot, store } = await setup();
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(store.size, 4);

  const target = path.join(cliRoot, CLI_FILE);
  const header = '{"type":"session","version":3,"id":"11111111-1111-4111-8111-111111111111","cwd":"D:\\\\demo"}';
  const single =
    '{"type":"message","id":"only","message":{"role":"assistant","provider":"acme","model":"m1","usage":{"input":9,"output":1,"cost":{"total":0.0001}},"timestamp":1790848806000}}';
  await fs.writeFile(target, `${header}\n${single}\n`, "utf8");

  const rescanned = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(store.size, 1);
  assert.equal(rescanned.appendedRecords, 1);
  const [record] = store.all();
  assert.equal(record.totalTokens, 10);
});

test("a deleted session file retires its records on the next complete pass", async () => {
  const { desktopRoot, store } = await setup();
  await scanRoot({ root: desktopRoot, source: "desktop", adapter: desktopAdapter, store });
  assert.equal(store.size, 3);

  await fs.rm(path.join(desktopRoot, DESKTOP_FILE));
  const after = await scanRoot({ root: desktopRoot, source: "desktop", adapter: desktopAdapter, store });
  assert.equal(after.partial, false);
  assert.equal(store.size, 0);
});

test("the scan budget stops the pass early without marking the data partial", async () => {
  const { cliRoot, desktopRoot, store } = await setup();
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  await scanRoot({ root: desktopRoot, source: "desktop", adapter: desktopAdapter, store });

  const outOfTime = await scanRoot({
    root: cliRoot,
    source: "cli",
    adapter: cliAdapter,
    store,
    budgetMs: 0,
    startedAt: Date.now(),
  });
  assert.equal(outOfTime.budgetExhausted, true);
  // A budget stop is retryable, so it must not be confused with "unreadable":
  // only the second flag may keep the view retrying.
  assert.equal(outOfTime.partial, false);
  assert.equal(outOfTime.scannedFiles, 0);
});

test("the cache survives a reload from disk", async () => {
  const { cliRoot, store, tmp } = await setup();
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  await store.flush({ scannedAt: 123 });

  const reloaded = new RecordStore({ dir: path.join(tmp, "cache") });
  await reloaded.load();
  assert.equal(reloaded.size, store.size);
  assert.equal(reloaded.scannedAt, 123);
  const stateKey = [...reloaded.files.keys()].find((key) => key.startsWith("cli|"));
  assert.ok(stateKey);
  assert.equal(reloaded.fileState(stateKey).sessionId, "11111111-1111-4111-8111-111111111111");
});

test("listSessionFiles ignores non-jsonl files and hidden entries", async () => {
  const { cliRoot } = await setup();
  await fs.writeFile(path.join(cliRoot, "sessions", "notes.txt"), "ignored", "utf8");
  await fs.writeFile(path.join(cliRoot, "sessions", ".hidden.jsonl"), "{}\n", "utf8");
  const files = await listSessionFiles(cliRoot);
  assert.equal(files.length, 1);
  assert.ok(files[0].path.endsWith(".jsonl"));
});

test("a larger replacement file drops the records of the content it replaced", async () => {
  const { cliRoot, store } = await setup();
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(store.size, 4);

  // Same path, different session, and deliberately bigger than the original so
  // "the file grew" cannot be mistaken for "the file was appended to".
  const padding = "x".repeat(200);
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "33333333-3333-4333-8333-333333333333",
    timestamp: "2026-10-05T10:00:00.000Z",
    cwd: "D:\\demo",
  });
  const line = (index) =>
    JSON.stringify({
      type: "message",
      id: `b${index}`,
      timestamp: "2026-10-05T10:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: padding }],
        provider: "acme",
        model: "m9",
        usage: { input: index, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: index },
      },
    });
  const body = `${header}\n${Array.from({ length: 10 }, (_unused, index) => line(index + 1)).join("\n")}\n`;
  const target = path.join(cliRoot, CLI_FILE);
  await fs.writeFile(target, body, "utf8");
  assert.ok(Buffer.byteLength(body) > 1000, "the replacement must be larger than the fixture");

  const rescanned = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(rescanned.scannedFiles, 1);
  assert.equal(store.size, 10, "the replaced content is gone, not added to");
  const tokens = store.all().reduce((sum, record) => sum + record.totalTokens, 0);
  assert.equal(tokens, 55);
  assert.deepEqual(
    [...new Set(store.all().map((record) => record.sessionId))],
    ["33333333-3333-4333-8333-333333333333"],
  );
});

test("a torn trailing line is read exactly once, after it is completed", async () => {
  const { cliRoot, store } = await setup();
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(store.size, 4);

  const target = path.join(cliRoot, CLI_FILE);
  const whole =
    '{"type":"message","id":"a6","timestamp":"2026-10-01T10:08:00.000Z","message":{"role":"assistant","provider":"acme","model":"m1","usage":{"input":11,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":11}}}\n';
  const split = Math.floor(whole.length / 2);
  await fs.appendFile(target, whole.slice(0, split), "utf8");

  const torn = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(torn.appendedRecords, 0, "half a line is never parsed");
  assert.equal(store.size, 4);

  const again = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(again.appendedRecords, 0, "the same torn line must not be reparsed as new");
  assert.equal(store.size, 4);

  await fs.appendFile(target, whole.slice(split), "utf8");
  const completed = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(completed.appendedRecords, 1);
  assert.equal(store.size, 5);

  const settled = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(settled.appendedRecords, 0);
  assert.equal(store.size, 5);
});

test("a junction inside the root keeps the pass partial instead of retiring it", async (t) => {
  const { cliRoot, store } = await setup();
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(store.size, 4);

  const sessions = path.join(cliRoot, "sessions");
  const realDir = path.join(sessions, "--D--demo--");
  const movedDir = path.join(cliRoot, "moved-away");
  await fs.rename(realDir, movedDir);
  try {
    await fs.symlink(movedDir, realDir, "junction");
  } catch {
    await fs.rename(movedDir, realDir);
    t.skip("this platform cannot create a junction");
    return;
  }

  const linked = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(linked.partial, true, "something the pass could not list must be reported");
  assert.equal(store.size, 4, "records behind the link are kept, never retired");
});

/**
 * A CLI session file with one header line and 1200 usage lines, big enough for
 * the in-file budget check to fire more than once.
 * @param {string} filePath
 */
async function writeLargeSession(filePath) {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    timestamp: "2026-10-01T10:00:00.000Z",
    cwd: "D:\\demo",
  });
  const line = (index) =>
    JSON.stringify({
      type: "message",
      id: `m${index}`,
      timestamp: "2026-10-01T10:00:00.000Z",
      message: {
        role: "assistant",
        provider: "acme",
        model: "m1",
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
      },
    });
  const lines = [header, ...Array.from({ length: 1200 }, (_unused, index) => line(index))];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

test("readFrom stops between lines and reports an exact resumable cursor", async () => {
  const tmp = await makeTempDir();
  const filePath = path.join(tmp, "big.jsonl");
  await writeLargeSession(filePath);

  let seen = 0;
  let asked = 0;
  const first = await readFrom(
    filePath,
    0,
    () => {
      seen += 1;
    },
    () => {},
    () => {
      asked += 1;
      return true;
    },
  );
  assert.equal(asked, 1, "the budget is polled once per batch of lines");
  assert.equal(first.stopped, true);
  assert.equal(seen, 512);

  // The cursor must land on a line boundary, so resuming repeats nothing.
  const bytes = await fs.readFile(filePath);
  assert.equal(bytes[first.offset - 1], 0x0a);
  const resumed = [];
  const second = await readFrom(filePath, first.offset, (line) => resumed.push(line));
  assert.equal(second.stopped, false);
  assert.equal(resumed.length, 1201 - 512);
  assert.ok(resumed[0].includes('"m511"'));
});

test("a stopped file keeps its cursor and finishes on the next pass", async () => {
  const tmp = await makeTempDir();
  const filePath = path.join(tmp, "big.jsonl");
  await writeLargeSession(filePath);
  const store = new RecordStore({ dir: path.join(tmp, "cache") });
  await store.load();
  const stat = await fs.stat(filePath);
  const file = { path: filePath, size: stat.size, mtimeMs: stat.mtimeMs };

  let asked = 0;
  const first = await scanFile({
    file,
    source: "cli",
    adapter: cliAdapter,
    store,
    shouldStop: () => {
      asked += 1;
      return asked >= 1;
    },
  });
  assert.equal(first.stopped, true);
  const state = store.fileState(`cli|${filePath}`);
  assert.equal(state.incomplete, true, "an unfinished file must be revisited");
  assert.ok(state.offset > 0, "the cursor advanced past the lines it did read");
  assert.ok(store.size > 0 && store.size < 1200);

  // Same size and mtime: only the `incomplete` flag can force the second pass.
  const second = await scanFile({ file, source: "cli", adapter: cliAdapter, store, shouldStop: () => false });
  assert.equal(second.stopped, false);
  assert.equal(store.fileState(`cli|${filePath}`).incomplete, false);
  assert.equal(store.size, 1200, "every usage line is counted exactly once");
});

test("a directory this pass could not list does not freeze retirement elsewhere", async (t) => {
  const { cliRoot, store } = await setup();
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(store.size, 4);

  const sessions = path.join(cliRoot, "sessions");
  const realDir = path.join(sessions, "--D--demo--");
  const movedDir = path.join(cliRoot, "moved-away");
  await fs.rename(realDir, movedDir);
  try {
    await fs.symlink(movedDir, realDir, "junction");
  } catch {
    await fs.rename(movedDir, realDir);
    t.skip("this platform cannot create a junction");
    return;
  }

  // A brand-new session root sibling that disappears: its records must still be
  // retired even though the junction keeps `partial` true.
  const extraDir = path.join(cliRoot, "extra");
  await fs.mkdir(extraDir, { recursive: true });
  const extraFile = path.join(extraDir, "extra.jsonl");
  await writeLargeSession(extraFile);
  await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  const withExtra = store.size;
  assert.ok(withExtra > 4, "the extra session was picked up");

  await fs.rm(extraDir, { recursive: true, force: true });
  const after = await scanRoot({ root: cliRoot, source: "cli", adapter: cliAdapter, store });
  assert.equal(after.partial, true, "the junction still blocks a full listing");
  assert.equal(store.size, 4, "records of the removed extra session are retired");
});
