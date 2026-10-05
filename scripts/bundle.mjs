import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile, stat, rm, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ZipArchive } from 'archiver';

const require = createRequire(import.meta.url);
const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a stable semantic version before packaging.');
const release = path.join(root, 'release');
const stage = path.join(root, 'artifacts', 'distribution', `${version}-${Date.now()}`);
await mkdir(stage, { recursive: true });
await mkdir(release, { recursive: true });

async function zip(folder, destination) {
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const output = createWriteStream(destination);
  const finished = new Promise((resolve, reject) => {
    output.on('close', resolve); output.on('error', reject);
    archive.on('error', reject); archive.on('warning', reject);
  });
  archive.pipe(output);
  const visit = async (directory, relative = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name), name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child, name);
      else if (entry.isFile()) archive.file(child, { name: path.posix.join(path.basename(folder), name) });
      else throw new Error(`Unsupported archive entry: ${child}`);
    }
  };
  await visit(folder);
  await archive.finalize();
  await finished;
}

// Preserve the official Electron executable bytes and runtime license files.
const runtime = path.join(stage, `Motion-Blur-${version}-Runtime`);
await cp(path.dirname(require('electron')), runtime, { recursive: true });
await cp(path.join(runtime, 'electron.exe'), path.join(runtime, 'Motion Blur.exe'));
await rm(path.join(runtime, 'electron.exe'));
const runtimeApp = path.join(runtime, 'resources', 'app');
await mkdir(runtimeApp, { recursive: true });
for (const name of ['dist', 'assets']) await cp(path.join(root, name), path.join(runtimeApp, name), { recursive: true });
await writeFile(path.join(runtimeApp, 'package.json'), JSON.stringify({ name: pkg.name, version, main: pkg.main, productName: pkg.build.productName, license: pkg.license }, null, 2));
await cp(path.join(root, 'LICENSE'), path.join(runtimeApp, 'LICENSE'));
await cp(path.join(root, 'THIRD-PARTY-NOTICES.md'), path.join(runtime, 'THIRD-PARTY-NOTICES.md'));
await cp(path.join(root, 'installer', 'Install-BlurEngine.cmd'), path.join(runtime, 'Install-BlurEngine.cmd'));
await writeFile(path.join(runtime, 'README.txt'), `Motion Blur ${version}\r\n\r\n1. Extract this whole folder.\r\n2. If Blur is not installed, double-click Install-BlurEngine.cmd.\r\n3. Double-click Motion Blur.exe. No Node.js or app installation is required.\r\n\r\nThe engine setup downloads the official Blur v2.45 package, checks its SHA-256,\r\nand installs it for the current Windows user. An existing engine is reused.\r\nVideo processing remains local. See THIRD-PARTY-NOTICES.md for engine source.\r\nThe runtime is not code-signed by this project; organizational policies still apply.\r\n`);
const runtimeZip = path.join(release, `Motion-Blur-${version}-Runtime-Windows-x64.zip`);
await zip(runtime, runtimeZip);

const source = path.join(stage, `Motion-Blur-${version}-Source`);
await mkdir(source, { recursive: true });
const allowlist = ['.github', '.gitignore', '.gitattributes', 'src', 'tests', 'scripts', 'installer', 'assets', 'docs', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'tsconfig.json', 'tsconfig.main.json', 'vite.config.mts', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'CHANGELOG.md', 'Launch Motion Blur.cmd'];
for (const name of allowlist) await cp(path.join(root, name), path.join(source, name), { recursive: true });
const sourceZip = path.join(release, `Motion-Blur-${version}-Source.zip`);
await zip(source, sourceZip);

const setupName = `Motion-Blur-${version}-Setup-Windows-x64.exe`;
await stat(path.join(release, setupName));
const setupBundle = path.join(stage, `Motion-Blur-${version}-Setup`);
await mkdir(setupBundle, { recursive: true });
await cp(path.join(release, setupName), path.join(setupBundle, setupName));
for (const name of ['README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) await cp(path.join(root, name), path.join(setupBundle, name));
await writeFile(path.join(setupBundle, 'Install.cmd'), `@echo off\r\nstart "" /wait "%~dp0${setupName}"\r\nif errorlevel 1 (\r\n  echo Setup did not finish. See the README and the engine setup log.\r\n  pause\r\n  exit /b 1\r\n)\r\n`);
const setupZip = path.join(release, `Motion-Blur-${version}-Setup-Package-Windows-x64.zip`);
await zip(setupBundle, setupZip);

const artifacts = [setupName, `Motion-Blur-${version}-Windows-x64.exe`, path.basename(runtimeZip), path.basename(sourceZip), path.basename(setupZip)];
const hashes = [];
for (const filename of artifacts) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(release, filename))) hash.update(chunk);
  hashes.push(`${hash.digest('hex')}  ${filename}`);
}
await writeFile(path.join(release, 'SHA256SUMS.txt'), `${hashes.join('\n')}\n`);
await writeFile(path.join(release, 'RELEASE-NOTES.md'), `Motion Blur ${version} keeps the current purple and graphite interface and adds a combined setup path for the UI and Tekno's Blur engine.\n\nDownload **${setupName}** for the Windows setup wizard. It reuses an existing complete engine or downloads the official Blur v2.45 installer (about 180 MB), verifies its SHA-256, and installs it for your user. First-time engine setup needs Internet; rendering is local.\n\nThe Setup-Package ZIP includes the installer, Install.cmd, README, and license notices. Runtime ZIP provides a standalone folder with the unmodified Electron runtime; run Install-BlurEngine.cmd if needed, then Motion Blur.exe. The portable EXE needs a separately installed engine. Source and SHA-256 checksums are included.\n\nThese project executables are unsigned. Windows or organizational policy may block them. No security-policy changes are included. See the README for source launch instructions and validation limitations.\n\nBlur remains a separate GPL-3.0 application, downloaded directly from [its official release](https://github.com/f0e/blur/releases/tag/v2.45). [Engine source and licenses](https://github.com/f0e/blur/tree/v2.45).\n`);
console.log(`Created ${artifacts.length} release downloads and SHA256SUMS.txt.`);
