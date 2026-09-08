import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { encodeJson } from '../domain/json.js';
export const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
export function saveJson(path: string, value: unknown): { path: string; sha256: string; bytes: number } {
  const text = encodeJson(value) + '\n'; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
  return { path, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}
