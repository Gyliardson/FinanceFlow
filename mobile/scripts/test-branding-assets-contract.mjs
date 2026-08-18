import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const mobileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(mobileDir, 'app.json'), 'utf8')).expo;
const packageJson = JSON.parse(fs.readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const expected = {
  icon: './assets/icon.png',
  splash: './assets/splash-icon.png',
  adaptive: './assets/adaptive-icon.png',
  favicon: './assets/favicon.png',
};

const splashPlugin = config.plugins?.find(
  (entry) => Array.isArray(entry) && entry[0] === 'expo-splash-screen',
);
assert.ok(splashPlugin, 'Expo splash must use the supported expo-splash-screen config plugin');
assert.match(packageJson.dependencies?.['expo-splash-screen'] ?? '', /^~57\.0\./, 'Splash plugin dependency must track Expo SDK 57');

const splashConfig = splashPlugin[1] ?? {};
assert.equal(config.icon, expected.icon, 'Expo app icon must use the canonical production asset');
assert.equal(splashConfig.image, expected.splash, 'Expo splash plugin must use the canonical production asset');
assert.equal(splashConfig.resizeMode, 'contain', 'Splash artwork must preserve its aspect ratio');
assert.equal(splashConfig.backgroundColor?.toLowerCase(), '#4338ca');
assert.equal(splashConfig.imageWidth, 200);
assert.equal(config.android?.adaptiveIcon?.foregroundImage, expected.adaptive);
assert.equal(config.android?.adaptiveIcon?.backgroundColor?.toLowerCase(), '#4338ca');
assert.equal(config.web?.favicon, expected.favicon);
assert.equal(config.splash, undefined, 'Legacy top-level Expo splash configuration must not return');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(relativePath, minimumSide) {
  const absolutePath = path.resolve(mobileDir, relativePath);
  assert.ok(absolutePath.startsWith(`${mobileDir}${path.sep}`), `Asset path escapes mobile directory: ${relativePath}`);
  const stat = fs.statSync(absolutePath);
  assert.ok(stat.isFile(), `Configured asset is not a file: ${relativePath}`);
  assert.ok(stat.size > 512, `Configured asset is implausibly small: ${relativePath}`);

  const bytes = fs.readFileSync(absolutePath);
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${relativePath} must contain real PNG bytes`);

  let offset = PNG_SIGNATURE.length;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let compressionMethod;
  let filterMethod;
  let interlaceMethod;
  let sawIhdr = false;
  let sawIend = false;
  const idatChunks = [];

  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, `${relativePath} has a truncated PNG chunk header`);
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcStart = dataStart + length;
    const chunkEnd = crcStart + 4;
    assert.ok(chunkEnd <= bytes.length, `${relativePath} has a truncated PNG chunk payload`);

    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString('ascii');
    const payload = bytes.subarray(dataStart, crcStart);
    const expectedCrc = bytes.readUInt32BE(crcStart);
    const actualCrc = crc32(Buffer.concat([typeBytes, payload]));
    assert.equal(actualCrc, expectedCrc, `${relativePath} has an invalid CRC in ${type}`);

    if (type === 'IHDR') {
      assert.equal(sawIhdr, false, `${relativePath} must contain exactly one IHDR chunk`);
      assert.equal(offset, PNG_SIGNATURE.length, `${relativePath} IHDR must be the first PNG chunk`);
      assert.equal(length, 13, `${relativePath} has an invalid IHDR length`);
      width = payload.readUInt32BE(0);
      height = payload.readUInt32BE(4);
      bitDepth = payload[8];
      colorType = payload[9];
      compressionMethod = payload[10];
      filterMethod = payload[11];
      interlaceMethod = payload[12];
      sawIhdr = true;
    } else if (type === 'IDAT') {
      assert.ok(sawIhdr, `${relativePath} IDAT appears before IHDR`);
      idatChunks.push(payload);
    } else if (type === 'IEND') {
      assert.equal(length, 0, `${relativePath} IEND must be empty`);
      sawIend = true;
      offset = chunkEnd;
      break;
    }

    offset = chunkEnd;
  }

  assert.ok(sawIhdr, `${relativePath} must contain IHDR`);
  assert.ok(idatChunks.length > 0, `${relativePath} must contain image data`);
  assert.ok(sawIend, `${relativePath} must terminate with IEND`);
  assert.equal(offset, bytes.length, `${relativePath} must not contain trailing bytes after IEND`);
  assert.equal(width, height, `${relativePath} must be square`);
  assert.ok(width >= minimumSide, `${relativePath} must be at least ${minimumSide}x${minimumSide}`);
  assert.equal(bitDepth, 8, `${relativePath} must use 8-bit PNG samples`);
  assert.equal(colorType, 6, `${relativePath} must use RGBA PNG encoding`);
  assert.equal(compressionMethod, 0, `${relativePath} has an unsupported PNG compression method`);
  assert.equal(filterMethod, 0, `${relativePath} has an unsupported PNG filter method`);
  assert.equal(interlaceMethod, 0, `${relativePath} must use non-interlaced PNG encoding`);

  const decodedScanlines = zlib.inflateSync(Buffer.concat(idatChunks));
  assert.equal(
    decodedScanlines.length,
    height * (1 + width * 4),
    `${relativePath} decoded scanline length does not match its RGBA dimensions`,
  );

  return { relativePath, width, height, bytes: stat.size };
}

const reports = [
  inspectPng(expected.icon, 1024),
  inspectPng(expected.splash, 1024),
  inspectPng(expected.adaptive, 1024),
  inspectPng(expected.favicon, 256),
];

for (const report of reports) {
  console.log(`BRANDING_ASSET=${report.relativePath} ${report.width}x${report.height} ${report.bytes}bytes png`);
}
console.log('MOBILE_BRANDING_ASSETS_CONTRACT=pass');
