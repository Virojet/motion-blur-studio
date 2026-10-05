import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { AppEvent, BlurSettings, Clip, EngineStatus, JobUpdate } from '../shared/types.js';

export type WorkerEvent = Exclude<AppEvent, { type: 'preview' }> | {
  type: 'preview-ready';
  preview: { clipId: string; originalPath: string; processedPath: string; start: number; duration: number; settingsKey: string };
};
export interface MediaInfo {
  duration: number; width: number; height: number; fps: number; hasAudio: boolean; codec: string;
  videoDuration?: number; audioDuration?: number; videoStart?: number; audioStart?: number;
}
export interface ProcessOptions {
  cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  onData?: (data: string, stream: 'stdout' | 'stderr') => void; timeoutMs?: number;
  acceptedExitCodes?: number[];
}
export interface ProcessResult { stdout: string; stderr: string }

export class CancelledError extends Error {
  constructor() { super('Cancelled'); this.name = 'CancelledError'; }
}

/** Terminate descendants first; Blur launches both VSPipe and FFmpeg. */
async function terminateTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      let errorText = '';
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
      const timer = setTimeout(() => { killer.kill(); reject(new Error('Windows could not stop the render process tree.')); }, 5000);
      killer.stderr.setEncoding('utf8'); killer.stderr.on('data', (data: string) => { errorText += data; });
      killer.once('error', error => { clearTimeout(timer); reject(error); });
      killer.once('close', code => {
        clearTimeout(timer);
        if (code === 0 || /not found|no running instance/i.test(errorText)) resolve();
        else reject(new Error(`Windows could not stop the render process tree: ${errorText.trim() || `taskkill exited with ${code}`}`));
      });
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

/** No shell interpolation, bounded capture, cancellation of the entire process tree. */
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', timeout = false, killing: Promise<void> | undefined;
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = () => {
      if (child.pid && !killing) killing = terminateTree(child.pid).catch(error => {
        // In restricted environments taskkill may be denied. Report that clearly
        // and release owned handles instead of leaving cancellation pending forever.
        try { child.kill('SIGKILL'); } catch { /* preserve the process-tree error */ }
        child.stdout.destroy(); child.stderr.destroy(); clear(); reject(error);
      });
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { timeout = true; stop(); }, options.timeoutMs) : undefined;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { stdout = (stdout + data).slice(-2_000_000); options.onData?.(data, 'stdout'); });
    child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-2_000_000); options.onData?.(data, 'stderr'); });
    const clear = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', stop); };
    child.once('error', (error) => { clear(); reject(new Error(`Could not start ${path.basename(command)}: ${error.message}`)); });
    child.once('close', async (code) => {
      clear();
      try { await killing; } catch (error) { reject(error); return; }
      if (options.signal?.aborted) reject(new CancelledError());
      else if (timeout) reject(new Error(`${path.basename(command)} timed out.`));
      else if (!(options.acceptedExitCodes ?? [0]).includes(code ?? -1)) reject(new Error(`${path.basename(command)} exited with code ${code}.\n${stderr || stdout}`));
      else resolve({ stdout, stderr });
    });
    // Cover cancellation between the initial check and registration.
    if (options.signal?.aborted) stop();
  });
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}
async function firstFile(files: string[]): Promise<string | null> {
  for (const file of files) { try { if ((await fs.stat(file)).isFile()) return file; } catch { /* next */ } }
  return null;
}
async function fromPath(name: string): Promise<string | null> {
  return firstFile((process.env.PATH || '').split(path.delimiter).filter(Boolean).map(folder => path.join(folder.replace(/^"|"$/g, ''), name)));
}
let lastEngine: EngineStatus | null = null;

async function registryLocations(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const appKey = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{D283CF94-CD1F-432D-B4BE-0516562C258B}_is1';
  const results = await Promise.all(['HKCU', 'HKLM'].map(async hive => {
    try {
      const result = await runProcess(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
        ['query', `${hive}\\${appKey}`, '/v', 'InstallLocation'], { timeoutMs: 3000 });
      return result.stdout.match(/InstallLocation\s+REG_\w+\s+(.+)/)?.[1]?.trim() || '';
    } catch { return ''; }
  }));
  return results.filter(Boolean);
}

