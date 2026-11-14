import {
  MAX_IMAGES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, MAX_IMAGE_DIMENSION,
} from './image-limits.js';

const ORIGINAL_BYTE_LIMIT = 20 * 1024 * 1024;
const ORIGINAL_SIDE_LIMIT = 32768;
const ORIGINAL_PIXEL_LIMIT = 60000000;
const FORMATS = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const FORMAT_ERROR = 'Choose a JPEG, PNG, WebP, HEIC, or HEIF photo.';
const READ_ERROR = 'This photo could not be read. Try another photo or export it as JPEG.';
const ENCODE_ERROR = 'This photo could not be prepared. Try another photo or export it as JPEG.';

function formatOf(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value)) {
    return 'image/png';
  }
  const ascii = (start, count) => String.fromCharCode(...bytes.subarray(start, start + count));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (bytes.length >= 16 && ascii(4, 4) === 'ftyp') {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (length < 16 || length > bytes.length || length % 4) return null;
    const brands = [ascii(8, 4)];
    for (let offset = 16; offset < length; offset += 4) brands.push(ascii(offset, 4));
    if (brands.includes('avif') || brands.includes('avis')) return null;
    if (brands.some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))) return 'image/heic';
    if (brands.some(brand => ['mif1', 'msf1'].includes(brand))) return 'image/heif';
  }
  return null;
}

function headerDimensions(bytes, format) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 'image/png' && bytes.length >= 24) return [view.getUint32(16), view.getUint32(20)];
  if (format === 'image/jpeg') {
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (frames.has(marker) && length >= 7) {
        return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
      }
      offset += length;
    }
  }
  if (format === 'image/webp' && bytes.length >= 25) {
    const kind = String.fromCharCode(...bytes.subarray(12, 16));
    if (kind === 'VP8X' && bytes.length >= 30) {
      const uint24 = offset => bytes[offset] + bytes[offset + 1] * 256 + bytes[offset + 2] * 65536;
      return [uint24(24) + 1, uint24(27) + 1];
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      return [1 + bytes[21] + ((bytes[22] & 63) << 8),
        1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10)];
    }
    if (kind === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d &&
        bytes[24] === 1 && bytes[25] === 0x2a) {
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    }
  }
  return null;
}

function validateDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error(READ_ERROR);
  }
  if (width > ORIGINAL_SIDE_LIMIT || height > ORIGINAL_SIDE_LIMIT ||
      width * height > ORIGINAL_PIXEL_LIMIT) {
    throw new Error('This photo has too many pixels. Choose a smaller photo.');
  }
}

function decode(image, url) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(READ_ERROR)), 15000);
    image.onload = () => { clearTimeout(timer); resolve(); };
    image.onerror = () => { clearTimeout(timer); reject(new Error(READ_ERROR)); };
    try {
      image.decoding = 'async';
      image.src = url;
    } catch {
      clearTimeout(timer);
      reject(new Error(READ_ERROR));
    }
  });
}

function encode(canvas, quality) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(ENCODE_ERROR)), 15000);
    try {
      canvas.toBlob(blob => {
        clearTimeout(timer);
        if (!blob || blob.type !== 'image/jpeg' || !blob.size) reject(new Error(ENCODE_ERROR));
        else resolve(blob);
      }, 'image/jpeg', quality);
    } catch {
      clearTimeout(timer);
      reject(new Error(ENCODE_ERROR));
    }
  });
}

async function base64Of(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export async function prepareImage(file) {
  if (!(file instanceof Blob)) throw new Error(FORMAT_ERROR);
  if (file.size > ORIGINAL_BYTE_LIMIT) throw new Error('This photo is over 20 MiB. Choose a smaller photo.');
  if (!file.size) throw new Error(READ_ERROR);
  const declared = file.type.toLowerCase();
  if (declared && !FORMATS.has(declared)) throw new Error(FORMAT_ERROR);
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new Error(READ_ERROR); }
  const format = formatOf(bytes);
  const heifFamily = value => value === 'image/heic' || value === 'image/heif';
  if (!format || (declared && declared !== format && !(heifFamily(declared) && heifFamily(format)))) {
    throw new Error(FORMAT_ERROR);
  }
  const dimensions = headerDimensions(bytes, format);
  if (dimensions) validateDimensions(...dimensions);
  let image;
  let url;
  let canvas;
  try {
    image = new Image();
    url = URL.createObjectURL(file);
    await decode(image, url);
    const originalWidth = image.naturalWidth;
    const originalHeight = image.naturalHeight;
    validateDimensions(originalWidth, originalHeight);
    const side = Math.min(1600, MAX_IMAGE_DIMENSION);
    const scale = Math.min(1, side / originalWidth, side / originalHeight);
    let width = Math.max(1, Math.floor(originalWidth * scale));
    let height = Math.max(1, Math.floor(originalHeight * scale));
    const budget = Math.min(MAX_IMAGE_BYTES, Math.floor(MAX_TOTAL_IMAGE_BYTES / MAX_IMAGES));
    canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error(ENCODE_ERROR);
    for (let attempt = 0; attempt < 6; attempt++) {
      canvas.width = width;
      canvas.height = height;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      // Native Image decoding/drawImage applies EXIF orientation; do not rotate a second time.
      context.drawImage(image, 0, 0, width, height);
      let blob;
      for (const quality of [0.86, 0.72, 0.58, 0.44, 0.32]) {
        blob = await encode(canvas, quality);
        if (blob.size <= budget) {
          const data = await base64Of(blob);
          return { mimeType: 'image/jpeg', data, blob, width, height, size: blob.size };
        }
      }
      const shrink = Math.min(0.8, Math.sqrt(budget / blob.size) * 0.9);
      const nextWidth = Math.max(1, Math.floor(width * shrink));
      const nextHeight = Math.max(1, Math.floor(height * shrink));
      if (nextWidth === width && nextHeight === height) break;
      width = nextWidth;
      height = nextHeight;
    }
    throw new Error('This photo could not be made small enough. Choose a smaller photo.');
  } catch (error) {
    if (error instanceof Error && [READ_ERROR, ENCODE_ERROR,
      'This photo has too many pixels. Choose a smaller photo.',
      'This photo could not be made small enough. Choose a smaller photo.'].includes(error.message)) throw error;
    throw new Error(ENCODE_ERROR);
  } finally {
    if (image) {
      image.onload = null;
      image.onerror = null;
      image.src = '';
    }
    if (url) URL.revokeObjectURL(url);
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
