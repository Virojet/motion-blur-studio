import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const root = path.resolve('artifacts/preview-recovery');
await mkdir(root, { recursive: true });
const executableIndex = process.argv.indexOf('--exe');
const packagedExecutable = executableIndex >= 0 ? path.resolve(process.argv[executableIndex + 1]) : null;
const source = process.argv[2] || path.resolve('artifacts/engine-verification/fixtures/moving bars with audio 空間.mp4');
const before = process.argv[3];
const after = process.argv[4];
const app = await _electron.launch({ executablePath: packagedExecutable || require('electron'), args: packagedExecutable ? [] : ['.'], env: {
  ...process.env, MOTION_BLUR_USER_DATA: path.join(root, `profile-${Date.now()}`), MOTION_BLUR_ENGINE_DIR: path.resolve('tools/blur'),
} });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.motionBlur);
  const [clip, original, processed] = await page.evaluate(files => window.motionBlur.inspectClips(files), [source, before, after]);
  await app.evaluate(({ ipcMain }, clip) => {
    ipcMain.removeHandler('clips:pick');
    ipcMain.handle('clips:pick', () => [clip]);
  }, clip);
  await page.getByRole('button', { name: /^Add clips/ }).click();
  await page.locator('video').waitFor();
  await page.locator('video').evaluate(video => video.dispatchEvent(new Event('error')));
  await page.locator('.media-error').waitFor();
  const oldVideo = await page.locator('video').elementHandle();
  const state = await page.evaluate(() => window.motionBlur.getState());
  const preview = { clipId: clip.id, originalUrl: original.mediaUrl, processedUrl: processed.mediaUrl, start: 0, duration: 3, settingsKey: JSON.stringify(state.preferences.settings) };
  await app.evaluate(({ BrowserWindow }, preview) => BrowserWindow.getAllWindows()[0].webContents.send('app:event', { type: 'preview', preview }), preview);
  await page.getByText('Preview ready', { exact: true }).waitFor();
  await oldVideo.evaluate(video => video.dispatchEvent(new Event('error')));
  assert.equal(await page.locator('.media-error').count(), 0, 'An error from the discarded source player must not poison its preview.');
  const play = page.getByRole('button', { name: 'Play', exact: true });
  await play.click();
  const waitForPlayback = () => page.waitForFunction(() => Array.from(document.querySelectorAll('video')).every(video => !video.error && video.readyState >= 2 && video.currentTime > .1), null, { timeout: 20000 });
  await waitForPlayback();
  const playback = await page.locator('video').evaluateAll(videos => videos.map(video => ({ time: video.currentTime, error: video.error?.message || null, ready: video.readyState })));
  assert.equal(playback.length, 2);
  assert.ok(playback.every(video => !video.error && video.ready >= 2 && video.time > 0), JSON.stringify(playback));
  assert.ok(Math.abs(playback[0].time - playback[1].time) < .15);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('video').first().evaluate(video => video.dispatchEvent(new Event('error')));
  await page.getByRole('button', { name: 'Reload playback', exact: true }).click();
  assert.equal(await page.locator('.media-error').count(), 0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await waitForPlayback();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'recovered.png') });
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ source, playback, recoveredAfterSourceError: true, playbackReload: true, packagedExecutable }, null, 2));
  console.log('Actual preview files play in sync after an original-clip playback error.');
} finally { await app.close(); }
