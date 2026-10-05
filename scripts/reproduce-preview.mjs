import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(import.meta.url);
const directory = path.resolve('artifacts/preview-failure');
await mkdir(directory, { recursive: true });
const app = await _electron.launch({ executablePath: require('electron'), args: ['.'], env: {
  ...process.env, MOTION_BLUR_USER_DATA: path.join(directory, `profile-${Date.now()}`), MOTION_BLUR_ENGINE_DIR: path.resolve('tools/blur'),
} });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.motionBlur);
  const files = process.argv.slice(2).map(filename => path.resolve(filename));
  const diagnostics = await page.evaluate(async files => {
    const clips = await window.motionBlur.inspectClips(files);
    const results = [];
    for (const clip of clips) {
      const video = document.createElement('video');
      video.src = clip.mediaUrl; video.muted = true; video.preload = 'auto'; video.width = 320;
      document.body.append(video);
      const log = [];
      for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled', 'error']) video.addEventListener(event, () => log.push({ event, ready: video.readyState, time: video.currentTime, error: video.error?.message }));
      let playError;
      try { await video.play(); } catch (error) { playError = String(error); }
      await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await fetch(clip.mediaUrl);
      results.push({ clip, playError, mime: response.headers.get('content-type'), length: (await response.arrayBuffer()).byteLength,
        time: video.currentTime, ready: video.readyState, duration: video.duration, error: video.error ? { code: video.error.code, message: video.error.message } : null, log });
      video.pause();
    }
    return results;
  }, files);
  await writeFile(path.join(directory, 'raw-playback.json'), JSON.stringify(diagnostics, null, 2));
  console.log(JSON.stringify(diagnostics, null, 2));
} finally { await app.close(); }
