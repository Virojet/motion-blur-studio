import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const packageBin = (name, bin) => path.join(path.dirname(require.resolve(`${name}/package.json`)), require(`${name}/package.json`).bin[bin]);
const tsc = spawn(process.execPath, [packageBin('typescript', 'tsc'), '-p', 'tsconfig.main.json'], { stdio: 'inherit' });
await new Promise(resolve => tsc.on('exit', resolve));
if (tsc.exitCode) process.exit(tsc.exitCode);
const vite = spawn(process.execPath, [packageBin('vite', 'vite')], { stdio: 'inherit' });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch('http://127.0.0.1:5173')).ok) break; } catch {}
  await new Promise(resolve => setTimeout(resolve, 250));
}
const electron = spawn(require('electron'), ['.'], { stdio: 'inherit', env: { ...process.env, MOTION_BLUR_DEV_URL: 'http://127.0.0.1:5173' } });
electron.on('exit', code => { vite.kill(); process.exit(code || 0); });
process.on('SIGINT', () => { electron.kill(); vite.kill(); process.exit(0); });
