// Produces an installable desktop build.
//
// The output is a plain .app bundle: drag it to Applications and it runs. There
// is no code signing here, so the first launch needs a right-click → Open, which
// is the documented cost of not paying for a developer certificate.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.dirname(here);
const outDir = path.join(desktopRoot, "dist");
const APP_NAME = "OpenCode Cockpit";

function fail(message) {
  process.stderr.write(`package: ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  try {
    execFileSync(command, args, { cwd: desktopRoot, stdio: "inherit", ...options });
  } catch (error) {
    fail(`${command} ${args.join(" ")} failed: ${error.message}`);
  }
}

// The shell is only a container; without the renderer bundle it would package a
// window that loads nothing.
process.stdout.write("building the renderer\n");
run(process.execPath, [path.join(here, "build-renderer.mjs")]);
if (!fs.existsSync(path.join(desktopRoot, "renderer", "index.html"))) {
  fail("renderer bundle is missing after the build step");
}

fs.rmSync(outDir, { recursive: true, force: true });

const arch = process.arch === "x64" ? "x64" : "arm64";
process.stdout.write(`packaging for darwin/${arch}\n`);
run("npx", [
  "@electron/packager",
  ".",
  APP_NAME,
  "--platform=darwin",
  `--arch=${arch}`,
  `--out=${outDir}`,
  "--overwrite",
  "--app-bundle-id=dev.opencode.cockpit",
  // Keep the packager's own dependencies and the exported bundle's sourcemaps
  // out of a build that a user installs.
  "--ignore=^/dist($|/)",
  "--ignore=^/test($|/)",
  "--ignore=^/node_modules/@electron/packager($|/)",
]);

const appPath = path.join(outDir, `${APP_NAME}-darwin-${arch}`, `${APP_NAME}.app`);
if (!fs.existsSync(appPath)) fail(`packager reported success but ${appPath} does not exist`);

// Trust the artefact, not the exit code: an .app whose Info.plist macOS cannot
// parse will fail to launch with no useful message.
const plistPath = path.join(appPath, "Contents", "Info.plist");
try {
  execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "pipe" });
} catch {
  fail(`${plistPath} is not a valid property list`);
}

const binary = path.join(appPath, "Contents", "MacOS", APP_NAME);
if (!fs.existsSync(binary)) fail(`the bundle has no executable at ${binary}`);

const bytes = execFileSync("/usr/bin/du", ["-sk", appPath], { encoding: "utf8" }).split("\t")[0];
process.stdout.write(`\nbuilt ${appPath}\n`);
process.stdout.write(`size ${(Number(bytes) / 1024).toFixed(0)} MB\n`);
process.stdout.write("unsigned: the first launch needs right-click > Open\n");
