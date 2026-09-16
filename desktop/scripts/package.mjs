// Produces an installable desktop build for macOS or Windows.
//
// Neither output is code signed, so the first launch needs a right-click → Open
// on macOS and a "More info → Run anyway" past SmartScreen on Windows. That is
// the documented cost of not paying for two developer certificates.
//
//   npm run package                     the platform you are on
//   npm run package -- --platform=win32 cross-built from the Mac host
//
// What differs between the two targets lives in package-target.mjs, so this
// script never grows a platform branch of its own.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildIcons } from "./build-icons.mjs";
import { packageTargetFor } from "./package-target.mjs";

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

function flag(name, fallback) {
  const match = process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

/** Directory size without shelling out to du, which Windows does not have. */
function directorySize(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

let target;
try {
  target = packageTargetFor(flag("platform", process.platform), flag("arch", process.arch), APP_NAME);
} catch (error) {
  fail(error.message);
}

// The shell is only a container; without the renderer bundle it would package a
// window that loads nothing.
process.stdout.write("building the renderer\n");
run(process.execPath, [path.join(here, "build-renderer.mjs")]);
if (!fs.existsSync(path.join(desktopRoot, "renderer", "index.html"))) {
  fail("renderer bundle is missing after the build step");
}

// Both containers are derived from the phone app's artwork on every build, so a
// change to the source icon cannot reach one platform and miss the other.
buildIcons();
const iconPath = path.join(desktopRoot, "build", target.icon);
if (!fs.existsSync(iconPath)) fail(`the icon build produced no ${target.icon}`);

fs.rmSync(outDir, { recursive: true, force: true });

process.stdout.write(`packaging for ${target.platform}/${target.arch}\n`);
run("npx", [
  "@electron/packager",
  ".",
  APP_NAME,
  `--platform=${target.platform}`,
  `--arch=${target.arch}`,
  `--out=${outDir}`,
  "--overwrite",
  `--icon=${iconPath}`,
  "--app-bundle-id=dev.opencode.cockpit",
  // Keep the packager's own dependencies, the build scratch and the exported
  // bundle's sourcemaps out of a build that a user installs.
  "--ignore=^/dist($|/)",
  "--ignore=^/test($|/)",
  "--ignore=^/build($|/)",
  "--ignore=^/node_modules/@electron/packager($|/)",
]);

// Trust the artefact, not the exit code.
const artifactPath = path.join(outDir, target.artifact);
if (!fs.existsSync(artifactPath)) {
  fail(`packager reported success but ${artifactPath} does not exist`);
}

const binary = path.join(outDir, target.executable);
if (!fs.existsSync(binary)) fail(`the build has no executable at ${binary}`);

if (target.propertyList) {
  // An .app whose Info.plist macOS cannot parse fails to launch with no useful
  // message anywhere.
  const plistPath = path.join(outDir, target.propertyList);
  try {
    execFileSync("/usr/bin/plutil", ["-lint", plistPath], { stdio: "pipe" });
  } catch {
    fail(`${plistPath} is not a valid property list`);
  }
}

const megabytes = (directorySize(artifactPath) / 1024 / 1024).toFixed(0);
process.stdout.write(`\nbuilt ${artifactPath}\n`);
process.stdout.write(`size ${megabytes} MB\n`);
process.stdout.write(`${target.firstLaunchNote}\n`);
