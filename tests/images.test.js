import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateImages, hashImages } from '../dist/src/images.js';
import { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS } from '../dist/public/image-limits.js';

const png = readFileSync(new URL('../dist/public/icons/icon-192.png', import.meta.url));
const image = (bytes = png, mimeType = 'image/png') => ({ mimeType, data: bytes.toString('base64') });

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}
function dimensions(width, height) {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc(bytes.subarray(12, 29)), 29);
  return bytes;
}
function padded(size) {
  const insertion = chunk('tEXt', Buffer.alloc(size - png.length - 12, 65));
  return Buffer.concat([png.subarray(0, 33), insertion, png.subarray(33)]);
}

test('shared limits keep images within the existing IPC frame budget', () => {
  assert.equal(MAX_IMAGES, 3);
  assert.equal(MAX_IMAGE_BYTES, 512 * 1024);
  assert.equal(MAX_TOTAL_IMAGE_BYTES, 1024 * 1024);
  assert.equal(MAX_IMAGE_DIMENSION, 2048);
  assert.equal(MAX_IMAGE_PIXELS, 4 * 1024 * 1024);
});

test('normalizes image whitelist and hashes image content and ordering without retaining bytes', () => {
  assert.deepEqual(validateImages(undefined), []);
  assert.deepEqual(validateImages([]), []);
  const normalized = validateImages([{ ...image(), private: 'ignored', url: 'ignored' }]);
  assert.deepEqual(normalized, [image()]);
  assert.match(hashImages(normalized), /^[a-f0-9]{64}$/);
  assert.equal(hashImages(normalized), hashImages([image()]));
  assert.notEqual(hashImages(normalized), hashImages([]));
  const other = image(dimensions(191, 192));
  assert.notEqual(hashImages([image(), other]), hashImages([other, image()]));
});

test('rejects noncanonical base64, data URLs, unsupported formats, wrong signatures and corrupt PNGs', () => {
  const corrupted = Buffer.from(png);
  corrupted[40] ^= 1;
  const values = [null, {}, 'https://example.com/image.png', [null],
    [{ mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') }],
    [{ mimeType: 'image/gif', data: 'R0lGODlh' }],
    [{ mimeType: 'image/png', data: `data:image/png;base64,${image().data}` }],
    [{ ...image(), data: image().data + '\n' }], [{ ...image(), data: 'Zh==' }],
    [{ ...image(), data: '' }], [{ ...image(), data: 123 }],
    [image(png, 'image/jpeg')], [image(Buffer.from('not an image'))],
    [image(png.subarray(0, 33))], [image(corrupted)],
    [image(Buffer.concat([png, Buffer.from('trailing')]))],
  ];
  for (const value of values) {
    assert.throws(() => validateImages(value), { status: 400, code: 'invalid_image' });
  }
});

test('enforces attachment, decoded byte, total byte, dimension and pixel bounds', () => {
  assert.throws(() => validateImages(Array(4).fill(image())), { status: 413 });
  const exact = image(padded(MAX_IMAGE_BYTES));
  assert.equal(validateImages([exact, exact]).length, 2);
  assert.throws(() => validateImages([exact, exact, image()]), { status: 413 });
  assert.throws(() => validateImages([image(padded(MAX_IMAGE_BYTES + 1))]), { status: 413 });
  assert.equal(validateImages([image(dimensions(2048, 2048))]).length, 1);
  for (const [width, height] of [[2049, 1], [1, 2049], [4096, 4096]]) {
    assert.throws(() => validateImages([image(dimensions(width, height))]), { status: 413 });
  }
  assert.throws(() => validateImages([image(dimensions(0, 100))]), { status: 400 });
});

test('reads bounded JPEG frame dimensions and rejects truncated or excessive frames', () => {
  const jpeg = Buffer.from('ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9', 'hex');
  assert.equal(validateImages([image(jpeg, 'image/jpeg')]).length, 1);
  assert.throws(() => validateImages([image(jpeg.subarray(0, -2), 'image/jpeg')]), { status: 400 });
  const large = Buffer.from(jpeg);
  large.writeUInt16BE(2049, 9);
  assert.throws(() => validateImages([image(large, 'image/jpeg')]), { status: 413 });
});

test('reads WebP lossless and lossy dimensions and rejects RIFF mismatch and animation', () => {
  const webp = (type, payload) => {
    const bytes = Buffer.alloc(20 + payload.length + (payload.length & 1));
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBP', 8);
    bytes.write(type, 12); bytes.writeUInt32LE(payload.length, 16); payload.copy(bytes, 20);
    return bytes;
  };
  const lossless = webp('VP8L', Buffer.from('2f00000000', 'hex'));
  const lossy = webp('VP8 ', Buffer.from('1000009d012a01000100', 'hex'));
  assert.equal(validateImages([image(lossless, 'image/webp'), image(lossy, 'image/webp')]).length, 2);
  const broken = Buffer.from(lossless); broken.writeUInt32LE(0, 4);
  assert.throws(() => validateImages([image(broken, 'image/webp')]), { status: 400 });
  assert.throws(() => validateImages([image(lossless.subarray(0, -1), 'image/webp')]), { status: 400 });
  const lateExtended = Buffer.concat([lossy, webp('VP8X', Buffer.alloc(10)).subarray(12)]);
  lateExtended.writeUInt32LE(lateExtended.length - 8, 4);
  assert.throws(() => validateImages([image(lateExtended, 'image/webp')]), { status: 400 });
  const duplicateFrames = Buffer.concat([lossless, lossless.subarray(12)]);
  duplicateFrames.writeUInt32LE(duplicateFrames.length - 8, 4);
  assert.throws(() => validateImages([image(duplicateFrames, 'image/webp')]), { status: 400 });
  const animated = Buffer.alloc(10); animated[0] = 2;
  assert.throws(() => validateImages([image(webp('VP8X', animated), 'image/webp')]), { status: 400 });
});
