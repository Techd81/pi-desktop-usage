"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

/**
 * File names from the zip central directory.
 * @param {Buffer} bytes
 * @returns {string[]}
 */
function zipNames(bytes) {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    names.push(bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

/**
 * The shipped surface, spelled out. Re-counting whatever `collectFiles` returns
 * would pass even after a blacklist change started shipping tests, editor state
 * or build output.
 */
const EXPECTED_FILES = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "main.js",
  "manifest.json",
  "package.json",
  "src/adapters/cli.js",
  "src/adapters/desktop.js",
  "src/backend.js",
  "src/lib/aggregate.js",
  "src/lib/enrich.js",
  "src/lib/format.js",
  "src/lib/normalize.js",
  "src/lib/paths.js",
  "src/lib/scan.js",
  "src/lib/store.js",
  "views/app.js",
  "views/assets/README.md",
  "views/assets/icon.png",
  "views/assets/pi-cli.svg",
  "views/assets/pi-desktop.png",
  "views/index.html",
  "views/lib/format.js",
  "views/styles.css",
];

test("pack writes a store-only zip named after id and version", async () => {
  const { packPlugin, collectFiles } = await import("../scripts/pack.mjs");
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-usage-pack-"));
  const result = await packPlugin(ROOT, { outDir });

  // Derived from the manifest: a hand-written version here fails on every bump
  // without saying anything about the packer.
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(result.fileName, `${manifest.id}-${manifest.version}.piplug`);
  assert.match(result.shasum, /^[0-9a-f]{64}$/);
  assert.equal(result.fileCount, EXPECTED_FILES.length);

  const bytes = await fs.readFile(result.packagePath);
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "end of central directory present");
  assert.equal(bytes.readUInt16LE(eocd + 10), result.fileCount);

  // Read the names back from the archive: string-matching the raw blob would not
  // notice a backslash separator or a duplicated entry.
  assert.deepEqual(zipNames(bytes), EXPECTED_FILES);

  const packaged = await collectFiles(ROOT);
  assert.deepEqual(packaged, EXPECTED_FILES);
  assert.equal(packaged.length, result.fileCount);
  for (const prefix of ["test/", "scripts/", "dist/", ".git/"]) {
    assert.ok(!packaged.some((file) => file.startsWith(prefix)), `${prefix} is not packaged`);
  }
});

test("pack refuses a manifest whose view entry is missing", async () => {
  const { validateManifest } = await import("../scripts/pack.mjs");
  const problems = await validateManifest(
    {
      schemaVersion: 1,
      id: "io.github.techd81.broken",
      name: "Broken",
      version: "0.1.0",
      description: "x",
      main: "main.js",
      engines: { piDesktop: ">=0.20.1" },
      permissions: ["ui.view"],
      contributes: { views: [{ id: "usage", entry: "views/missing.html", title: { en: "x" } }] },
    },
    ROOT,
  );
  assert.ok(problems.some((problem) => problem.includes("views/missing.html")));
});
