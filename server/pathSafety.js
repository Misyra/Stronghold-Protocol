import path from 'node:path';

/** Lexical containment; callers handling symlinks must resolve them before this check. */
export function within(root, target, { allowRoot = true } = {}) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' ? allowRoot : relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
