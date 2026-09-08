import { existsSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
/** @param {string} root @param {string} path */
export function resolveEvidencePath(root, path) {
  if (
    typeof path !== 'string' ||
    !path ||
    path.includes('\\') ||
    path.includes(':') ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '..' || part === '.')
  )
    throw new Error('Invalid evidence path');
  const base = resolve(root);
  const target = resolve(base, path);
  if (!target.startsWith(base + sep)) throw new Error('Invalid evidence path');
  if (existsSync(base)) {
    let ancestor = target;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const physicalBase = realpathSync(base);
    const physicalAncestor = realpathSync(ancestor);
    if (physicalAncestor !== physicalBase && !physicalAncestor.startsWith(physicalBase + sep))
      throw new Error('Invalid evidence path');
  }
  return target;
}
/** @param {string} path @param {string} [root] */
export function relativeEvidencePath(path, root = process.cwd()) {
  const result = relative(resolve(root), resolve(path)).split(sep).join('/');
  resolveEvidencePath(root, result);
  return result;
}
/** Safe diagnostics deliberately omit raw exception messages and input paths. @param {unknown} error */
export function safeDiagnostic(error) {
  if (error instanceof SyntaxError) return 'invalid JSON';
  if (error instanceof TypeError) return 'unexpected input structure';
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z_]+$/.test(error.code)
  )
    return error.code;
  if (error instanceof Error && error.message === 'Invalid evidence path')
    return 'invalid evidence path';
  return 'validation failure';
}
/** Resolve canonical path bases; legacy aliases remain readable without rewriting archives.
 * @param {unknown} pathBase @param {string} artifactPath @param {string} [repositoryRoot]
 */
export function evidencePathRoot(pathBase, artifactPath, repositoryRoot = process.cwd()) {
  if (pathBase === 'repository') return resolve(repositoryRoot);
  if (['artifact-directory', 'manifest-directory', 'report-directory'].includes(String(pathBase)))
    return dirname(resolve(artifactPath));
  throw new TypeError('missing or unsupported pathBase');
}
