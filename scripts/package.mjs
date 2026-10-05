import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let result = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const entry = path.join(path.dirname(require.resolve('electron-builder/package.json')), require('electron-builder/package.json').bin['electron-builder']);
result = spawnSync(process.execPath, [entry, '--win', 'portable', 'nsis', '--x64', '--publish', 'never'], {
  stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_LINK ? 'true' : 'false' },
});
process.exit(result.status || 0);
