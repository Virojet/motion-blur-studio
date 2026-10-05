import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CancelledError, createBlurArgs, createBlurConfig, detectEngine, JobManager, nextOutputPath, parseProbe,
  runProcess, settingsKey, validateRenderedClip, validateSettings,
} from '../src/main/engine';
import { DEFAULT_SETTINGS, type Clip, type EngineStatus } from '../src/shared/types';

const source = { duration: 5, width: 320, height: 180, hasAudio: true };
const rendered = { ...source, fps: 60, codec: 'h264', videoDuration: 5, audioDuration: 5, videoStart: 0, audioStart: 0 };

function configValue(config: string, key: string): string {
  const line = config.split(/\r?\n/).find(row => row.startsWith(`${key}:`));
  assert.ok(line, `Config is missing ${key}`);
  return line.slice(key.length + 1).trim();
}

test('preset strength is scaled to the selected output FPS', () => {
  for (const strength of [0.25, 0.5, 1]) {
    for (const outputFps of [30, 60, 120] as const) {
      const config = createBlurConfig({ ...DEFAULT_SETTINGS, strength, outputFps });
      assert.equal(Number(configValue(config, 'blur amount')), strength * outputFps / 60);
      assert.equal(Number(configValue(config, 'blur output fps')), outputFps);
    }
  }
});

test('advanced settings are represented in an engine configuration', () => {
  const config = createBlurConfig({ ...DEFAULT_SETTINGS, interpolationMultiplier: 3, weighting: 'pyramid', quality: 21, deduplicate: false, gpuInterpolation: false });
  assert.equal(configValue(config, 'interpolated fps'), '3x');
  assert.equal(configValue(config, 'blur weighting'), 'pyramid');
  assert.match(config, /21/);
  assert.match(config, /deduplicate:\s*(false|no)/);
  assert.match(config, /gpu interpolation:\s*(false|no)/);
});

test('invalid settings cannot inject engine configuration', () => {
  for (const invalid of [
    { ...DEFAULT_SETTINGS, strength: NaN },
    { ...DEFAULT_SETTINGS, outputFps: 59 },
    { ...DEFAULT_SETTINGS, interpolationMultiplier: -5 },
    { ...DEFAULT_SETTINGS, quality: 99 },
    { ...DEFAULT_SETTINGS, weighting: 'equal\ncustom ffmpeg filters: movie=other.mp4' },
  ]) assert.throws(() => validateSettings(invalid as typeof DEFAULT_SETTINGS));
  assert.deepEqual(validateSettings({ ...DEFAULT_SETTINGS }), DEFAULT_SETTINGS);
});

test('settings keys change when a render-affecting setting changes', () => {
  const key = settingsKey(DEFAULT_SETTINGS);
  assert.equal(key, settingsKey({ ...DEFAULT_SETTINGS }));
  assert.notEqual(key, settingsKey({ ...DEFAULT_SETTINGS, outputFps: 120 }));
  assert.notEqual(key, settingsKey({ ...DEFAULT_SETTINGS, gpuInterpolation: false }));
});

test('CLI paths remain individual literal arguments, including shell-like filenames', async () => {
  const input = 'C:\\clips\\space 空間 & $(literal).mp4';
  const output = 'C:\\clips\\out ; literal.mp4';
  const config = 'C:\\work\\config with spaces.cfg';
  const args = createBlurArgs(input, output, config);
  assert.ok(args.includes(input));
  assert.ok(args.includes(output));
  assert.ok(args.includes(config));
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', input, output, config], {});
  assert.deepEqual(JSON.parse(result.stdout), [input, output, config]);
});

test('exports select a collision-free MP4 name beside the source', async () => {
  const input = path.join(os.tmpdir(), 'clip 空間.mov');
  const visited: string[] = [];
  const folder = path.join(path.dirname(input), 'Blurred');
  const occupied = new Set([path.join(folder, 'clip 空間 - blurred.mp4'), path.join(folder, 'clip 空間 - blurred (2).mp4')]);
  const candidate = await nextOutputPath(input, null, async file => { visited.push(file); return occupied.has(file); });
  assert.equal(path.dirname(candidate), path.join(path.dirname(input), 'Blurred'));
  assert.equal(path.extname(candidate), '.mp4');
  assert.equal(new Set(visited).size, visited.length);
  assert.equal(candidate, visited[2]);
  assert.match(path.basename(candidate), /\(3\)/);
});

test('a custom destination controls the output directory', async () => {
  const destination = path.join(os.tmpdir(), 'my exports');
  const candidate = await nextOutputPath('/some/clip.mp4', destination, async () => false);
  assert.equal(path.dirname(candidate), destination);
});

