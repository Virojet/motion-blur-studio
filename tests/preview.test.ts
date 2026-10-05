import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobManager, type MediaInfo, type WorkerEvent } from '../src/main/engine';
import { DEFAULT_SETTINGS, type Clip, type EngineStatus } from '../src/shared/types';

test('late previews use accurate input seeking and retain the requested three-second range', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blur-preview-seek-'));
  const clip: Clip = { id: 'long-recording', path: path.join(directory, '18 minute gameplay 空間.mov'), name: 'gameplay.mov',
    duration: 1101, width: 2560, height: 1440, fps: 60, hasAudio: true, mediaUrl: '' };
  const engine: EngineStatus = { ready: true, directory, blurPath: 'blur-cli', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', issues: [] };
  const source: MediaInfo = { ...clip, codec: 'h264', audioDuration: clip.duration, videoStart: 0, audioStart: 0 };
  const calls: { command: string; args: string[] }[] = [], events: WorkerEvent[] = [];
  let sampleDuration = 0;
  const manager = new JobManager({
    engine: () => engine, emit: event => events.push(event), workDirectory: path.join(directory, 'work'),
    inspect: async file => file === clip.path ? source : { ...source, duration: sampleDuration, audioDuration: sampleDuration },
    runner: async (command, args) => {
      calls.push({ command, args });
      const output = command === 'blur-cli' ? args[args.indexOf('-o') + 1] : args.at(-1)!;
      if (output.endsWith('sample.mkv')) sampleDuration = Number(args[args.indexOf('-t') + 1]);
      await writeFile(output, 'fixture adapter output');
      return { stdout: '', stderr: '' };
    },
  });
  try {
    await manager.preview(clip, 235.5, DEFAULT_SETTINGS);
    const ready = events.find(event => event.type === 'preview-ready');
    assert.ok(ready && ready.type === 'preview-ready', 'The preview must complete.');
    assert.equal(ready.preview.start, 235.5);
    assert.equal(ready.preview.duration, 3);
    const mediaCalls = calls.filter(call => call.command === 'ffmpeg');
    assert.equal(mediaCalls.length, 3, 'Extract one context sample and create both playback proxies.');
    for (const { args } of mediaCalls) {
      assert.ok(args.indexOf('-ss') < args.indexOf('-i'), 'Seeking must happen before input decoding.');
      assert.ok(args.includes('-accurate_seek'), 'Transcoding must discard the keyframe-to-target gap.');
    }
    assert.equal(Number(mediaCalls[0].args[mediaCalls[0].args.indexOf('-ss') + 1]), 235);
    assert.equal(Number(mediaCalls[0].args[mediaCalls[0].args.indexOf('-t') + 1]), 4);
    assert.equal(Number(mediaCalls[1].args[mediaCalls[1].args.indexOf('-ss') + 1]), 235.5);
    assert.equal(Number(mediaCalls[2].args[mediaCalls[2].args.indexOf('-ss') + 1]), 0.5);
    for (const { args } of mediaCalls.slice(1)) assert.equal(Number(args[args.indexOf('-t') + 1]), 3);
    await access(ready.preview.originalPath); await access(ready.preview.processedPath);
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('rendering another clip preserves both cached comparison videos', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blur-preview-cache-'));
  const source: MediaInfo = { duration: 10, width: 320, height: 180, fps: 60, hasAudio: false, codec: 'h264' };
  const clips: Clip[] = ['A', 'B'].map(id => ({ id, path: path.join(directory, `${id}.mp4`), name: `${id}.mp4`, ...source, mediaUrl: '' }));
  const engine: EngineStatus = { ready: true, directory, blurPath: 'blur-cli', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', issues: [] };
  const events: WorkerEvent[] = [];
  const manager = new JobManager({
    engine: () => engine, emit: event => events.push(event), workDirectory: path.join(directory, 'work'),
    inspect: async file => clips.some(clip => clip.path === file) ? source : { ...source, duration: 4 },
    runner: async (command, args) => {
      await writeFile(command === 'blur-cli' ? args[args.indexOf('-o') + 1] : args.at(-1)!, 'fixture adapter output');
      return { stdout: '', stderr: '' };
    },
  });
  try {
    await manager.preview(clips[0], 2, DEFAULT_SETTINGS);
    await manager.preview(clips[1], 2, DEFAULT_SETTINGS);
    const ready = events.filter(event => event.type === 'preview-ready');
    assert.equal(ready.length, 2);
    for (const event of ready) if (event.type === 'preview-ready') {
      await access(event.preview.originalPath); await access(event.preview.processedPath);
    }
    await manager.dispose();
    assert.deepEqual(await readdir(path.join(directory, 'work')), []);
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});
