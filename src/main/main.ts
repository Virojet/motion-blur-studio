import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { DEFAULT_SETTINGS, type Preferences, type EngineStatus, type Clip, type AppEvent } from '../shared/types';
import { detectEngine, inspectClip, JobManager, validateSettings, type WorkerEvent } from './engine';
import { MediaRegistry } from './media';
import { installBlurEngine } from './install-engine';
import { appendFileSync, mkdirSync } from 'node:fs';

protocol.registerSchemesAsPrivileged([{ scheme: 'blur-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
if (process.env.MOTION_BLUR_USER_DATA) app.setPath('userData', path.resolve(process.env.MOTION_BLUR_USER_DATA));
app.setName('Motion Blur');
let window: BrowserWindow | null = null;
let preferences: Preferences = { settings: { ...DEFAULT_SETTINGS }, outputDirectory: null, engineDirectory: null };
let engine: EngineStatus;
let manager: JobManager;
let quitting = false;
const media = new MediaRegistry();
const clips = new Map<string, Clip>();
const allowedOutputs = new Set<string>();
let saving = Promise.resolve();
const preferencesPath = () => path.join(app.getPath('userData'), 'preferences.json');

async function loadPreferences() {
  try {
    const value = JSON.parse(await readFile(preferencesPath(), 'utf8'));
    preferences = {
      settings: validateSettings({ ...DEFAULT_SETTINGS, ...value.settings }),
      outputDirectory: typeof value.outputDirectory === 'string' ? value.outputDirectory : null,
      engineDirectory: typeof value.engineDirectory === 'string' ? value.engineDirectory : null,
    };
  } catch { /* Missing or invalid saved preferences use defaults. */ }
}
function savePreferences(): Promise<void> {
  const snapshot = JSON.stringify(preferences, null, 2);
  saving = saving.catch(() => {}).then(async () => {
    await mkdir(app.getPath('userData'), { recursive: true });
    await writeFile(`${preferencesPath()}.tmp`, snapshot, 'utf8');
    await rename(`${preferencesPath()}.tmp`, preferencesPath());
  });
  return saving;
}
function send(event: AppEvent) { if (window && !window.isDestroyed()) window.webContents.send('app:event', event); }
function workerEvent(event: WorkerEvent) {
  if (event.type === 'preview-ready') {
    const { originalPath, processedPath, ...preview } = event.preview;
    send({ type: 'preview', preview: { ...preview, originalUrl: media.register(originalPath), processedUrl: media.register(processedPath) } });
  } else {
    if (event.type === 'job' && event.job.outputPath && event.job.status === 'completed') {
      allowedOutputs.add(path.resolve(event.job.outputPath));
      allowedOutputs.add(path.dirname(path.resolve(event.job.outputPath)));
    }
    send(event);
  }
}
function requireClip(id: unknown): Clip {
  if (typeof id !== 'string' || !clips.has(id)) throw new Error('Choose a clip first.');
  return clips.get(id)!;
}
async function inspectPaths(paths: unknown): Promise<Clip[]> {
  if (!Array.isArray(paths) || paths.length > 500 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Select valid local video files.');
  const result: Clip[] = [];
  for (const filename of [...new Set(paths as string[])]) {
    let clip: Clip;
    try {
      const info = await inspectClip(filename, engine.ffprobePath || undefined);
      clip = { ...info, mediaUrl: media.register(info.path) };
    } catch (error) {
      clip = { id: randomUUID(), path: filename, name: path.basename(filename), duration: 0, width: 0, height: 0,
        fps: 0, hasAudio: false, mediaUrl: '', error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
    }
    clips.set(clip.id, clip); result.push(clip);
  }
  return result;
}
function handle(channel: string, callback: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Unrecognized app request.');
    return callback(...args);
  });
}
function setupIPC() {
  handle('app:state', () => ({ preferences, engine }));
  handle('clips:pick', async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Add video clips', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video clips', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'mts', 'm2ts', 'ts'] }, { name: 'All files', extensions: ['*'] }] });
    return result.canceled ? [] : inspectPaths(result.filePaths);
  });
  handle('clips:inspect', inspectPaths);
  handle('preferences:update', async (update: Partial<Preferences>) => {
    if (!update || typeof update !== 'object') throw new Error('Invalid preferences.');
    if (update.settings) preferences.settings = validateSettings(update.settings);
    if ('outputDirectory' in update) {
      if (update.outputDirectory !== null && (typeof update.outputDirectory !== 'string' || !path.isAbsolute(update.outputDirectory))) throw new Error('Choose a valid output folder.');
      preferences.outputDirectory = update.outputDirectory ?? null;
    }
    // Engine paths are set by the native folder picker, never arbitrary renderer requests.
    await savePreferences(); return preferences;
  });
  handle('engine:select', async () => {
    if (manager.busy) throw new Error('Wait for the current render before changing the engine.');
    const result = await dialog.showOpenDialog(window!, { title: 'Choose the installed Blur folder (contains blur-cli.exe)', properties: ['openDirectory'] });
    if (result.canceled) return engine;
    engine = await detectEngine(result.filePaths[0]);
    preferences.engineDirectory = result.filePaths[0]; await savePreferences(); return engine;
  });
  handle('engine:check', async () => { if (manager.busy) return engine; engine = await detectEngine(preferences.engineDirectory); return engine; });
  handle('engine:download', () => shell.openExternal('https://blur.sh/'));
  handle('output:pick', async () => {
    const result = await dialog.showOpenDialog(window!, { title: 'Choose export folder', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('jobs:preview', (id, start, settings) => {
    if (typeof start !== 'number' || !Number.isFinite(start)) throw new Error('Select a valid preview start time.');
    const clip = requireClip(id); if (clip.error) throw new Error(clip.error);
    return manager.preview(clip, start, validateSettings(settings));
  });
  handle('jobs:export', (ids, settings, outputDirectory) => {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new Error('Add at least one clip.');
    if (outputDirectory !== null && (typeof outputDirectory !== 'string' || !path.isAbsolute(outputDirectory))) throw new Error('Choose a valid export folder.');
    const selected = [...new Set(ids)].map(requireClip);
    if (selected.some(clip => clip.error)) throw new Error('Remove unreadable clips before exporting.');
    return manager.export(selected, validateSettings(settings), outputDirectory);
  });
  handle('jobs:cancel', () => manager.cancel());
  handle('output:open', async (filename) => {
    if (typeof filename !== 'string' || !allowedOutputs.has(path.resolve(filename))) throw new Error('Export a clip before opening its output folder.');
    const info = await stat(filename);
    if (info.isDirectory()) { const error = await shell.openPath(filename); if (error) throw new Error(error); }
    else shell.showItemInFolder(filename);
  });
  handle('clipboard:copy', (text) => { if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('Invalid clipboard text.'); clipboard.writeText(text); });
}
async function createWindow() {
  window = new BrowserWindow({ width: 1480, height: 920, minWidth: 1040, minHeight: 720, backgroundColor: '#0e1016', autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, '../../../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('close', event => {
    if (!quitting && manager.busy) {
      event.preventDefault();
      void dialog.showMessageBox(window!, { type: 'question', title: 'A render is running', message: 'Cancel rendering and close Motion Blur?', buttons: ['Keep rendering', 'Cancel and close'], defaultId: 0, cancelId: 0 }).then(async result => {
        if (result.response === 1) { await manager.cancel(); app.quit(); }
      });
    }
  });
  window.on('closed', () => { window = null; });
  const devURL = process.env.MOTION_BLUR_DEV_URL;
  if (!app.isPackaged && devURL === 'http://127.0.0.1:5173') await window.loadURL(devURL);
  else await window.loadFile(path.join(__dirname, '../../renderer/index.html'));
}
if (process.argv.includes('--install-engine')) {
  // Installer-only entry point: no player window, render queue, or preference writes.
  void app.whenReady().then(async () => {
    const cacheDirectory = process.env.MOTION_BLUR_SETUP_CACHE || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Motion Blur', 'setup');
    mkdirSync(cacheDirectory, { recursive: true });
    const log = (message: string) => {
      process.stdout.write(`${message}\n`);
      appendFileSync(path.join(cacheDirectory, 'engine-setup.log'), `${new Date().toISOString()} ${message}\n`, 'utf8');
    };
    const option = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
    try {
      const result = await installBlurEngine({
        destination: option('--engine-directory') || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Programs', 'Motion Blur Engine'),
        cacheDirectory,
        installerPath: option('--installer-path'),
        reuseExisting: !process.argv.includes('--force-engine-install'),
        dryRun: process.argv.includes('--setup-dry-run'), onMessage: log,
      });
      log(JSON.stringify(result)); app.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Setup failed: ${message}`);
      if (!process.argv.includes('--silent')) dialog.showErrorBox('Blur engine setup failed', `${message}\n\nSetup log: ${path.join(cacheDirectory, 'engine-setup.log')}`);
      app.exit(1);
    }
  }).catch(error => { console.error(error); app.exit(1); });
}
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  void app.whenReady().then(async () => {
    await loadPreferences();
    engine = await detectEngine(preferences.engineDirectory || process.env.MOTION_BLUR_ENGINE_DIR || null);
    manager = new JobManager({ engine: () => engine, emit: workerEvent, workDirectory: path.join(app.getPath('userData'), 'jobs') });
    protocol.handle('blur-media', request => media.respond(request));
    setupIPC(); await createWindow();
  }).catch(error => { dialog.showErrorBox('Motion Blur could not start', String(error)); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (quitting || !manager) return;
    event.preventDefault(); quitting = true;
    void manager.dispose().then(() => saving).finally(() => app.quit());
  });
}
