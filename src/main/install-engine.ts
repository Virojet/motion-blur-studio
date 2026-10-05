import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import path from 'node:path';
import { ENGINE_RELEASE } from '../shared/engine-release';
import { detectEngine, runProcess } from './engine';
import type { EngineStatus } from '../shared/types';

type ReleaseSpec = { url: string; sha256: string; bytes: number; filename: string; version: string };
type SetupServices = {
  detect?: (directory: string | null) => Promise<EngineStatus>;
  fetch?: typeof fetch;
  run?: typeof runProcess;
  release?: ReleaseSpec;
};
export type EngineSetupOptions = {
  destination: string;
  cacheDirectory: string;
  installerPath?: string;
  reuseExisting?: boolean;
  dryRun?: boolean;
  onMessage?: (message: string) => void;
};

export function installerArguments(destination: string): string[] {
  if (!path.isAbsolute(destination) || /[\0\r\n"]/.test(destination) || path.resolve(destination) === path.parse(path.resolve(destination)).root) {
    throw new Error('Choose an absolute installation folder below a drive root.');
  }
  return ['/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOICONS', '/TASKS=', `/DIR=${path.resolve(destination)}`];
}

export async function verifyInstaller(filename: string, release: ReleaseSpec = ENGINE_RELEASE): Promise<void> {
  const info = await stat(filename);
  if (!info.isFile() || info.size !== release.bytes) throw new Error('The Blur installer is incomplete or has an unexpected size.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest('hex') !== release.sha256) throw new Error('The Blur installer failed SHA-256 verification. It will not be run.');
}

export async function installBlurEngine(options: EngineSetupOptions, services: SetupServices = {}) {
  const args = installerArguments(options.destination);
  const release = services.release ?? ENGINE_RELEASE;
  const detect = services.detect ?? detectEngine;
  const report = options.onMessage ?? (() => {});
  if (options.reuseExisting !== false) {
    const existing = await detect(null);
    if (existing.ready) {
      report(`Using the complete Blur installation at ${existing.directory}.`);
      return { reused: true, directory: existing.directory, dryRun: !!options.dryRun };
    }
  }
  if (options.dryRun) return { reused: false, directory: options.destination, dryRun: true, url: release.url, sha256: release.sha256, args };
  if (!/^https:\/\/github\.com\/f0e\/blur\/releases\/download\/v[\w.-]+\/[\w.-]+\.exe$/.test(release.url)) throw new Error('Only official Blur release downloads are accepted.');
  if (!/^[a-f0-9]{64}$/.test(release.sha256)) throw new Error('The pinned installer checksum is invalid.');

  let installer: string;
  if (options.installerPath) {
    installer = path.resolve(options.installerPath);
    await verifyInstaller(installer, release);
  } else {
    await mkdir(options.cacheDirectory, { recursive: true });
    installer = path.join(options.cacheDirectory, `blur-${release.version}-${release.sha256.slice(0, 12)}.exe`);
    let cached = false;
    try { await verifyInstaller(installer, release); cached = true; } catch { /* Re-download an absent or damaged cache. */ }
    if (!cached) {
      const partial = path.join(options.cacheDirectory, `${randomUUID()}.download`);
      report(`Downloading the official Blur ${release.version} installer (about ${Math.round(release.bytes / 1_000_000)} MB)…`);
      try {
        const response = await (services.fetch ?? fetch)(release.url, { signal: AbortSignal.timeout(15 * 60_000) });
        if (!response.ok || !response.body) throw new Error(`Blur download failed (HTTP ${response.status}).`);
        let received = 0, previousPercent = -1;
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > release.bytes) { callback(new Error('The downloaded installer exceeds its pinned size.')); return; }
          const percent = Math.floor(received / release.bytes * 100);
          if (percent >= previousPercent + 10) { previousPercent = percent; report(`Downloading Blur: ${percent}%`); }
          callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(partial, { flags: 'wx' }));
        await verifyInstaller(partial, release);
        // Both paths are fixed files in the setup cache, never user-selected media.
        await rm(installer, { force: true });
        await rename(partial, installer);
      } finally { await rm(partial, { force: true }); }
    }
  }
  report('Checksum verified. Installing the complete engine for the current Windows user…');
  await mkdir(options.destination, { recursive: true });
  await (services.run ?? runProcess)(installer, args, { timeoutMs: 15 * 60_000, acceptedExitCodes: [0, 3010] });
  const installed = await detect(options.destination);
  if (!installed.ready) throw new Error(`Blur installation is incomplete: ${installed.issues.join(' ')}`);
  report(`Blur is ready at ${installed.directory}.`);
  return { reused: false, directory: installed.directory, dryRun: false };
}
