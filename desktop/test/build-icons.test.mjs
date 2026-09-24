import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleIco, readIcoDirectory } from '../scripts/build-icons.mjs';

const png = (size, fill) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.alloc(size, fill),
]);

test('every directory entry points at exactly its own image', () => {
  // A wrong offset produces a file of plausible size that Windows refuses to
  // draw, with no error to notice, so the offsets are the thing worth asserting.
  const images = [
    { size: 16, data: png(10, 1) },
    { size: 32, data: png(40, 2) },
    { size: 256, data: png(90, 3) },
  ];

  const container = assembleIco(images);
  const directory = readIcoDirectory(container);

  assert.equal(directory.length, images.length);
  directory.forEach((entry, index) => {
    const slice = container.subarray(entry.offset, entry.offset + entry.bytes);
    assert.deepEqual(slice, images[index].data, `entry ${index} does not point at its image`);
  });
});

test('a 256px image records its size as zero, which is how the format says 256', () => {
  const container = assembleIco([{ size: 256, data: png(8, 7) }]);

  assert.equal(container.readUInt8(6), 0, 'the raw byte must be 0');
  assert.equal(readIcoDirectory(container)[0].size, 256, 'reading it back must say 256');
});

test('the first payload starts after the header and the whole directory', () => {
  const images = [
    { size: 16, data: png(4, 1) },
    { size: 32, data: png(4, 2) },
  ];

  const [first] = readIcoDirectory(assembleIco(images));

  assert.equal(first.offset, 6 + 16 * images.length);
});

test('the container declares itself an icon rather than a cursor', () => {
  const container = assembleIco([{ size: 16, data: png(4, 1) }]);

  assert.equal(container.readUInt16LE(0), 0, 'reserved field');
  assert.equal(container.readUInt16LE(2), 1, 'type 1 is an icon, 2 would be a cursor');
});

test('an empty icon fails loudly instead of writing a six byte file', () => {
  assert.throws(() => assembleIco([]), /at least one image/);
});

test('refuses to read something that is not an ICO', () => {
  assert.throws(() => readIcoDirectory(Buffer.alloc(16)), /not an ICO container/);
});