export async function detectEngine(directory: string | null): Promise<EngineStatus> {
  const exe = process.platform === 'win32' ? 'blur-cli.exe' : 'blur-cli';
  const ffmpeg = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const ffprobe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const vspipe = process.platform === 'win32' ? 'vspipe.exe' : 'vspipe';
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = directory ? [directory, path.join(directory, 'blur')] : [
    process.env.MOTION_BLUR_ENGINE, process.env.BLUR_ENGINE_DIRECTORY,
    resources && path.join(resources, 'engine'), path.join(path.dirname(process.execPath), 'engine'),
    path.join(process.cwd(), 'engine'), path.join(process.cwd(), 'tools', 'blur'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'blur'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'blur'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'blur'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Motion Blur Engine'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'blur'),
    ...(await registryLocations()),
  ].filter((item): item is string => !!item);
  let blurPath: string | null = null;
  for (const folder of candidates) {
    blurPath = await firstFile([path.join(folder, exe), path.join(folder, 'bin', exe)]);
    if (blurPath) break;
  }
  if (!blurPath && !directory) blurPath = await fromPath(exe);
  const root = blurPath ? path.dirname(blurPath) : directory;
  const localTools = (name: string) => root ? [path.join(root, 'lib', 'ffmpeg', name), path.join(root, 'ffmpeg', name), path.join(root, name)] : [];
  const ffmpegPath = await firstFile(localTools(ffmpeg)) || await fromPath(ffmpeg);
  const ffprobePath = await firstFile(localTools(ffprobe)) || await fromPath(ffprobe);
  const issues: string[] = [];
  if (!blurPath) issues.push('Blur is not installed or the folder does not contain blur-cli.exe. Finish installing Tekno’s Blur, then select its installation folder.');
  if (!ffmpegPath) issues.push('FFmpeg is missing. Install the complete official Blur Windows package.');
  if (!ffprobePath) issues.push('FFprobe is missing. Install the complete official Blur Windows package.');
  if (root && blurPath) {
    const pipe = await firstFile([path.join(root, 'lib', 'vapoursynth', vspipe), path.join(root, 'vapoursynth', vspipe), path.join(root, vspipe)]) || await fromPath(vspipe);
    if (!pipe) issues.push('VapourSynth / vspipe.exe is missing. Select the complete installation, including the lib folder.');
    if (!await exists(path.join(root, 'lib', 'blur.py')) || !await exists(path.join(root, 'lib', 'blur'))) issues.push('Blur’s processing scripts are missing from lib. Reinstall the complete official package.');
    if (process.platform === 'win32' && !await exists(path.join(root, 'lib', 'models'))) issues.push('The bundled RIFE model resources are missing from lib/models. Blur requires them even with SVP selected.');
    if (process.platform === 'win32') {
      const pluginFolders = [path.join(root, 'lib', 'vapoursynth', 'vs-plugins'), path.join(root, 'vapoursynth-plugins')];
      const required = ['svpflow1_vs64.dll', 'svpflow2_vs64.dll', 'akarin.dll', 'LSMASHSource.dll'];
      for (const plugin of required) {
        if (!await firstFile(pluginFolders.map(folder => path.join(folder, plugin)))) issues.push(`The bundled VapourSynth plugin ${plugin} is missing. Reinstall the complete official package.`);
      }
    }
  }
  lastEngine = { ready: issues.length === 0, directory: root, blurPath, ffmpegPath, ffprobePath, issues };
  return lastEngine;
}

function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}
export function frameRate(value: unknown): number {
  if (typeof value !== 'string') return finiteNumber(value) || 0;
  const [n, d = '1'] = value.split('/');
  const result = Number(n) / Number(d);
  return Number.isFinite(result) && result > 0 ? result : 0;
}
export function parseProbe(raw: unknown): MediaInfo {
  if (!raw || typeof raw !== 'object') throw new Error('The media inspector returned invalid information.');
  const data = raw as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  const video = data.streams?.find(stream => stream.codec_type === 'video' && !(stream.disposition as { attached_pic?: number })?.attached_pic);
  const audio = data.streams?.find(stream => stream.codec_type === 'audio');
  if (!video) throw new Error('This file has no playable video stream.');
  const duration = finiteNumber(video.duration) || finiteNumber(data.format?.duration) || 0;
  const width = finiteNumber(video.width) || 0, height = finiteNumber(video.height) || 0;
  const fps = frameRate(video.avg_frame_rate) || frameRate(video.r_frame_rate);
  if (duration <= 0 || !width || !height || !fps) throw new Error('The video duration, dimensions, or frame rate could not be read.');
  const colorTransfer = String(video.color_transfer || '');
  if (['smpte2084', 'arib-std-b67'].includes(colorTransfer)) throw new Error('HDR clips need to be converted to SDR first to keep the preview and export colors consistent.');
  return { duration, width, height, fps, hasAudio: !!audio, codec: String(video.codec_name || ''),
    videoDuration: finiteNumber(video.duration), audioDuration: finiteNumber(audio?.duration),
    videoStart: finiteNumber(video.start_time), audioStart: finiteNumber(audio?.start_time) };
}
export async function probeMedia(file: string, ffprobePath: string, signal?: AbortSignal): Promise<MediaInfo> {
  const result = await runProcess(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal, timeoutMs: 60_000 });
  let data: unknown;
  try { data = JSON.parse(result.stdout); } catch { throw new Error('FFprobe returned invalid media information.'); }
  return parseProbe(data);
}
export async function inspectClip(file: string, ffprobePath?: string): Promise<Omit<Clip, 'mediaUrl'>> {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error('Choose a valid local video file.');
  if (!(await fs.stat(file)).isFile()) throw new Error('Choose a video file, not a folder.');
  const engine = lastEngine || await detectEngine(null);
  const probe = ffprobePath || engine.ffprobePath;
  if (!probe) throw new Error('Install the full Blur engine to inspect clips (FFprobe is missing).');
  const info = await probeMedia(file, probe);
  return { id: randomUUID(), path: file, name: path.basename(file), duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio };
}