test('an incomplete engine installation presents actionable setup issues', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blur-incomplete-'));
  try {
    const status = await detectEngine(directory);
    assert.equal(status.ready, false);
    assert.equal(status.blurPath, null);
    assert.ok(status.issues.some(issue => /install|blur-cli/i.test(issue)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('FFprobe rational rates and stream timing are parsed accurately', () => {
  const info = parseProbe({
    format: { duration: '5.021333' },
    streams: [
      { codec_type: 'audio', codec_name: 'aac', duration: '5.021333', start_time: '0.000000' },
      { codec_type: 'video', codec_name: 'h264', width: 320, height: 180, avg_frame_rate: '120000/1001', r_frame_rate: '120000/1001', duration: '5.005000', start_time: '0.000000' },
    ],
  });
  assert.equal(info.width, 320);
  assert.equal(info.height, 180);
  assert.ok(Math.abs(info.fps - 120000 / 1001) < 0.00001);
  assert.equal(info.hasAudio, true);
  assert.equal(info.codec, 'h264');
  assert.equal(info.videoDuration, 5.005);
  assert.equal(info.audioDuration, 5.021333);
});

test('missing video and corrupt metadata cannot become valid clips', () => {
  for (const raw of [null, {}, { streams: [] }, { streams: [{ codec_type: 'audio' }] }, { streams: [{ codec_type: 'video', width: 0, height: 0, avg_frame_rate: '0/0' }], format: { duration: 'N/A' } }]) {
    assert.throws(() => parseProbe(raw));
  }
});

test('render validation checks resolution, FPS, duration, audio and codec', () => {
  assert.doesNotThrow(() => validateRenderedClip(rendered, source, 60));
  for (const invalid of [
    { ...rendered, width: 640 },
    { ...rendered, fps: 30 },
    { ...rendered, duration: 1, videoDuration: 1 },
    { ...rendered, hasAudio: false, audioDuration: undefined },
    { ...rendered, codec: 'hevc' },
    { ...rendered, audioStart: 1 },
    { ...rendered, audioDuration: 1 },
  ]) assert.throws(() => validateRenderedClip(invalid, source, 60));
  assert.doesNotThrow(() => validateRenderedClip({ ...rendered, duration: 3, videoDuration: 3, audioDuration: 3 }, source, 60, 3));
  assert.doesNotThrow(() => validateRenderedClip({ ...rendered, hasAudio: false, audioDuration: undefined }, { ...source, hasAudio: false }, 60));
});

test('process cancellation terminates spawned children as well as the runner', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blur-cancel-'));
  const marker = path.join(directory, 'child-survived.txt');
  const controller = new AbortController();
  let childPid: number | undefined;
  let resolveStarted!: () => void;
  const started = new Promise<void>(resolve => { resolveStarted = resolve; });
  const childCode = "const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(process.argv[1],'survived'),1200);setInterval(()=>{},1000)";
  const parentCode = `const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(childCode)},process.argv[1]],{windowsHide:true});process.stdout.write(String(child.pid)+'\\n');setInterval(()=>{},1000)`;
  const pending = runProcess(process.execPath, ['-e', parentCode, marker], {
    signal: controller.signal,
    onData: data => { const pid = Number(data.trim()); if (Number.isInteger(pid) && pid > 0) { childPid = pid; resolveStarted(); } },
  });
  // Observe rejection immediately so abort cannot produce an unhandled rejection.
  const rejected = assert.rejects(pending, /cancel|abort/i);
  try {
    await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Child did not start')), 3000))]);
    controller.abort();
    await rejected;
    await new Promise(resolve => setTimeout(resolve, 1500));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally {
    controller.abort();
    if (childPid) { try { process.kill(childPid); } catch { /* already terminated */ } }
    await rm(directory, { recursive: true, force: true });
  }
});

test('an exit-zero engine with no output fails validation and the batch continues', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blur-queue-'));
  const clips: Clip[] = [1, 2].map(id => ({ id: String(id), path: path.join(directory, `clip ${id}.mp4`), name: `clip ${id}.mp4`, ...source, fps: 120, mediaUrl: '' }));
  for (const clip of clips) await writeFile(clip.path, 'source');
  const events: any[] = [];
  const engine: EngineStatus = { ready: true, directory, blurPath: path.join(directory, 'blur-cli.exe'), ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', issues: [] };
  let renderCalls = 0;
  const manager = new JobManager({
    engine: () => engine, emit: event => events.push(event), workDirectory: path.join(directory, 'work'),
    runner: async () => { renderCalls++; return { stdout: '', stderr: '' }; },
    inspect: async () => rendered,
  });
  try {
    await manager.export(clips, DEFAULT_SETTINGS, path.join(directory, 'output'));
    assert.equal(renderCalls, 2, 'Second clip must run after the first fails.');
    const jobs = events.filter(event => event.type === 'job').map(event => event.job);
    assert.equal(jobs.filter(job => job.status === 'failed').length, 2);
    assert.equal(jobs.filter(job => job.status === 'completed').length, 0);
    const firstFailure = jobs.findIndex(job => job.clipId === '1' && job.status === 'failed');
    const secondRender = jobs.findIndex(job => job.clipId === '2' && job.status === 'rendering');
    assert.ok(firstFailure >= 0 && secondRender > firstFailure, 'Jobs must render serially.');
    assert.equal(manager.busy, false);
    assert.equal(events.at(-1)?.busy, false);
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('validation failure advances the queue and settings/clip snapshots survive caller edits', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blur-snapshot-'));
  const clips: Clip[] = [1, 2].map(id => ({ id: String(id), path: path.join(directory, `clip ${id}.mp4`), name: `clip ${id}.mp4`, ...source, fps: 120, mediaUrl: '' }));
  const secondPath = clips[1].path;
  const settings = { ...DEFAULT_SETTINGS };
  const events: any[] = [], strengths: number[] = [], inputs: string[] = [];
  const engine: EngineStatus = { ready: true, directory, blurPath: 'blur-cli', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', issues: [] };
  let renders = 0;
  const manager = new JobManager({
    engine: () => engine, emit: event => events.push(event), workDirectory: path.join(directory, 'work'),
    runner: async (_command, args) => {
      renders++;
      inputs.push(args[args.indexOf('-i') + 1]);
      strengths.push(Number(configValue(await readFile(args[args.indexOf('-c') + 1], 'utf8'), 'blur amount')));
      // Unit boundary: the probe adapter represents decoded media. Real output
      // validity is independently exercised by scripts/verify-engine.ts.
      await writeFile(args[args.indexOf('-o') + 1], 'simulated encoded output');
      if (renders === 1) { settings.strength = 1; clips[1].path = path.join(directory, 'edited-after-export.mp4'); }
      return { stdout: '', stderr: '' };
    },
    inspect: async file => file.includes('.part.mp4') && renders === 1 ? { ...rendered, fps: 30 } : rendered,
  });
  try {
    await manager.export(clips, settings, path.join(directory, 'output'));
    assert.deepEqual(strengths, [0.5, 0.5]);
    assert.equal(inputs[1], secondPath);
    const jobs = events.filter(event => event.type === 'job').map(event => event.job);
    assert.ok(jobs.some(job => job.clipId === '1' && job.status === 'failed' && /frame rate/i.test(job.message)));
    const complete = jobs.find(job => job.clipId === '2' && job.status === 'completed');
    assert.ok(complete?.outputPath);
    assert.equal(await readFile(complete.outputPath, 'utf8'), 'simulated encoded output');
    assert.equal((await readdir(path.join(directory, 'output'))).filter(name => name.endsWith('.lock') || name.includes('.part.')).length, 0);
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('cancelling a batch cancels waiting jobs and removes partial files and locks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blur-queued-cancel-'));
  const clips: Clip[] = [1, 2].map(id => ({ id: String(id), path: path.join(directory, `clip ${id}.mp4`), name: `clip ${id}.mp4`, ...source, fps: 120, mediaUrl: '' }));
  const events: any[] = [];
  const engine: EngineStatus = { ready: true, directory, blurPath: 'blur-cli', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', issues: [] };
  let renders = 0, started!: () => void;
  const rendering = new Promise<void>(resolve => { started = resolve; });
  const manager = new JobManager({
    engine: () => engine, emit: event => events.push(event), workDirectory: path.join(directory, 'work'),
    runner: async (_command, args, options) => {
      renders++;
      await writeFile(args[args.indexOf('-o') + 1], 'partial data');
      started();
      return new Promise((_resolve, reject) => {
        if (options?.signal?.aborted) reject(new CancelledError());
        else options?.signal?.addEventListener('abort', () => reject(new CancelledError()), { once: true });
      });
    },
    inspect: async () => rendered,
  });
  try {
    const exporting = manager.export(clips, DEFAULT_SETTINGS, path.join(directory, 'output'));
    await rendering;
    assert.equal(manager.busy, true);
    await assert.rejects(manager.preview(clips[0], 0, DEFAULT_SETTINGS), /wait|current|cancel/i);
    await manager.cancel();
    await exporting;
    assert.equal(renders, 1);
    assert.equal(manager.busy, false);
    const cancelled = events.filter(event => event.type === 'job' && event.job.status === 'cancelled');
    assert.deepEqual(cancelled.map(event => event.job.clipId), ['1', '2']);
    assert.deepEqual(await readdir(path.join(directory, 'output')), []);
    assert.deepEqual(await readdir(path.join(directory, 'work')), []);
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});
