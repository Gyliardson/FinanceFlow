import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

function inspectPng(relativePath, minimumSide) {
  const absolutePath = path.resolve(mobileDir, relativePath);
  assert.ok(absolutePath.startsWith(`${mobileDir}${path.sep}`), `Asset path escapes mobile directory: ${relativePath}`);
  const stat = fs.statSync(absolutePath);
  assert.ok(stat.isFile(), `Configured asset is not a file: ${relativePath}`);
  assert.ok(stat.size > 512, `Configured asset is implausibly small: ${relativePath}`);

  const bytes = fs.readFileSync(absolutePath);
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), `${relativePath} must contain real PNG bytes`);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', `${relativePath} must expose a PNG IHDR chunk`);

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, height, `${relativePath} must be square`);
  assert.ok(width >= minimumSide, `${relativePath} must be at least ${minimumSide}x${minimumSide}`);
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