export function validateSettings(value: unknown): BlurSettings {
  if (!value || typeof value !== 'object') throw new Error('Invalid blur settings.');
  const s = value as BlurSettings;
  if (!Number.isFinite(s.strength) || s.strength < 0 || s.strength > 2) throw new Error('Blur strength must be between 0 and 2.');
  if (![30, 60, 120].includes(s.outputFps)) throw new Error('Choose 30, 60, or 120 output FPS.');
  if (!Number.isInteger(s.interpolationMultiplier) || s.interpolationMultiplier < 2 || s.interpolationMultiplier > 10) throw new Error('Interpolation multiplier must be an integer between 2 and 10.');
  if (!['svp', 'rife'].includes(s.interpolationMethod)) throw new Error('Choose SVP or RIFE interpolation.');
  if (!['equal', 'gaussian_sym', 'pyramid', 'vegas'].includes(s.weighting)) throw new Error('Invalid blur weighting.');
  if (!Number.isInteger(s.quality) || s.quality < 0 || s.quality > 51) throw new Error('Quality must be an integer from 0 to 51.');
  for (const key of ['interpolate', 'deduplicate', 'gpuInterpolation', 'gpuDecoding', 'gpuEncoding'] as const) {
    if (typeof s[key] !== 'boolean') throw new Error(`Invalid ${key} setting.`);
  }
  // Field order matches DEFAULT_SETTINGS and the renderer's staleness comparison.
  return { strength: s.strength, outputFps: s.outputFps, interpolate: s.interpolate,
    interpolationMultiplier: s.interpolationMultiplier, interpolationMethod: s.interpolationMethod,
    weighting: s.weighting, deduplicate: s.deduplicate, quality: s.quality,
    gpuInterpolation: s.gpuInterpolation, gpuDecoding: s.gpuDecoding, gpuEncoding: s.gpuEncoding };
}
export function settingsKey(value: BlurSettings): string { return JSON.stringify(validateSettings(value)); }

