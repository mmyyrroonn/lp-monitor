import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { saveJson, sha256, resolveEvidencePath } from '../../src/ops/files.js';
test('atomic evidence writes return portable paths and disk hashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-'));
  try {
    const file = saveJson(join(root, 'nested', 'value.json'), { value: 1n }, root);
    expect(file.path).toBe('nested/value.json');
    expect(file.sha256).toBe(sha256(readFileSync(resolveEvidencePath(root, file.path))));
    expect(file.bytes).toBe(readFileSync(resolveEvidencePath(root, file.path)).length);
    saveJson(join(root, file.path), { value: 2n }, root);
    expect(JSON.parse(readFileSync(join(root, file.path), 'utf8'))).toEqual({ value: '2' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test.each([
  '../secret',
  '/secret',
  'C:/secret',
  'C:\\secret',
  'nested/../../secret',
  'nested\\secret',
  '',
  'https://secret',
])('rejects unsafe evidence path %s', (path) => {
  expect(() => resolveEvidencePath(process.cwd(), path)).toThrow();
});
