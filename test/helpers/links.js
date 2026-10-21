// A test that needs a link the code under test must refuse to follow has to be able to make one. Windows grants
// symlink() only to an administrator or an account with Developer Mode on; junctions need no privilege but exist
// only for real directories. So: a junction for a directory, a plain symlink for a file, and when even that is
// refused the test is skipped out loud — a test that runs against a fixture with no link in it proves nothing.
import fs from 'node:fs';
import path from 'node:path';

const LINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOSYS', 'EINVAL', 'ENOTSUP']);

function make(t, target, link, type) {
  try {
    fs.symlinkSync(type === 'junction' ? path.resolve(target) : target, path.resolve(link), type);
    return true;
  } catch (error) {
    if (!LINK_ERRORS.has(error.code)) throw error;
    t?.skip?.(`${type === 'junction' ? 'directory junction' : 'symlink'} unavailable here: ${error.code}`);
    return false;
  }
}

/** A directory link. Returns false (and skips the test) when the file system refuses one. */
export function linkDir(t, target, link) {
  return make(t, target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** A file link. Junctions cannot point at a file, so this needs the symlink privilege on Windows. */
export function linkFile(t, target, link) {
  return make(t, target, link, 'file');
}
