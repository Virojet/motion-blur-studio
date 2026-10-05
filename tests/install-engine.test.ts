import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installerArguments, installBlurEngine, verifyInstaller } from '../src/main/install-engine';
import type { EngineStatus } from '../src/shared/types';

const payload = 'abc';
const release = { version: 'test', filename: 'test.exe', url: 'https://github.com/f0e/blur/releases/download/vtest/test.exe',
  bytes: 3, sha256: createHash('sha256').update(payload).digest('hex') };
const unavailable: EngineStatus = { ready: false, directory: null, blurPath: null, ffmpegPath: null, ffprobePath: null, issues: ['Missing engine'] };
const complete: EngineStatus = { ...unavailable, ready: true, directory: 'existing engine', issues: [] };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'motion-setup-'));
  return { root, destination: path.join(root, 'Motion Blur 空間'), cacheDirectory: path.join(root, 'cache') };
}

test('engine installer arguments retain spaces and Chinese paths as literal arguments', () => {
  const folder = path.resolve('a folder 空間');
  const args = installerArguments(folder);
  assert.ok(args.includes(`/DIR=${folder}`));
  assert.ok(args.includes('/CURRENTUSER'));
  assert.ok(args.includes('/TASKS='));
  for (const bad of ['relative/folder', path.parse(folder).root, `${folder}"`, `${folder}\nfile`]) assert.throws(() => installerArguments(bad));
});

test('installer verification rejects incomplete and substituted executables', async () => {
  const f = await fixture();
  const filename = path.join(f.root, 'installer.exe');
  try {
    await writeFile(filename, 'ab');
    await assert.rejects(verifyInstaller(filename, release), /incomplete/);
    await writeFile(filename, 'xbc');
    await assert.rejects(verifyInstaller(filename, release), /SHA-256/);
    await writeFile(filename, payload);
    await verifyInstaller(filename, release);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a complete existing engine is reused without downloading or executing installers', async () => {
  const f = await fixture();
  try {
    const result = await installBlurEngine(f, { detect: async () => complete,
      fetch: async () => { throw new Error('Must not download'); }, run: async () => { throw new Error('Must not run'); } });
    assert.equal(result.reused, true);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('setup dry run reports its pinned download and arguments without writing files', async () => {
  const f = await fixture();
  try {
    const result = await installBlurEngine({ ...f, dryRun: true }, { detect: async () => unavailable });
    assert.equal(result.dryRun, true);
    assert.match(result.sha256!, /^[a-f0-9]{64}$/);
    assert.match(result.url!, /^https:\/\/github.com\/f0e\/blur\/releases/);
    assert.deepEqual(await readdir(f.root), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('download failures never run an installer and leave no partial file', async () => {
  const f = await fixture();
  try {
    await assert.rejects(installBlurEngine(f, { release, detect: async () => unavailable,
      fetch: async () => new Response(null, { status: 403 }), run: async () => { throw new Error('Must not run'); } }), /HTTP 403/);
    assert.deepEqual(await readdir(f.cacheDirectory), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a changed download is rejected before execution and its partial file is removed', async () => {
  const f = await fixture();
  let ran = false;
  try {
    await assert.rejects(installBlurEngine(f, { release, detect: async () => unavailable,
      fetch: async () => new Response('xbc'), run: async () => { ran = true; return { stdout: '', stderr: '' }; } }), /SHA-256/);
    assert.equal(ran, false);
    assert.deepEqual(await readdir(f.cacheDirectory), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('verified downloads and caches run the per-user installer then validate the complete engine', async () => {
  const f = await fixture();
  let downloads = 0, runs = 0;
  const services = { release, detect: async (directory: string | null) => directory ? complete : unavailable,
    fetch: async () => { downloads++; return new Response(payload); },
    run: async (_file: string, args: string[], options?: { acceptedExitCodes?: number[] }) => {
      runs++; assert.ok(args.includes(`/DIR=${f.destination}`)); assert.deepEqual(options?.acceptedExitCodes, [0, 3010]);
      return { stdout: '', stderr: '' };
    } };
  try {
    await installBlurEngine(f, services);
    await installBlurEngine(f, services);
    assert.equal(downloads, 1);
    assert.equal(runs, 2);
    assert.ok((await readdir(f.cacheDirectory)).every(name => name.endsWith('.exe')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('installer exit success does not conceal an incomplete engine', async () => {
  const f = await fixture();
  const installerPath = path.join(f.root, 'local.exe');
  try {
    await writeFile(installerPath, payload);
    await assert.rejects(installBlurEngine({ ...f, installerPath }, { release, detect: async () => unavailable,
      run: async () => ({ stdout: '', stderr: '' }) }), /installation is incomplete/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
