"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const manifest = require("../manifest.json");

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const VIEW_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ALLOWED_PERMISSIONS = new Set([
  "ui.panel",
  "keyboard.globalShortcut",
  "ui.view",
  "ui.microphone",
  "ui.theme",
  "ui.settings",
  "ui.window.appearance",
  "clipboard.read",
  "clipboard.write",
  "notify",
  "fs.read",
  "fs.write",
  "fs.delete",
  "agent.tool.register",
  "agent.prompt.inject",
  "agent.complete",
  "composer.transform",
  "agent.extension",
  "renderer.extension",
  "desktop.control",
  "background.service",
  "provider.register",
  "net.fetch",
  "net.websocket",
  "shell.openExternal",
  "models.list",
  "browser.cdp",
  "bus.publish",
]);
const ALLOWED_VIEW_ICONS = new Set([
  "bell",
  "book",
  "bot",
  "branch",
  "browser",
  "chat",
  "clock",
  "diff",
  "files",
  "folder",
  "image",
  "key",
  "link",
  "list-checks",
  "palette",
  "plug",
  "pull-request",
  "search",
  "server",
  "shield",
  "sparkles",
  "target",
  "terminal",
  "workflow",
  "wrench",
]);

test("manifest passes the host's structural rules", () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.id, PLUGIN_ID_PATTERN);
  assert.equal(typeof manifest.name, "string");
  assert.ok(manifest.name.length > 0);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(typeof manifest.description, "string");
  assert.equal(manifest.license, "MIT");
  assert.match(manifest.engines.piDesktop, /^>=\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(manifest.activationEvents));
  assert.ok(manifest.activationEvents.includes("onStartup"));
});

test("manifest declares only known permissions and explains itself", () => {
  for (const permission of manifest.permissions) {
    assert.ok(ALLOWED_PERMISSIONS.has(permission), `unknown permission: ${permission}`);
  }
  assert.deepEqual([...manifest.permissions].sort(), [
    "desktop.control",
    "keyboard.globalShortcut",
    "ui.panel",
    "ui.view",
  ]);
  assert.ok(typeof manifest.safetyNotes === "string" && manifest.safetyNotes.length > 40);
  assert.ok(typeof manifest.i18n.en.safetyNotes === "string");
  assert.ok(typeof manifest.i18n["zh-CN"].safetyNotes === "string");
});

test("the view contribution points at a real entry with a valid id and icon", () => {
  const views = manifest.contributes.views;
  assert.ok(Array.isArray(views) && views.length === 1);
  const [view] = views;
  assert.match(view.id, VIEW_ID_PATTERN);
  assert.ok(ALLOWED_VIEW_ICONS.has(view.icon), `unknown view icon: ${view.icon}`);
  assert.equal(typeof view.title.en, "string");
  assert.equal(typeof view.title["zh-CN"], "string");
  assert.ok(!path.isAbsolute(view.entry));
  assert.ok(!view.entry.split(/[\\/]/).includes(".."));
  assert.ok(fs.existsSync(path.join(ROOT, view.entry)), "view entry exists");
});

test("the panel window reuses the view entry and declares its permission", () => {
  assert.ok(manifest.permissions.includes("ui.panel"));
  assert.equal(typeof manifest.ui.panel, "string");
  assert.ok(!path.isAbsolute(manifest.ui.panel));
  assert.ok(!manifest.ui.panel.split(/[\\/]/).includes(".."));
  assert.ok(fs.existsSync(path.join(ROOT, manifest.ui.panel)), "panel entry exists");
  assert.equal(manifest.ui.panel, manifest.contributes.views[0].entry);
  assert.ok(Number.isFinite(manifest.ui.width) && manifest.ui.width >= 360);
  assert.ok(Number.isFinite(manifest.ui.height) && manifest.ui.height >= 280);
});

test("the shortcut permission matches what main.js actually registers", () => {
  const source = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  assert.ok(manifest.permissions.includes("keyboard.globalShortcut"));
  assert.ok(source.includes("registerGlobalShortcut"), "main.js registers a global shortcut");
  assert.match(source, /Mod\+Shift\+U/, "the accelerator is the documented one");
  assert.ok(source.includes("unregisterGlobalShortcut"), "and removes it on unload");
});

test("the declared main entry exists and the panel assets are present", () => {
  assert.equal(manifest.main, "main.js");
  for (const file of ["main.js", "views/index.html", "views/app.js", "views/styles.css"]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  }
});

test("the panel HTML follows the chrome contract", () => {
  const html = fs.readFileSync(path.join(ROOT, "views/index.html"), "utf8");
  assert.match(html, /<meta name="pi-plugin-chrome" content="v2"/);
  assert.match(html, /\.\/styles\.css/);
  assert.match(html, /\.\/lib\/format\.js/);
  assert.match(html, /\.\/app\.js/);
});

test("the bundled source logos ship with the panel", () => {
  for (const file of [
    "views/assets/pi-cli.svg",
    "views/assets/pi-desktop.png",
    "views/assets/README.md",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  }
  const app = fs.readFileSync(path.join(ROOT, "views/app.js"), "utf8");
  assert.match(app, /pi-desktop\.png/);
  assert.match(app, /pi-cli\.svg/);
  const credits = fs.readFileSync(path.join(ROOT, "views/assets/README.md"), "utf8");
  assert.match(credits, /earendil-works\/pi/);
  assert.match(credits, /vastsa\/PI-Desktop/);
});

test("the manifest icon ships as a real PNG", () => {
  assert.equal(typeof manifest.icon, "string");
  const file = path.join(ROOT, manifest.icon);
  const bytes = fs.readFileSync(file);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "the host renders this file as an image",
  );
  // Square and at least 128px, so the host can downscale instead of upscale.
  assert.equal(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  assert.ok(bytes.readUInt32BE(16) >= 128);
});
