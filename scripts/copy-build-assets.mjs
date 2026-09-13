import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/storage/migrations', { recursive: true });
cpSync('src/storage/migrations', 'dist/storage/migrations', { recursive: true });
mkdirSync('dist/dashboard/web', { recursive: true });
for (const name of ['index.html', 'styles.css']) {
  cpSync(`src/dashboard/web/${name}`, `dist/dashboard/web/${name}`);
}
