import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { detectEngine, inspectClip, JobManager, parseProbe, validateRenderedClip } from '../src/main/engine';
import { DEFAULT_SETTINGS, type Clip } from '../src/shared/types';
import { createFixtures, edgeProfile, locateTool, probeRaw } from '../tests/fixtures';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

async function main(): Promise<void> {
  const engineDirectory = option('--engine');
  const directory = path.resolve(option('--output') ?? 'artifacts/engine-verification');
  await mkdir(directory, { recursive: true });
  const engine = await detectEngine(engineDirectory ? path.resolve(engineDirectory) : null);
  assert.ok(engine.ready, `Real Blur installation is required: ${engine.issues.join('; ')}`);
  assert.ok(engine.ffmpegPath && engine.ffprobePath && engine.blurPath);
  const ffmpeg = await locateTool('ffmpeg', path.dirname(engine.ffmpegPath));
  const ffprobe = await locateTool('ffprobe', path.dirname(engine.ffprobePath));
  console.log(`Using real Blur engine: ${engine.blurPath}`);
  const fixtures = await createFixtures(path.join(directory, 'fixtures'), ffmpeg);
  const clips: Clip[] = [];
  for (const file of [fixtures.audio, fixtures.silent]) {
    const clip = await inspectClip(file);
    clips.push({ ...clip, mediaUrl: '' });
    assert.equal(clip.width, 320);
    assert.equal(clip.height, 180);
    assert.ok(Math.abs(clip.duration - 5) < 0.1);
    assert.ok(Math.abs(clip.fps - 120) < 0.01);
  }
  assert.equal(clips[0].hasAudio, true);
  assert.equal(clips[1].hasAudio, false);
  const corrupt = path.join(directory, 'fixtures', 'unsupported corrupted.mp4');
  await writeFile(corrupt, 'This file is deliberately not a video.');
  await assert.rejects(inspectClip(corrupt), 'Corrupt media must not enter the clip queue.');

  const events: any[] = [];
  const statuses = new Map<string, string>();
  const manager = new JobManager({
    engine: () => engine,
    workDirectory: path.join(directory, 'work'),
    emit: event => {
      events.push(event);
      if (event.type === 'job' && statuses.get(event.job.id) !== event.job.status) {
        statuses.set(event.job.id, event.job.status);
        console.log(`${event.job.kind} ${event.job.clipId} ${event.job.status}: ${event.job.message}`);
      }
    },
  });
  // Exercise the default SVP interpolation/strength/CRF while avoiding a GPU
  // dependency in this repeatable verification. GPU availability varies by PC.
  const settings = { ...DEFAULT_SETTINGS, gpuInterpolation: false };
  const completed: { source: string; output: string; settings: typeof settings; probe: unknown }[] = [];
  try {
    await manager.export(clips, settings, path.join(directory, 'exports'));
    const failed = events.filter(event => event.type === 'job' && event.job.status === 'failed');
    if (failed.length) throw new Error(failed.map(event => `${event.job.message}\n${event.job.log ?? ''}`).join('\n'));
    for (const clip of clips) {
      const event = events.find(event => event.type === 'job' && event.job.clipId === clip.id && event.job.status === 'completed');
      assert.ok(event?.job.outputPath, `Export did not complete: ${clip.name}`);
      const raw = await probeRaw(ffprobe, event.job.outputPath);
      const info = parseProbe(raw);
      validateRenderedClip(info, clip, settings.outputFps);
      assert.equal(info.hasAudio, clip.hasAudio, 'Audio presence must be retained.');
      completed.push({ source: clip.path, output: event.job.outputPath, settings, probe: raw });
    }

    const before = await edgeProfile(ffmpeg, clips[0].path);
    const balanced = await edgeProfile(ffmpeg, completed[0].output);
    // Optical-flow interpolation can hold this repeating synthetic pattern near
    // source frames. Strong spans neighboring native frames and must blur it.
    const strongSettings = { ...settings, strength: 1 };
    const strongEventStart = events.length;
    await manager.export([clips[0]], strongSettings, path.join(directory, 'exports'));
    const strongEvent = events.slice(strongEventStart).find(event => event.type === 'job' && event.job.status === 'completed');
    assert.ok(strongEvent?.job.outputPath, 'Strong render must complete.');
    const strongRaw = await probeRaw(ffprobe, strongEvent.job.outputPath);
    validateRenderedClip(parseProbe(strongRaw), clips[0], strongSettings.outputFps);
    completed.push({ source: clips[0].path, output: strongEvent.job.outputPath, settings: strongSettings, probe: strongRaw });
    const after = await edgeProfile(ffmpeg, strongEvent.job.outputPath);
    assert.ok(before.range > 150 && after.range > 30, 'Fixtures must contain a visible moving stripe.');
    assert.ok(after.intermediate > before.intermediate + 1,
      `Strong motion blur must visibly spread moving edges; intermediate pixels before=${before.intermediate}, after=${after.intermediate}.`);

    for (const clip of clips) {
      await manager.preview(clip, 1, settings);
      const event = [...events].reverse().find(event => event.type === 'preview-ready' && event.preview.clipId === clip.id);
      assert.ok(event, `Preview did not complete for ${clip.name}`);
      assert.equal(event.preview.start, 1);
      assert.ok(Math.abs(event.preview.duration - 3) < 0.05);
      for (const file of [event.preview.originalPath, event.preview.processedPath]) {
        const info = parseProbe(await probeRaw(ffprobe, file));
        assert.equal(info.hasAudio, clip.hasAudio);
        assert.ok(Math.abs(info.duration - 3) < 0.15, 'Preview files must contain the same three-second sample.');
      }
      const blurred = parseProbe(await probeRaw(ffprobe, event.preview.processedPath));
      assert.equal(blurred.codec, 'vp9', 'Preview must use the browser-compatible VP9 proxy.');
      assert.equal(blurred.width, clip.width);
      assert.equal(blurred.height, clip.height);
      assert.ok(Math.abs(blurred.fps - settings.outputFps) < 0.1);
      assert.ok(Math.abs(blurred.duration - 3) < 0.15);
      if (clip.hasAudio && blurred.videoStart !== undefined && blurred.audioStart !== undefined) {
        assert.ok(Math.abs(blurred.videoStart - blurred.audioStart) < 0.15, 'Preview audio and video must start together.');
      }
    }

    const blockedDestination = path.join(directory, 'destination-is-a-file');
    await writeFile(blockedDestination, 'This is not a directory.');
    const previousEvents = events.length;
    await manager.export([clips[0]], settings, blockedDestination);
    assert.ok(events.slice(previousEvents).some(event => event.type === 'job' && event.job.status === 'failed'), 'An unusable destination must produce a readable failed job.');
    assert.equal(manager.busy, false);

    await writeFile(path.join(directory, 'report.json'), JSON.stringify({
      verifiedAt: new Date().toISOString(), engine, settings, exports: completed,
      visibleBlur: { before, balanced, strong: after }, limitations: balanced.intermediate <= before.intermediate ? [
        'At the sampled source-frame time, Balanced SVP interpolation holds this repeating synthetic checkerboard. Strong creates a measured luminance ramp; blur appearance depends on clip motion and interpolation.',
      ] : [], assertions: [
        'Real SVP engine exports audio and silent clips with spaces and Chinese filenames.',
        'Output retains resolution, audio, duration and uses 60 FPS H.264.',
        'Strong SVP motion blur spreads moving hard edges into intermediate luminance.',
        'Real previews retain synchronized three-second samples.',
        'Corrupt input and unusable output destinations fail safely.',
      ],
    }, null, 2));
    await rm(path.join(directory, 'failure.json'), { force: true });
    console.log(`Real rendering verified. Report and clips: ${directory}`);
  } catch (error) {
    await writeFile(path.join(directory, 'failure.json'), JSON.stringify({ error: error instanceof Error ? error.message : String(error), events }, null, 2));
    throw error;
  } finally { await manager.dispose(); }
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
