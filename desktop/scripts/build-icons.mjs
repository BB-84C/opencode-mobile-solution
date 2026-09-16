// Derives the desktop icon containers from the mobile app's icon.
//
// There is one source image, app/assets/images/icon.png, which is the artwork
// the phone app already ships. macOS wants an .icns and Windows wants an .ico,
// and the two formats share nothing, so deriving both here from that single
// file is what stops the platforms from drifting onto different artwork.
//
// Both containers are built with tools macOS already has. An .icns comes from
// iconutil; an .ico is assembled here, because the format is a small header
// followed by whole PNG files and pulling in an image library to write sixteen
// bytes of it would be the larger cost.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.dirname(here);
const repoRoot = path.dirname(desktopRoot);

export const ICON_SOURCE = path.join(repoRoot, "app", "assets", "images", "icon.png");
export const ICON_OUT_DIR = path.join(desktopRoot, "build");

// The sizes macOS expects in an iconset, as name suffix and pixel size.
const ICNS_SIZES = [
  ["16x16", 16], ["16x16@2x", 32],
  ["32x32", 32], ["32x32@2x", 64],
  ["128x128", 128], ["128x128@2x", 256],
  ["256x256", 256], ["256x256@2x", 512],
  ["512x512", 512], ["512x512@2x", 1024],
];

// Windows picks whichever of these fits the surface it is drawing.
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function fail(message) {
  process.stderr.write(`icons: ${message}\n`);
  process.exit(1);
}

function resize(source, size, destination) {
  execFileSync("/usr/bin/sips", ["-z", String(size), String(size), source, "--out", destination], {
    stdio: "pipe",
  });
}

/**
 * Packs whole PNG files into an ICO container.
 *
 * Windows has accepted PNG-compressed entries since Vista, so each image goes in
 * untouched behind a sixteen-byte directory entry. A 256px image records its
 * size as 0, which is how the format says "256".
 */
export function assembleIco(images) {
  if (images.length === 0) throw new Error("an ICO needs at least one image");
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach(({ size, data }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry);
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size, 0 for truecolour
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

/** Reads an ICO back, so a build can check what it wrote rather than trust it. */
export function readIcoDirectory(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("not an ICO container");
  }
  const count = buffer.readUInt16LE(4);
  return Array.from({ length: count }, (_unused, index) => {
    const entry = 6 + index * 16;
    const declared = buffer.readUInt8(entry);
    return {
      size: declared === 0 ? 256 : declared,
      bytes: buffer.readUInt32LE(entry + 8),
      offset: buffer.readUInt32LE(entry + 12),
    };
  });
}

export function buildIcons() {
  if (process.platform !== "darwin") {
    fail("icons are built with sips and iconutil, which only exist on macOS; build on the Mac host");
  }
  if (!fs.existsSync(ICON_SOURCE)) fail(`the source artwork is missing at ${ICON_SOURCE}`);

  fs.mkdirSync(ICON_OUT_DIR, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(ICON_OUT_DIR, "scratch-"));

  try {
    // macOS
    const iconset = path.join(scratch, "icon.iconset");
    fs.mkdirSync(iconset);
    for (const [name, size] of ICNS_SIZES) {
      resize(ICON_SOURCE, size, path.join(iconset, `icon_${name}.png`));
    }
    const icns = path.join(ICON_OUT_DIR, "icon.icns");
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", icns], { stdio: "pipe" });
    if (!fs.existsSync(icns)) fail("iconutil reported success but wrote no .icns");

    // Windows
    const images = ICO_SIZES.map((size) => {
      const scaled = path.join(scratch, `ico-${size}.png`);
      resize(ICON_SOURCE, size, scaled);
      return { size, data: fs.readFileSync(scaled) };
    });
    const ico = path.join(ICON_OUT_DIR, "icon.ico");
    fs.writeFileSync(ico, assembleIco(images));

    // Read the container back: a wrong offset produces a file of plausible size
    // that Windows silently refuses to draw.
    const written = fs.readFileSync(ico);
    const directory = readIcoDirectory(written);
    if (directory.length !== ICO_SIZES.length) {
      fail(`the .ico declares ${directory.length} images, expected ${ICO_SIZES.length}`);
    }
    for (const entry of directory) {
      const slice = written.subarray(entry.offset, entry.offset + entry.bytes);
      if (slice.length !== entry.bytes) fail(`an .ico entry points past the end of the file`);
      if (slice.readUInt32BE(0) !== 0x89504e47) fail(`an .ico entry does not start a PNG`);
    }

    process.stdout.write(
      `icons: wrote icon.icns and icon.ico (${directory.map((e) => e.size).join(", ")}px) from ${path.relative(repoRoot, ICON_SOURCE)}\n`,
    );
    return { icns, ico };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildIcons();