/** Every setting is explicit; never consume the user's original Blur presets. */
export function createBlurConfig(value: BlurSettings, options: { rifeModel?: string } = {}): string {
  const s = validateSettings(value);
  const model = options.rifeModel || 'rife-v4.26_ensembleFalse';
  if (!/^[\w.-]+$/.test(model)) throw new Error('Invalid RIFE model name.');
  return [
    '[blur]', '', '- blur', 'blur: true', `blur amount: ${Number((s.strength * s.outputFps / 60).toFixed(6))}`,
    `blur output fps: ${s.outputFps}`, `blur weighting: ${s.weighting}`, 'blur gamma: 1', '',
    '- interpolation', `interpolate: ${s.interpolate}`, `interpolated fps: ${s.interpolationMultiplier}x`, `interpolation method: ${s.interpolationMethod}`,
    '', '- pre-interpolation', 'pre-interpolate: false', 'pre-interpolated fps: 360', '',
    '- deduplication', `deduplicate: ${s.deduplicate}`, `deduplicate method: ${s.interpolationMethod}`, '',
    '- rendering', 'encode preset: h264', `quality: ${s.quality}`, 'preview: false', 'detailed filenames: false', 'copy dates: false', '',
    '- gpu acceleration', `gpu decoding: ${s.gpuDecoding}`, `gpu interpolation: ${s.gpuInterpolation}`, `gpu encoding: ${s.gpuEncoding}`, '',
    '- timescale', 'timescale: false', 'input timescale: 1', 'output timescale: 1', 'adjust timescaled audio pitch: false', '',
    '- filters', 'filters: false', 'brightness: 1', 'saturation: 1', 'contrast: 1', '',
    '- advanced', 'advanced: true', 'deduplicate range: 2', 'deduplicate threshold: 0.001', 'video container: mp4',
    'custom ffmpeg filters:', 'debug: false', 'blur weighting gaussian std dev: 1', 'blur weighting gaussian mean: 2',
    'blur weighting gaussian bound: [0,2]', 'svp interpolation preset: weak', 'svp interpolation algorithm: 13',
    'interpolation block size: 8', 'interpolation mask area: 0', `rife model: ${model}`, 'manual svp: false', '',
  ].join('\n');
}
export function createBlurArgs(input: string, output: string, config: string): string[] {
  return ['-i', input, '-o', output, '-c', config, '-v'];
}
export async function nextOutputPath(source: string, directory: string | null = null, pathExists = exists): Promise<string> {
  const folder = directory || path.join(path.dirname(source), 'Blurred');
  const base = path.parse(source).name;
  for (let number = 1; number < 10_000; number++) {
    const filename = `${base} - blurred${number === 1 ? '' : ` (${number})`}.mp4`;
    const target = path.join(folder, filename);
    if (!await pathExists(target) && !await pathExists(`${target}.lock`)) return target;
  }
  throw new Error('There are too many exports with this filename. Choose a different output folder.');
}
export function validateRenderedClip(info: MediaInfo, source: Pick<Clip, 'width' | 'height' | 'duration' | 'hasAudio'> & Partial<MediaInfo>,
  fps: number, expectedDuration = source.duration): void {
  if (info.width !== source.width || info.height !== source.height) throw new Error('The output resolution does not match the source.');
  if (Math.abs(info.fps - fps) > 0.05) throw new Error(`The output frame rate is ${info.fps.toFixed(2)} FPS, expected ${fps}.`);
  const tolerance = Math.max(0.15, 3 / fps);
  if (Math.abs(info.duration - expectedDuration) > tolerance) throw new Error(`The output is incomplete or has the wrong duration (${info.duration.toFixed(2)}s, expected ${expectedDuration.toFixed(2)}s).`);
  if (source.hasAudio !== info.hasAudio) throw new Error(source.hasAudio ? 'The output is missing the source audio.' : 'The output unexpectedly contains audio.');
  const expectedAudio = source.audioDuration === undefined || expectedDuration !== source.duration ? expectedDuration : source.audioDuration;
  if (source.hasAudio && info.audioDuration !== undefined && Math.abs(info.audioDuration - expectedAudio) > Math.max(0.25, tolerance)) throw new Error('The output audio duration does not match the source.');
  const sourceOffset = (source.audioStart || 0) - (source.videoStart || 0);
  if (info.audioStart !== undefined && info.videoStart !== undefined && Math.abs(info.audioStart - info.videoStart - sourceOffset) > 0.2) throw new Error('The output audio and video start times are out of sync.');
  if (info.codec !== 'h264') throw new Error('The engine did not produce the requested H.264 video.');
}

