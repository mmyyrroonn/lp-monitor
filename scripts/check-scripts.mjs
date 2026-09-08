import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// Dependency-free syntax lint complements checkJs without requiring TS Compiler API.
for (const file of readdirSync(new URL('.', import.meta.url)).filter((file) =>
  file.endsWith('.mjs'),
)) {
  const result = spawnSync(
    process.execPath,
    ['--check', fileURLToPath(new URL(file, import.meta.url))],
    { stdio: 'inherit' },
  );
  if (result.error || result.status !== 0) process.exitCode = 1;
}
