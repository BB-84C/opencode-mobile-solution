import { posix, win32 } from 'node:path';

export function isCanonicalAbsoluteDirectory(directory) {
  if (typeof directory !== 'string') return false;
  return [posix, win32].some((path) => path.isAbsolute(directory) && path.normalize(directory) === directory);
}