export interface JobManagerOptions {
  engine: () => EngineStatus; emit: (event: WorkerEvent) => void; workDirectory: string;
  runner?: typeof runProcess;
  inspect?: (file: string, ffprobePath: string, signal?: AbortSignal) => Promise<MediaInfo>;
}

export class JobManager {
  private readonly options: JobManagerOptions;
  private readonly runner: typeof runProcess;
  private readonly inspect: NonNullable<JobManagerOptions['inspect']>;
  private active: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private readonly previewDirectories = new Map<string, string>();
  private readonly retiredDirectories = new Set<string>();
  constructor(options: JobManagerOptions) {
    this.options = options; this.runner = options.runner || runProcess; this.inspect = options.inspect || probeMedia;
  }
  get busy(): boolean { return this.active !== null; }
  private send(job: JobUpdate, patch: Partial<JobUpdate>): void {
    Object.assign(job, patch); this.options.emit({ type: 'job', job: { ...job, ...patch } });
    // Logs are append-only deltas, not a snapshot copied into subsequent events.
    delete job.log;
  }
  private assertEngine(): EngineStatus & { directory: string; blurPath: string; ffmpegPath: string; ffprobePath: string } {
    const engine = this.options.engine();
    if (!engine.ready || !engine.directory || !engine.blurPath || !engine.ffmpegPath || !engine.ffprobePath) throw new Error(engine.issues.join('\n') || 'Select a complete Blur installation first.');
    return engine as EngineStatus & { directory: string; blurPath: string; ffmpegPath: string; ffprobePath: string };
  }
  private start(task: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.busy) return Promise.reject(new Error('Wait for the current preview or export, or cancel it first.'));
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.options.emit({ type: 'busy', busy: true });
    // Defer task until active is installed, including synchronous errors.
    this.active = Promise.resolve().then(() => task(signal)).finally(() => {
      this.active = null; this.controller = null; this.options.emit({ type: 'busy', busy: false });
    });
    return this.active;
  }
  private throwIfCancelled(signal: AbortSignal): void { if (signal.aborted) throw new CancelledError(); }
  private async removeWork(directory: string): Promise<void> {
    const relative = path.relative(path.resolve(this.options.workDirectory), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to clean an unexpected temporary folder.');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  }
  private async makeWork(): Promise<string> {
    await fs.mkdir(this.options.workDirectory, { recursive: true });
    return fs.mkdtemp(path.join(this.options.workDirectory, 'job-'));
  }
  private processOptions(job: JobUpdate, signal: AbortSignal, duration: number, outputFps = 60): ProcessOptions {
    let tail = '', lastProgress = -1, lastEmit = 0;
    return { signal, onData: (data) => {
      tail = (tail + data).slice(-4000);
      // Exclude the settings line "Motion blurred to 60fps (50%)".
      const progressText = tail.split(/[\r\n]/).filter(line => !/motion blurred|blur amount|render settings/i.test(line)).join('\n');
      const percent = [...progressText.matchAll(/([\d.]+)%/g)].at(-1);
      const frameFraction = [...progressText.matchAll(/(?:Frame\s*:?\s*|\()(\d+)\s*\/\s*(\d+)/gi)].at(-1);
      const time = [...progressText.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].at(-1);
      const frames = [...progressText.matchAll(/frame\s*=\s*(\d+)/gi)].at(-1);
      const progress = percent ? Number(percent[1]) / 100 : frameFraction && Number(frameFraction[2]) > 0 ? Number(frameFraction[1]) / Number(frameFraction[2])
        : time ? (Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) / duration : frames ? Number(frames[1]) / (duration * outputFps) : null;
      const now = Date.now();
      // Every log delta is delivered; progress updates are coalesced.
      this.send(job, { log: data });
      if (progress !== null && Number.isFinite(progress) && (now - lastEmit > 200 || progress >= 1) && progress >= lastProgress) {
        lastProgress = progress; lastEmit = now; this.send(job, { progress: Math.max(0, Math.min(0.99, progress)) });
      }
    } };
  }
  private async render(input: string, output: string, settings: BlurSettings, directory: string, job: JobUpdate, signal: AbortSignal, duration: number,
    engine = this.assertEngine()): Promise<void> {
    const config = path.join(directory, 'render.cfg');
    const models = await fs.readdir(path.join(engine.directory, 'lib', 'models')).catch(() => [] as string[]);
    const rifeModel = models.includes('rife-v4.26_ensembleFalse') ? 'rife-v4.26_ensembleFalse' : models.find(name => /^rife[\w.-]*$/.test(name));
    await fs.writeFile(config, createBlurConfig(settings, { rifeModel }), 'utf8');
    // Blur rewrites app settings and probes GPU types; isolate all of that per job.
    const engineData = path.join(directory, 'engine-data');
    await fs.mkdir(path.join(engineData, 'blur'), { recursive: true });
    await fs.writeFile(path.join(engineData, 'blur', 'blur.cfg'), '[blur]\ncheck for updates: false\ninclude beta updates: false\nrife gpu number: -1\n', 'utf8');
    const localTemp = path.join(directory, 'temp');
    await fs.mkdir(localTemp, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, APPDATA: engineData, TEMP: localTemp, TMP: localTemp,
      PATH: [path.join(engine.directory, 'lib', 'ffmpeg'), path.join(engine.directory, 'lib', 'vapoursynth'), engine.directory, process.env.PATH || ''].join(path.delimiter),
      PYTHONPATH: [path.join(engine.directory, 'lib'), process.env.PYTHONPATH || ''].filter(Boolean).join(path.delimiter) };
    this.send(job, { status: 'rendering', progress: null, message: 'Applying motion blur…' });
    const result = await this.runner(engine.blurPath, createBlurArgs(input, output, config),
      { ...this.processOptions(job, signal, duration, settings.outputFps), cwd: engine.directory, env });
    // The official CLI returns 0 even when a child encoder fails.
    if (/Failed to render|Blur failed to initialise|Render exception|could not be found/i.test(result.stdout + '\n' + result.stderr)) throw new Error('Blur could not finish this clip. Expand the log for the engine error. If GPU interpolation failed, turn it off in Advanced and retry.');
    this.throwIfCancelled(signal);
    const outputStat = await fs.stat(output).catch(() => null);
    if (!outputStat?.isFile() || outputStat.size === 0) throw new Error('Blur exited without creating a video. Expand the log for details.');
  }

  preview(clip: Clip, requestedStart: number, inputSettings: BlurSettings): Promise<void> {
    const settings = validateSettings(inputSettings);
    const engine = this.assertEngine();
    if (!Number.isFinite(requestedStart)) return Promise.reject(new Error('Choose a valid preview position.'));
    return this.start(async signal => {
      const job: JobUpdate = { id: randomUUID(), clipId: clip.id, kind: 'preview', status: 'preparing', progress: null, message: 'Preparing a three-second sample…' };
      this.send(job, {});
      let directory: string | null = null;
      let keep = false;
      try {
        directory = await this.makeWork();
        const source = await this.inspect(clip.path, engine.ffprobePath, signal);
        const start = Math.max(0, Math.min(requestedStart, Math.max(0, source.duration - 3)));
        const duration = Math.min(3, source.duration - start);
        // Context supplies neighboring frames for interpolation, blur, and deduplication.
        const context = Math.max(0.5, 4 / source.fps, settings.strength / 60);
        const contextStart = Math.floor(Math.max(0, start - context) * source.fps) / source.fps;
        const contextDuration = Math.min(source.duration - contextStart, start + duration + context - contextStart);
        const sample = path.join(directory, 'sample.mkv');
        const rendered = path.join(directory, 'sample-blurred.mp4');
        // Input seeking jumps to a nearby keyframe, then accurate_seek decodes
        // and discards only the short gap to the requested time. Output seeking
        // would decode every preceding frame in a long gameplay recording.
        await this.runner(engine.ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-ss', contextStart.toFixed(9), '-accurate_seek', '-i', clip.path, '-t', contextDuration.toFixed(9),
          '-map', '0:v:0', '-map', '0:a?', '-c:v', 'ffv1', '-level', '3', '-c:a', 'pcm_s16le', '-fps_mode', 'passthrough', sample],
        { ...this.processOptions(job, signal, contextDuration, source.fps), cwd: engine.directory });
        this.throwIfCancelled(signal);
        const sampleInfo = await this.inspect(sample, engine.ffprobePath, signal);
        await this.render(sample, rendered, settings, directory, job, signal, sampleInfo.duration, engine);
        this.send(job, { status: 'validating', progress: null, message: 'Checking the rendered sample…' });
        const resultInfo = await this.inspect(rendered, engine.ffprobePath, signal);
        validateRenderedClip(resultInfo, { ...sampleInfo }, settings.outputFps);
        const original = path.join(directory, 'before.webm'), processed = path.join(directory, 'after.webm');
        const proxyFilter = "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1";
        this.send(job, { status: 'preparing', message: 'Preparing synchronized comparison…', progress: null });
        for (const [input, output, offset] of [[clip.path, original, start], [rendered, processed, start - contextStart]] as const) {
          await this.runner(engine.ffmpegPath, ['-hide_banner', '-nostdin', '-y', '-ss', offset.toFixed(9), '-accurate_seek', '-i', input, '-t', duration.toFixed(9),
            '-map', '0:v:0', '-map', '0:a?', '-vf', proxyFilter, '-c:v', 'libvpx-vp9', '-crf', '24', '-b:v', '0', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1',
            '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', output], { signal, cwd: engine.directory, onData: data => this.send(job, { log: data }) });
        }
        this.throwIfCancelled(signal);
        const old = this.previewDirectories.get(clip.id);
        this.previewDirectories.set(clip.id, directory); keep = true;
        this.options.emit({ type: 'preview-ready', preview: { clipId: clip.id, originalPath: original, processedPath: processed, start, duration, settingsKey: settingsKey(settings) } });
        this.send(job, { status: 'completed', progress: 1, message: 'Preview ready.' });
        if (old) await this.removeWork(old).catch(() => { this.retiredDirectories.add(old); });
        await Promise.all([sample, rendered].map(file => fs.unlink(file).catch(() => {})));
        const completedDirectory = directory;
        await Promise.all(['engine-data', 'temp'].map(name => this.removeWork(path.join(completedDirectory, name)).catch(() => {})));
      } catch (error) {
        this.send(job, { status: signal.aborted ? 'cancelled' : 'failed', progress: null,
          message: signal.aborted ? 'Preview cancelled.' : friendlyError(error), log: `${error instanceof Error ? error.stack || error.message : String(error)}\n` });
      } finally { if (!keep && directory) await this.removeWork(directory).catch(() => {}); }
    });
  }

  export(clips: Clip[], inputSettings: BlurSettings, outputDirectory: string | null): Promise<void> {
    const settings = validateSettings(inputSettings), engine = this.assertEngine();
    if (!clips.length) return Promise.reject(new Error('Add at least one clip first.'));
    if (outputDirectory !== null && (!path.isAbsolute(outputDirectory) || /[\0\r\n]/.test(outputDirectory))) return Promise.reject(new Error('Choose a valid output folder.'));
    // Snapshot clip objects and settings before queue execution.
    const queue = clips.map(clip => ({ ...clip }));
    return this.start(async signal => {
      const jobs = queue.map(clip => ({ id: randomUUID(), clipId: clip.id, kind: 'export' as const, status: 'queued' as const, progress: null, message: 'Waiting in queue.' } as JobUpdate));
      jobs.forEach(job => this.send(job, {}));
      for (let index = 0; index < queue.length; index++) {
        const clip = queue[index], job = jobs[index];
        if (signal.aborted) { this.send(job, { status: 'cancelled', message: 'Export cancelled.', progress: null }); continue; }
        let directory: string | null = null, partial: string | null = null, lock: string | null = null;
        try {
          directory = await this.makeWork();
          this.send(job, { status: 'preparing', message: 'Preparing export…', progress: null });
          const source = await this.inspect(clip.path, engine.ffprobePath, signal);
          let output: string;
          while (true) {
            output = await nextOutputPath(clip.path, outputDirectory);
            await fs.mkdir(path.dirname(output), { recursive: true });
            try { const handle = await fs.open(`${output}.lock`, 'wx'); await handle.close(); lock = `${output}.lock`; break; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          }
          partial = path.join(path.dirname(output), `.${path.parse(output).name}.${randomUUID()}.part.mp4`);
          await this.render(clip.path, partial, settings, directory, job, signal, source.duration, engine);
          this.send(job, { status: 'validating', message: 'Checking frame rate, resolution, duration, and audio…', progress: null });
          const result = await this.inspect(partial, engine.ffprobePath, signal);
          validateRenderedClip(result, source, settings.outputFps);
          this.throwIfCancelled(signal);
          // Create a final name without overwriting another application's file.
          // Linking is atomic on NTFS and keeps the completed video invisible until validation.
          try { await fs.link(partial, output); await fs.unlink(partial); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') {
              output = await nextOutputPath(clip.path, outputDirectory);
              await fs.link(partial, output); await fs.unlink(partial);
            } else if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code || '')) {
              // FAT/exFAT destinations lack hardlinks. A same-directory rename is atomic;
              // the existing lock protects naming among this app's renderers.
              if (await exists(output)) throw new Error('An output with this name appeared during export. Please retry.');
              await fs.rename(partial, output);
            } else throw error;
          }
          partial = null;
          this.send(job, { status: 'completed', progress: 1, message: 'Export complete.', outputPath: output });
        } catch (error) {
          this.send(job, { status: signal.aborted ? 'cancelled' : 'failed', progress: null,
            message: signal.aborted ? 'Export cancelled.' : friendlyError(error), log: `${error instanceof Error ? error.stack || error.message : String(error)}\n` });
        } finally {
          if (partial) await fs.unlink(partial).catch(() => {});
          if (lock) await fs.unlink(lock).catch(() => {});
          if (directory) await this.removeWork(directory).catch(() => {});
        }
      }
    });
  }
  async cancel(): Promise<void> { this.controller?.abort(); await this.active?.catch(() => {}); }
  async dispose(): Promise<void> {
    await this.cancel();
    await Promise.all([...this.previewDirectories.values(), ...this.retiredDirectories].map(directory => this.removeWork(directory).catch(() => {})));
    this.previewDirectories.clear(); this.retiredDirectories.clear();
  }
}

function friendlyError(error: unknown): string {
  const e = error as NodeJS.ErrnoException;
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return 'The output folder is not writable. Choose a different export folder and retry.';
  if (e?.code === 'ENOSPC') return 'There is not enough free disk space. Free some space or choose another export folder.';
  if (e?.code === 'ENOENT') return 'A clip or engine file is missing. Check the source and engine installation, then retry.';
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 500);
}
