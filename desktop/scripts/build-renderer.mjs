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

// Metro copies KaTeX's stylesheet but not the fonts it points at with
// relative url(fonts/...). Without them every formula falls back to a system
// font and its glyphs misalign, with no error anywhere. Place the fonts where
// the stylesheet looks, then check that every font it names is really there.
const cssDir = path.join(outputDir, "_expo", "static", "css");
const katexFonts = path.join(appRoot, "node_modules", "katex", "dist", "fonts");
const stylesheets = fs.existsSync(cssDir) ? fs.readdirSync(cssDir).filter((name) => name.endsWith(".css")) : [];
const wantedFonts = new Set(
  stylesheets.flatMap((name) =>
    [...fs.readFileSync(path.join(cssDir, name), "utf8").matchAll(/url\(["']?fonts\/([^"')?#]+)/g)].map((match) => match[1]),
  ),
);
if (wantedFonts.size > 0) {
  if (!fs.existsSync(katexFonts)) fail(`a stylesheet needs fonts but ${katexFonts} does not exist`);
  fs.cpSync(katexFonts, path.join(cssDir, "fonts"), { recursive: true });
  const missing = [...wantedFonts].filter((font) => !fs.existsSync(path.join(cssDir, "fonts", font)));
  if (missing.length > 0) fail(`stylesheets reference fonts that were not copied: ${missing.join(", ")}`);
  process.stdout.write(`math fonts: ${wantedFonts.size} placed beside the stylesheet\n`);
}

const bytes = bundles.reduce((total, name) => total + fs.statSync(path.join(bundleDir, name)).size, 0);
process.stdout.write(`renderer ready: ${bundles.length} bundle(s), ${(bytes / 1024 / 1024).toFixed(1)} MB\n`);
