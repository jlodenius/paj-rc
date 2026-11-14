import { createHash } from 'node:crypto';
import { MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS } from '../public/image-limits.js';

function invalid(message = 'Invalid image attachment', status = 400) {
  throw Object.assign(new Error(message), { status, code: status === 413 ? 'image_too_large' : 'invalid_image' });
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes) {
  if (bytes.length < 45 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') invalid();
  const depth = bytes[24];
  const color = bytes[25];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) invalid();
  let offset = 8;
  let data = false;
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) invalid();
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) invalid();
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) invalid();
    if (type === 'acTL') invalid('Animated images are not supported');
    if (offset > 8 && type === 'IHDR') invalid();
    if (type === 'IDAT' && length) data = true;
    offset += length + 12;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) invalid();
      ended = true;
      break;
    }
  }
  if (!data || !ended) invalid();
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegDimensions(bytes) {
  if (bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) invalid();
  let offset = 2;
  let dimensions;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0x00 || marker === 0xd8 || offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || length > bytes.length - offset) invalid();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (dimensions || length < 8 || bytes[offset + 2] !== 8 ||
          ![1, 3, 4].includes(bytes[offset + 7]) ||
          length !== 8 + 3 * bytes[offset + 7]) invalid();
      dimensions = [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    if (marker === 0xda) {
      if (!dimensions || length < 6 || bytes[offset + 2] < 1 ||
          length !== 6 + 2 * bytes[offset + 2] || offset + length >= bytes.length - 2) invalid();
      return dimensions;
    }
    offset += length;
  }
  invalid();
}

function webpDimensions(bytes) {
  if (bytes.length < 26 || bytes.toString('latin1', 0, 4) !== 'RIFF' ||
      bytes.toString('latin1', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) invalid();
  let offset = 12;
  let dimensions;
  let image = false;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (length > bytes.length - start) invalid();
    if (type === 'VP8X') {
      if (offset !== 12 || dimensions || length !== 10) invalid();
      if (bytes[start] & 0x02) invalid('Animated images are not supported');
      dimensions = [1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3)];
    } else if (type === 'VP8 ') {
      if (image || length < 10 || (bytes[start] & 1) ||
          bytes.toString('hex', start + 3, start + 6) !== '9d012a') invalid();
      const frame = [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
      if (dimensions && (dimensions[0] !== frame[0] || dimensions[1] !== frame[1])) invalid();
      dimensions = frame;
      image = true;
    } else if (type === 'VP8L') {
      if (image || length < 5 || bytes[start] !== 0x2f) invalid();
      const bits = bytes.readUInt32LE(start + 1);
      if (bits >>> 29) invalid();
      const frame = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
      if (dimensions && (dimensions[0] !== frame[0] || dimensions[1] !== frame[1])) invalid();
      dimensions = frame;
      image = true;
    } else if (type === 'ANIM' || type === 'ANMF') invalid('Animated images are not supported');
    offset = start + length + (length & 1);
  }
  if (offset !== bytes.length || !dimensions || !image) invalid();
  return dimensions;
}

export function validateImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid();
  if (value.length > MAX_IMAGES) invalid('Too many image attachments', 413);
  let total = 0;
  return value.map(image => {
    if (!image || typeof image !== 'object' || Array.isArray(image) ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType) ||
        typeof image.data !== 'string' || !image.data.length) invalid();
    if (image.data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) invalid('Image attachment is too large', 413);
    if (image.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) invalid();
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.toString('base64') !== image.data) invalid();
    total += bytes.length;
    if (bytes.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES) invalid('Image attachments are too large', 413);
    const dimensions = image.mimeType === 'image/png' ? pngDimensions(bytes)
      : image.mimeType === 'image/jpeg' ? jpegDimensions(bytes) : webpDimensions(bytes);
    const [width, height] = dimensions;
    if (!width || !height) invalid();
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
      invalid('Image dimensions are too large', 413);
    }
    return { mimeType: image.mimeType, data: image.data };
  });
}

export function hashImages(images) {
  const hash = createHash('sha256');
  for (const image of images) {
    hash.update(image.mimeType).update('\0').update(image.data).update('\0');
  }
  return hash.digest('hex');
}
