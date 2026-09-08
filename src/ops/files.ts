import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
  existsSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { encodeJson } from '../domain/json.js';
export const sha256 = (text: string | Uint8Array): string =>
  createHash('sha256').update(text).digest('hex');

/** Evidence references are POSIX paths anchored to an explicitly declared root. */
export function resolveEvidencePath(root: string, path: string): string {
  if (
    !path ||
    path.includes('\\') ||
    path.includes(':') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '..' || part === '.' || !part)
  ) {
    throw new Error('Invalid evidence path: expected a contained relative POSIX path');
  }
  const base = resolve(root);
  const target = resolve(base, path);
  if (!target.startsWith(base + sep)) throw new Error('Invalid evidence path: outside root');
  // Existing symlinks must not bypass lexical containment.
  if (existsSync(base)) {
    let ancestor = target;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const physicalBase = realpathSync(base);
    const physicalAncestor = realpathSync(ancestor);
    if (physicalAncestor !== physicalBase && !physicalAncestor.startsWith(physicalBase + sep))
      throw new Error('Invalid evidence path: symlink outside root');
  }
  return target;
}

export function repositoryRelativePath(path: string, root = process.cwd()): string {
  const portable = relative(resolve(root), resolve(path)).split(sep).join('/');
  resolveEvidencePath(root, portable);
  return portable;
}

export function saveJson(
  path: string,
  value: unknown,
  root = process.cwd(),
): { path: string; sha256: string; bytes: number } {
  const portable = repositoryRelativePath(path, root);
  const target = resolveEvidencePath(root, portable);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, encodeJson(value) + '\n', { flag: 'wx' });
    renameSync(temporary, target);
    const bytes = readFileSync(target);
    return { path: portable, sha256: sha256(bytes), bytes: bytes.length };
  } finally {
    rmSync(temporary, { force: true });
  }
}
