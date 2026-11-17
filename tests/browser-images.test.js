import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareImage } from '../dist/public/images.js';
import { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_IMAGE_DIMENSION } from '../dist/public/image-limits.js';

const budget = Math.min(MAX_IMAGE_BYTES, Math.floor(MAX_TOTAL_IMAGE_BYTES / MAX_IMAGES));
const jpeg = () => new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2])], { type: 'image/jpeg' });
function png(width = 640, height = 480) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
}
function heif(brand, type = 'image/heic') {
  const bytes = new Uint8Array(20);
  new DataView(bytes.buffer).setUint32(0, 20);
  bytes.set(Buffer.from('ftyp'), 4);
  bytes.set(Buffer.from(brand), 8);
  bytes.set(Buffer.from('mif1'), 16);
  return new Blob([bytes], { type });
}

function browser(t, options = {}) {
  const originals = { Image: globalThis.Image, document: globalThis.document };
  const images = [];
  const urls = [];
  const revoked = [];
  const encodes = [];
  const draws = [];
  const operations = [];
  const canvases = [];
  globalThis.Image = class {
    constructor() {
      images.push(this);
      this.naturalWidth = options.width ?? 640;
      this.naturalHeight = options.height ?? 480;
    }
    set src(value) {
      this.source = value;
      if (value) queueMicrotask(() => {
        if (options.decodeFails) this.onerror?.(new Error('SECRET decoder error'));
        else this.onload?.();
      });
    }
  };
  const context = {
    fillRect(...args) { operations.push({ type: 'fill', color: this.fillStyle, args }); },
    drawImage(image, ...args) {
      if (options.drawFails) throw new Error('SECRET draw error');
      operations.push({ type: 'draw' });
      draws.push({ image, args });
    },
  };
  globalThis.document = { createElement(name) {
    assert.equal(name, 'canvas');
    const canvas = {
      width: 0, height: 0,
      getContext(kind) { assert.equal(kind, '2d'); return options.noContext ? null : context; },
      toBlob(callback, mimeType, quality) {
        const call = { width: this.width, height: this.height, quality, mimeType };
        encodes.push(call);
        if (options.encodeThrows) throw new Error('SECRET encoder error');
        const size = options.size?.(call, encodes.length) ?? 1024;
        queueMicrotask(() => callback(options.encodeNull ? null :
          new Blob([new Uint8Array(size).fill(0xab)], { type: options.outputType ?? mimeType })));
      },
    };
    canvases.push(canvas);
    return canvas;
  } };
  t.mock.method(URL, 'createObjectURL', blob => {
    assert.ok(blob instanceof Blob);
    const value = `blob:local-${urls.length}`;
    urls.push(value);
    return value;
  });
  t.mock.method(URL, 'revokeObjectURL', value => { revoked.push(value); });
  t.after(() => {
    for (const [name, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  return { images, urls, revoked, encodes, draws, operations, canvases,
    cleaned() {
      assert.deepEqual(revoked, urls);
      for (const image of images) {
        assert.equal(image.onload, null);
        assert.equal(image.onerror, null);
        assert.equal(image.source, '');
      }
      for (const canvas of canvases) {
        assert.equal(canvas.width, 0);
        assert.equal(canvas.height, 0);
      }
    } };
}

test('module imports without DOM globals; unsupported objects and formats never decode', async t => {
  const h = browser(t);
  for (const input of ['https://example.com/photo.jpg', {}, null,
    new Blob(['<svg><image href="https://example.com/private"/></svg>'], { type: 'image/svg+xml' }),
    new Blob(['GIF89a'], { type: 'image/gif' }),
    new Blob(['<svg/>'], { type: 'image/jpeg' }),
    heif('avif', 'image/heif'), new Blob(['not an image'], { type: 'text/plain' })]) {
    await assert.rejects(prepareImage(input), /Choose a JPEG, PNG, WebP, HEIC, or HEIF photo/);
  }
  assert.equal(h.images.length, 0);
  assert.equal(h.urls.length, 0);
});

test('original file size and zero-byte checks happen before decoding', async t => {
  const h = browser(t);
  await assert.rejects(prepareImage(new Blob([new Uint8Array(20 * 1024 * 1024 + 1)],
    { type: 'image/jpeg' })), /over 20 MiB/);
  await assert.rejects(prepareImage(new Blob([], { type: 'image/jpeg' })), /could not be read/);
  assert.equal(h.urls.length, 0);
});

test('normalization resizes landscape and returns bounded canonical JPEG bytes, not a data URL', async t => {
  const h = browser(t, { width: 4000, height: 3000 });
  const result = await prepareImage(jpeg());
  assert.equal(result.mimeType, 'image/jpeg');
  assert.equal(result.width, Math.min(1600, MAX_IMAGE_DIMENSION));
  assert.equal(result.height, 1200);
  assert.equal(result.size, result.blob.size);
  assert.equal(result.blob.type, 'image/jpeg');
  assert.ok(result.size <= budget);
  assert.match(result.data, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from(result.data, 'base64').toString('base64'), result.data);
  assert.deepEqual(Buffer.from(result.data, 'base64'), Buffer.from(await result.blob.arrayBuffer()));
  assert.equal(h.encodes[0].quality, 0.86);
  assert.deepEqual(h.draws[0].args, [0, 0, 1600, 1200]);
  h.cleaned();
});

test('portrait/native orientation is preserved without upscaling small photos', async t => {
  const h = browser(t, { width: 300, height: 600 });
  const result = await prepareImage(jpeg());
  assert.equal(result.width, 300);
  assert.equal(result.height, 600);
  assert.equal(h.draws[0].image.decoding, 'async');
  h.cleaned();
});

test('transparent PNG is flattened onto white before drawing', async t => {
  const h = browser(t);
  await prepareImage(png());
  assert.deepEqual(h.operations.slice(0, 2), [
    { type: 'fill', color: '#ffffff', args: [0, 0, 640, 480] }, { type: 'draw' },
  ]);
  h.cleaned();
});

test('quality decreases before image dimensions shrink and attempts stay bounded', async t => {
  const h = browser(t, { width: 2000, height: 1000,
    size: (call, attempt) => attempt <= 5 ? budget + 100 : budget });
  const result = await prepareImage(jpeg());
  assert.deepEqual(h.encodes.slice(0, 5).map(call => call.quality), [0.86, 0.72, 0.58, 0.44, 0.32]);
  assert.ok(h.encodes.slice(0, 5).every(call => call.width === 1600 && call.height === 800));
  assert.ok(result.width < 1600 && result.height < 800);
  assert.equal(result.width / result.height, 2);
  assert.equal(result.size, budget);
  assert.equal(h.encodes.length, 6);
  h.cleaned();
});

test('an image that cannot fit fails after bounded attempts and cleans resources', async t => {
  const h = browser(t, { width: 1600, height: 1600, size: () => budget + 1 });
  await assert.rejects(prepareImage(jpeg()), /could not be made small enough/);
  assert.equal(h.encodes.length, 30);
  h.cleaned();
});

test('pixel/side limits reject header bombs before allocating a decoder', async t => {
  const h = browser(t);
  await assert.rejects(prepareImage(png(40000, 1)), /too many pixels/);
  await assert.rejects(prepareImage(png(10000, 7000)), /too many pixels/);
  assert.equal(h.images.length, 0);
});

test('JPEG SOF and WebP headers also guard dimensions before native decode', async t => {
  const h = browser(t);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 1, 0x9c, 0x40, 0]);
  await assert.rejects(prepareImage(new Blob([jpg], { type: 'image/jpeg' })), /too many pixels/);
  const webp = new Uint8Array(30);
  webp.set(Buffer.from('RIFF'), 0);
  webp.set(Buffer.from('WEBPVP8X'), 8);
  const width = 40000 - 1;
  webp[24] = width & 255;
  webp[25] = (width >> 8) & 255;
  await assert.rejects(prepareImage(new Blob([webp], { type: 'image/webp' })), /too many pixels/);
  assert.equal(h.images.length, 0);
});

test('WebP photos normalize through the same native decoder and JPEG encoder', async t => {
  const h = browser(t);
  const file = new Blob(['RIFF0000WEBPVP8 '], { type: 'image/webp' });
  const result = await prepareImage(file);
  assert.equal(result.mimeType, 'image/jpeg');
  assert.ok(result.size <= budget);
  h.cleaned();
});

test('decoder dimensions are guarded even when source headers lack dimensions', async t => {
  const h = browser(t, { width: 32769, height: 1 });
  await assert.rejects(prepareImage(jpeg()), /too many pixels/);
  assert.equal(h.encodes.length, 0);
  h.cleaned();
});

test('unreadable input and decoder failures produce safe errors and revoke object URLs', async t => {
  const h = browser(t, { decodeFails: true });
  await assert.rejects(prepareImage(jpeg()), /could not be read/);
  h.cleaned();
  const file = jpeg();
  file.arrayBuffer = async () => { throw new Error('SECRET filename or decoder contents'); };
  await assert.rejects(prepareImage(file), error => /could not be read/.test(error.message) &&
    !error.message.includes('SECRET'));
});

for (const [label, options] of [
  ['null encoding', { encodeNull: true }], ['throwing encoder', { encodeThrows: true }],
  ['non-JPEG output', { outputType: 'image/png' }], ['missing context', { noContext: true }],
  ['canvas failure', { drawFails: true }],
]) {
  test(`${label} fails safely and releases decoder/canvas resources`, async t => {
    const h = browser(t, options);
    await assert.rejects(prepareImage(jpeg()), error => /could not be prepared/.test(error.message) &&
      !error.message.includes('SECRET'));
    h.cleaned();
  });
}

test('HEIC/HEIF use native decoding, including empty MIME and HEIF-family aliases', async t => {
  const h = browser(t);
  for (const file of [heif('heic'), heif('mif1', 'image/heif'), heif('heic', ''),
    heif('heic', 'image/heif')]) {
    assert.equal((await prepareImage(file)).mimeType, 'image/jpeg');
  }
  assert.equal(h.images.length, 4);
  h.cleaned();
});
