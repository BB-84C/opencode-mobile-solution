// Builds the shared UI into a static bundle for the desktop shell to load.
//
// The phone app and the desktop client are the same React code: `expo export
// --platform web` produces a plain static bundle, so the shell only has to
// serve it. Nothing here is desktop-specific beyond where the output lands.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.dirname(here);
const appRoot = path.join(path.dirname(desktopRoot), "app");
const outputDir = path.join(desktopRoot, "renderer");

function fail(message) {
  process.stderr.write(`build-renderer: ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(path.join(appRoot, "package.json"))) {
  fail(`no app package at ${appRoot}`);
}
if (!fs.existsSync(path.join(appRoot, "node_modules"))) {
  fail(`dependencies are missing; run 'npm install' in ${appRoot} first`);
}

fs.rmSync(outputDir, { recursive: true, force: true });

process.stdout.write(`building the web bundle from ${appRoot}\n`);
try {
  execFileSync("npx", ["expo", "export", "--platform", "web", "--output-dir", outputDir], {
    cwd: appRoot,
    stdio: "inherit",
  });
} catch (error) {
  fail(`expo export failed: ${error.message}`);
}

// Trust the artefact, not the exit code: a build that "succeeds" and leaves no
// entry point would only surface as a blank window later.
const indexPath = path.join(outputDir, "index.html");
if (!fs.existsSync(indexPath)) fail(`export finished but produced no ${indexPath}`);

const bundleDir = path.join(outputDir, "_expo", "static", "js", "web");
const bundles = fs.existsSync(bundleDir) ? fs.readdirSync(bundleDir).filter((name) => name.endsWith(".js")) : [];
if (bundles.length === 0) fail("export finished but produced no javascript bundle");

const bytes = bundles.reduce((total, name) => total + fs.statSync(path.join(bundleDir, name)).size, 0);
process.stdout.write(`renderer ready: ${bundles.length} bundle(s), ${(bytes / 1024 / 1024).toFixed(1)} MB\n`);
