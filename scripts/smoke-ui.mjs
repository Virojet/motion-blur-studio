import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const output = path.resolve('artifacts/ui-smoke');
const executableIndex = process.argv.indexOf('--exe');
const packagedExecutable = executableIndex >= 0 ? path.resolve(process.argv[executableIndex + 1]) : null;
const autoDetect = process.argv.includes('--auto-detect');
const cpuOnly = process.argv.includes('--cpu');
await mkdir(output, { recursive: true });
const userData = path.join(output, `user-data-${Date.now()}`);
if (cpuOnly) {
  const { DEFAULT_SETTINGS } = require('../dist/electron/shared/types.js');
  await mkdir(userData, { recursive: true });
  await writeFile(path.join(userData, 'preferences.json'), JSON.stringify({ settings: { ...DEFAULT_SETTINGS, gpuInterpolation: false, gpuDecoding: false, gpuEncoding: false }, outputDirectory: null, engineDirectory: null }));
}
const application = await electron.launch({
  executablePath: packagedExecutable || require('electron'), args: packagedExecutable ? [] : [path.resolve('.')],
  cwd: autoDetect ? output : process.cwd(),
  env: { ...process.env, MOTION_BLUR_USER_DATA: userData, MOTION_BLUR_ENGINE_DIR: autoDetect ? undefined : process.env.MOTION_BLUR_ENGINE_DIR || path.resolve('tools/blur') },
});
const errors = [];
try {
  const page = await application.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !!window.motionBlur);
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => window.motionBlur.getState());
  assert.equal(state.engine.ready, true, JSON.stringify(state.engine));
  await page.screenshot({ path: path.join(output, 'empty.png') });
  const fixture = path.resolve('artifacts/engine-verification/fixtures/moving bars with audio 空間.mp4');
  const result = await page.evaluate(async filename => {
    const clips = await window.motionBlur.inspectClips([filename]);
    const response = await fetch(clips[0].mediaUrl, { headers: { Range: 'bytes=0-31' } });
    return { clips, status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  }, fixture);
  assert.equal(result.clips[0].width, 320);
  assert.equal(result.status, 206);
  assert.equal(result.bytes, 32);
  const exportDirectory = path.join(output, 'exports');
  await mkdir(exportDirectory, { recursive: true });
  await application.evaluate(({ dialog }, { fixture, exportDirectory }) => {
    dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: options.properties.includes('openDirectory') ? [exportDirectory] : [fixture] });
  }, { fixture, exportDirectory });
  await page.getByRole('button', { name: /^Add clips/ }).click();
  await page.getByText('moving bars with audio 空間.mp4', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: /Beside original clips/ }).click();
  await page.getByRole('button', { name: /Generate preview/ }).click();
  await page.getByText('Preview ready', { exact: true }).waitFor({ timeout: 120000 });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForFunction(() => Array.from(document.querySelectorAll('video')).every(video => !video.error && video.readyState >= 2 && video.currentTime > .1), null, { timeout: 20000 });
  const playback = await page.locator('video').evaluateAll(videos => videos.map(video => ({ time: video.currentTime, error: video.error?.message ?? null, ready: video.readyState })));
  assert.equal(playback.length, 2);
  assert.ok(playback.every(video => !video.error && video.ready >= 2 && video.time > 0), JSON.stringify(playback));
  assert.ok(Math.abs(playback[0].time - playback[1].time) < 0.15, 'Comparison videos must play in sync.');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'comparison.png') });
  await page.getByRole('button', { name: 'Export clip', exact: true }).click();
  await page.getByText('1 clip exported successfully', { exact: true }).waitFor({ timeout: 120000 });
  await page.screenshot({ path: path.join(output, 'export-complete.png') });
  const unsupported = await page.evaluate(() => window.motionBlur.inspectClips(['C:\\this-file-does-not-exist.mp4']));
  assert.ok(unsupported[0].error, 'Invalid media must return an error clip.');
  assert.deepEqual(errors, [], 'The renderer must not throw startup errors.');
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ state, media: result, playback, errors, verified: ['UI import', 'preview generation', 'synchronized playback', 'UI export', 'invalid input', 'ranged media access'] }, null, 2));
  console.log('Electron UI import, preview, synchronized playback, export and error handling passed.');
} finally { await application.close(); }
