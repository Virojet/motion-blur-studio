import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaRegistry } from '../src/main/media';

test('media URLs expose only registered local files and support video seeking', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blur-media-'));
  try {
    const filename = path.join(directory, 'space 空間.mp4');
    await writeFile(filename, '0123456789');
    const media = new MediaRegistry();
    const url = media.register(filename);
    assert.equal(media.register(filename), url);
    assert.ok(!url.includes(filename));
    const partial = await media.respond(new Request(url, { headers: { Range: 'bytes=2-5' } }));
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(await partial.text(), '2345');
    const suffix = await media.respond(new Request(url, { headers: { Range: 'bytes=-3' } }));
    assert.equal(await suffix.text(), '789');
    const invalid = await media.respond(new Request(url, { headers: { Range: 'bytes=90-' } }));
    assert.equal(invalid.status, 416);
    assert.equal((await media.respond(new Request('blur-media://clip/not-registered'))).status, 404);
    assert.equal((await media.respond(new Request('blur-media://anything/C:/private.mp4'))).status, 404);
    const head = await media.respond(new Request(url, { method: 'HEAD' }));
    assert.equal(head.headers.get('content-length'), '10');
    assert.equal(await head.text(), '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
