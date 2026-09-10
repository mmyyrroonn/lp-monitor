import { readFileSync } from 'node:fs';
import { ZodError } from 'zod';
import { ConfigError } from './env.js';

/** Report actionable locations without echoing input values, paths or parser excerpts. */
export function loadValidatedJson<T>(path: string, label: string, parse: (value: unknown) => T): T {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new ConfigError(`${label} file ${missing ? 'not found' : 'unreadable'}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigError(`Invalid ${label} JSON`);
  }
  try {
    return parse(value);
  } catch (error) {
    const locations =
      error instanceof ZodError
        ? [...new Set(error.issues.map((issue) => issue.path.join('.') || '<root>'))]
            .slice(0, 8)
            .join(', ')
        : '<root>';
    throw new ConfigError(`Invalid ${label} schema at ${locations}`);
  }
}
