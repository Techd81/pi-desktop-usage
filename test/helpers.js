"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createRecord } = require("../src/lib/normalize.js");

const FIXTURES = path.join(__dirname, "fixtures");

/** @returns {Promise<string>} a fresh temporary directory */
async function makeTempDir(prefix = "pi-desktop-usage-") {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Copy a fixture tree into `dest` so a test may append to it freely.
 * @param {string} name
 * @param {string} dest
 */
async function copyFixture(name, dest) {
  await fs.mkdir(dest, { recursive: true });
  await fs.cp(path.join(FIXTURES, name), dest, { recursive: true });
}

/**
 * @param {string} name
 * @returns {Promise<string>}
 */
async function readFixture(name) {
  return await fs.readFile(path.join(FIXTURES, name), "utf8");
}

/**
 * Build a canonical record for aggregate tests.
 *
 * @param {number} timestampMs
 * @param {Partial<{ source: string, sessionId: string, entryId: string, provider: string, model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, costUsd: number | null, costStatus: string, projectPath: string | null, kind: "assistant" | "summary" }>} [overrides]
 */
function makeRecord(timestampMs, overrides = {}) {
  const record = createRecord({
    source: overrides.source === "desktop" ? "desktop" : "cli",
    sessionId: overrides.sessionId ?? "session-1",
    entryId: overrides.entryId ?? `entry-${timestampMs}-${Math.random().toString(16).slice(2)}`,
    timestampMs,
    provider: overrides.provider ?? "acme",
    model: overrides.model ?? "m1",
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 10,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    costUsd: overrides.costUsd === undefined ? 0.001 : overrides.costUsd,
    costStatus: overrides.costStatus ?? "recorded",
    projectPath: overrides.projectPath === undefined ? null : overrides.projectPath,
    kind: overrides.kind ?? "assistant",
  });
  if (!record) throw new Error("makeRecord produced an empty record");
  return record;
}

module.exports = { FIXTURES, makeTempDir, copyFixture, readFixture, makeRecord };
