#!/usr/bin/env node
/**
 * Package the plugin the way PI-Desktop expects: a store-only ZIP named
 * `<id>-<version>.piplug`, whose sha256 is what the marketplace publishes.
 *
 * The host's own packer writes exactly this shape (no compression, UTF-8 names,
 * dot-directories and dependency folders left out), so the file produced here
 * installs the same way a console-built package does.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIPPED_DIRS = new Set(["node_modules", "dist", "test", "coverage", "tmp", "scripts"]);
const SECRET_PATTERNS = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_(rsa|ed25519)$/i, /^secrets?\.json$/i];

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const VIEW_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const SKIPPED_FILES = new Set(["package-lock.json", "tsconfig.json"]);
/**
 * @param {Record<string, any>} manifest
 * @param {string} root
 * @returns {Promise<string[]>} problems (empty means valid)
 */
export async function validateManifest(manifest, root) {
  const problems = [];
  if (!manifest || typeof manifest !== "object") return ["manifest.json is not an object"];
  if (manifest.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (typeof manifest.id !== "string" || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    problems.push("id must match [a-z0-9]+(\\.[a-z0-9_-]+)+");
  }
  for (const key of ["name", "version", "description", "main"]) {
    if (typeof manifest[key] !== "string" || manifest[key] === "") problems.push(`${key} is required`);
  }
  if (typeof manifest.version === "string" && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    problems.push("version must be semver X.Y.Z");
  }
  if (typeof manifest.main === "string") {
    if (path.isAbsolute(manifest.main) || manifest.main.split(/[\\/]/).includes("..")) {
      problems.push("main must be a relative path");
    } else {
      try {
        await readFile(path.join(root, manifest.main));
      } catch {
        problems.push(`main file not found: ${manifest.main}`);
      }
    }
  }
  if (typeof manifest.engines?.piDesktop !== "string") problems.push("engines.piDesktop is required");
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) {
    problems.push("permissions must be a non-empty array");
  }
  if (!manifest.i18n?.en || !manifest.i18n?.["zh-CN"]) problems.push("i18n.en and i18n['zh-CN'] are required");

  const views = manifest.contributes?.views ?? [];
  if (!Array.isArray(views) || views.length === 0) problems.push("contributes.views must not be empty");
  for (const view of views) {
    if (typeof view?.id !== "string" || !VIEW_ID_PATTERN.test(view.id)) problems.push("view id is invalid");
    if (typeof view?.entry !== "string" || view.entry === "") {
      problems.push("view entry is required");
      continue;
    }
    if (path.isAbsolute(view.entry) || view.entry.split(/[\\/]/).includes("..")) {
      problems.push(`view entry must be relative: ${view.entry}`);
      continue;
    }
    try {
      await readFile(path.join(root, view.entry));
    } catch {
      problems.push(`view entry not found: ${view.entry}`);
    }
  }
  return problems;
}

/**
 * @param {string} dir
 * @param {string} [prefix]
 * @returns {Promise<string[]>} relative paths with forward slashes
 */
export async function collectFiles(dir, prefix = "") {
  /** @type {string[]} */
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIPPED_DIRS.has(entry.name)) continue;
    if (SKIPPED_FILES.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path.join(dir, entry.name), relative)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
    files.push(relative);
  }
  return files;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** @param {Buffer} buffer */
export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Store-only ZIP (no compression), the format the host package uses.
 * @param {Array<{ name: string, data: Buffer }>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(size, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * @param {string} root
 * @param {{ outDir?: string }} [options]
 */
export async function packPlugin(root, options = {}) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const problems = await validateManifest(manifest, root);
  if (problems.length > 0) {
    throw new Error(`manifest check failed:\n- ${problems.join("\n- ")}`);
  }

  const files = await collectFiles(root);
  const entries = [];
  for (const relative of files) {
    entries.push({ name: relative, data: await readFile(path.join(root, relative)) });
  }

  const bytes = buildZip(entries);
  const outDir = options.outDir ?? path.join(root, "dist");
  await mkdir(outDir, { recursive: true });
  const fileName = `${manifest.id}-${manifest.version}.piplug`;
  const packagePath = path.join(outDir, fileName);
  await writeFile(packagePath, bytes);

  return {
    packagePath,
    fileName,
    byteLength: bytes.length,
    fileCount: entries.length,
    shasum: createHash("sha256").update(bytes).digest("hex"),
    manifest,
  };
}

const isEntryPoint = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isEntryPoint) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  try {
    const result = await packPlugin(root);
    console.log(`packed ${result.fileCount} files → ${result.packagePath}`);
    console.log(`size ${result.byteLength} bytes`);
    console.log(`sha256 ${result.shasum}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
