import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Real tools and media are used by verify:engine; no pre-rendered success fixtures. */
export async function locateTool(name: 'ffmpeg' | 'ffprobe', directory?: string | null): Promise<string> {
  const executable = `${name}${process.platform === 'win32' ? '.exe' : ''}`;
  for (const candidate of [
    directory && path.join(directory, executable),
    process.env[`${name.toUpperCase()}_PATH`],
    process.platform === 'win32' && path.join('C:\\ffmpeg\\bin', executable),
  ]) {
    if (!candidate) continue;
    try { await access(candidate); return candidate; } catch { /* try next location */ }
  }
  return executable;
}

export async function runTool(command: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', data => stdout.push(Buffer.from(data)));
    child.stderr.on('data', data => stderr.push(Buffer.from(data)));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`${path.basename(command)} exited ${code}: ${Buffer.concat(stderr).toString().slice(-5000)}`));
      else resolve(Buffer.concat(stdout));
    });
  });
}

export async function createFixtures(directory: string, ffmpeg: string): Promise<{ audio: string; silent: string }> {
  await mkdir(directory, { recursive: true });
  const audio = path.join(directory, 'moving bars with audio 空間.mp4');
  const silent = path.join(directory, 'moving bars silent 測試.mp4');
  // A hard-edged checkerboard moves four pixels per 120-FPS source frame.
  // Texture gives SVP a real motion field; averaging creates intermediate luma.
  const source = "nullsrc=s=320x180:r=120:d=5,geq=lum='if(lt(mod(X-N*4+320*100,320),192),if(eq(lt(mod(X-N*4+320*100,32),16),lt(mod(Y,32),16)),235,16),16)':cb=128:cr=128";
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source];
  await runTool(ffmpeg, [...common, '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', audio]);
  await runTool(ffmpeg, [...common, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-pix_fmt', 'yuv420p', '-an', silent]);
  return { audio, silent };
}

export async function probeRaw(ffprobe: string, file: string): Promise<any> {
  return JSON.parse((await runTool(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).toString());
}

export async function edgeProfile(ffmpeg: string, file: string, width = 320, height = 180): Promise<{ intermediate: number; range: number }> {
  const data = await runTool(ffmpeg, ['-v', 'error', '-ss', '1.5', '-i', file, '-an', '-vf', 'extractplanes=y', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1']);
  if (data.length !== width * height) throw new Error(`Expected ${width * height} grayscale pixels, received ${data.length}.`);
  const row = data.subarray(Math.floor(height / 2) * width, (Math.floor(height / 2) + 1) * width);
  let intermediate = 0;
  for (const luma of row) if (luma > 40 && luma < 210) intermediate++;
  return { intermediate, range: Math.max(...row) - Math.min(...row) };
}
