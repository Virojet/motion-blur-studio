import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

// Opaque URLs grant playback access only to files selected by the user or produced by a job.
export class MediaRegistry {
  private files = new Map<string, string>();
  private urls = new Map<string, string>();
  register(filename: string): string {
    const resolved = path.resolve(filename);
    const existing = this.urls.get(resolved);
    if (existing) return existing;
    const id = randomUUID();
    const url = `blur-media://clip/${id}`;
    this.files.set(id, resolved); this.urls.set(resolved, url);
    return url;
  }
  async respond(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
    const url = new URL(request.url);
    const filename = url.hostname === 'clip' ? this.files.get(url.pathname.slice(1)) : undefined;
    if (!filename) return new Response('File not registered', { status: 404 });
    try {
      const info = await stat(filename);
      if (!info.isFile()) return new Response(null, { status: 404 });
      const extension = path.extname(filename).toLowerCase();
      const mime: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/mp4' };
      const headers: Record<string, string> = { 'Content-Type': mime[extension] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
      const range = request.headers.get('range');
      let start = 0, end = info.size - 1, status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
        if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      }
      headers['Content-Length'] = String(Math.max(0, end - start + 1));
      if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status, headers });
      const stream = createReadStream(filename, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
    } catch { return new Response('File unavailable', { status: 404 }); }
  }
}
