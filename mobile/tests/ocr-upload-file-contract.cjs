'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const buildDir = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
assert.ok(buildDir, 'FINANCEFLOW_AUTH_CONTRACT_BUILD must point to compiled production modules');

const {
  buildOcrUploadFile,
  inferOcrMimeFromPath,
  normalizeOcrMime,
} = require(path.join(buildDir, 'ocrUploadFile.js'));

assert.equal(normalizeOcrMime('image/jpeg'), 'image/jpeg');
assert.equal(normalizeOcrMime('IMAGE/JPG; charset=binary'), 'image/jpeg');
assert.equal(normalizeOcrMime('image/png'), 'image/png');
assert.equal(normalizeOcrMime('image/webp'), 'image/webp');
assert.equal(normalizeOcrMime('application/pdf'), 'application/pdf');
assert.equal(normalizeOcrMime('image/heic'), null);

assert.equal(inferOcrMimeFromPath('photo.JPEG?cache=1'), 'image/jpeg');
assert.equal(inferOcrMimeFromPath('file:///tmp/receipt.png#preview'), 'image/png');
assert.equal(inferOcrMimeFromPath('receipt.webp'), 'image/webp');
assert.equal(inferOcrMimeFromPath('document.pdf'), 'application/pdf');
assert.equal(inferOcrMimeFromPath('receipt.heic'), null);

assert.deepEqual(
  buildOcrUploadFile({ uri: 'file:///receipt.bin', mimeType: 'image/png' }, 'image'),
  { uri: 'file:///receipt.bin', name: 'documento.png', type: 'image/png' },
  'supported picker MIME must win even when URI has no extension',
);

assert.deepEqual(
  buildOcrUploadFile({ uri: 'file:///receipt.webp', mimeType: null }, 'image'),
  { uri: 'file:///receipt.webp', name: 'documento.webp', type: 'image/webp' },
  'missing picker MIME must infer a recognized image extension',
);

assert.deepEqual(
  buildOcrUploadFile({ uri: 'file:///camera-output', fileName: 'camera.JPG' }, 'image'),
  { uri: 'file:///camera-output', name: 'documento.jpg', type: 'image/jpeg' },
);

assert.equal(
  buildOcrUploadFile({ uri: 'file:///receipt.heic', mimeType: null }, 'image'),
  null,
  'unknown image formats must fail closed instead of pretending to be JPEG',
);

assert.equal(
  buildOcrUploadFile({ uri: 'file:///document.pdf' }, 'image'),
  null,
  'PDF must never enter the image picker contract',
);

assert.deepEqual(
  buildOcrUploadFile({ uri: 'file:///picker-cache/no-extension', mimeType: null }, 'pdf'),
  { uri: 'file:///picker-cache/no-extension', name: 'documento.pdf', type: 'application/pdf' },
  'document-picker PDF uploads must keep an explicit PDF multipart contract',
);

console.log('OCR_UPLOAD_FILE_CONTRACT=pass');
