/**
 * What a packaged build looks like on each platform.
 *
 * The two targets disagree about almost everything that matters to a build
 * script: macOS produces a directory ending in .app whose executable hides in
 * Contents/MacOS and whose Info.plist has to parse, while Windows produces a
 * plain directory with an .exe in it, no property list at all, and an icon in a
 * different container format. Deciding that
 * here, away from the script that shells out, is what lets the pairing be
 * asserted: a target that names a plist on Windows, or forgets the .exe suffix,
 * is the bug this module exists to prevent.
 *
 * Paths are relative to the packager's output directory, so the caller stays in
 * charge of where that is.
 */

import path from "node:path";

const SUPPORTED = new Set(["darwin", "win32"]);

export function packageTargetFor(platform, arch, appName) {
  if (!SUPPORTED.has(platform)) {
    throw new Error(
      `unsupported package platform ${platform}; this project ships ${[...SUPPORTED].join(" and ")}`,
    );
  }
  // The packager only understands these two names, and an unrecognised arch
  // would otherwise reach it as a flag it silently misreads.
  const resolvedArch = arch === "x64" ? "x64" : "arm64";
  const directory = `${appName}-${platform}-${resolvedArch}`;

  if (platform === "darwin") {
    const bundle = path.join(directory, `${appName}.app`);
    return {
      platform,
      arch: resolvedArch,
      directory,
      artifact: bundle,
      executable: path.join(bundle, "Contents", "MacOS", appName),
      propertyList: path.join(bundle, "Contents", "Info.plist"),
      icon: "icon.icns",
      firstLaunchNote: "unsigned: the first launch needs right-click > Open",
    };
  }

  return {
    platform,
    arch: resolvedArch,
    directory,
    artifact: directory,
    executable: path.join(directory, `${appName}.exe`),
    propertyList: null,
    icon: "icon.ico",
    firstLaunchNote: "unsigned: SmartScreen warns on the first launch, choose More info > Run anyway",
  };
}
