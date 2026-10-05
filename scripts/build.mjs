import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
for (const [name, bin, args] of [['typescript', 'tsc', ['-p', 'tsconfig.main.json']], ['vite', 'vite', ['build']]]) {
  const entry = path.join(path.dirname(require.resolve(`${name}/package.json`)), require(`${name}/package.json`).bin[bin]);
  const result = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
