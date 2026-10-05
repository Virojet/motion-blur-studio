import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { installBlurEngine } = require('../dist/electron/main/install-engine.js');
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const destination = path.resolve(option('--destination') || path.join(process.env.LOCALAPPDATA || '.', 'Programs', 'Motion Blur Engine'));
try {
  const result = await installBlurEngine({ destination, cacheDirectory: path.resolve('artifacts/engine-download'), installerPath: option('--installer'),
    reuseExisting: process.argv.includes('--reuse-existing'), dryRun: process.argv.includes('--dry-run'), onMessage: console.log });
  console.log(JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
