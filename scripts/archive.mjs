import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { posix, join } from 'node:path';

function archivePath(value) {
  if (!value || /[\\\x00-\x1f\x7f:]/.test(value) || value.startsWith('/') || value.split('/').includes('..')) throw new Error(`Unsafe runtime archive path: ${JSON.stringify(value)}`);
  return posix.normalize(value).replace(/^\.\//, '').replace(/\/$/, '');
}

// Producer deliberately emits ustar: reject extensions instead of interpreting
// a different filename than the native extractor (PAX, GNU long names, etc.).
export function validateRuntimeArchive(bytes) {
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const entries = new Map();
  let offset = 0, ended = false;
  const string = (header, start, size) => header.subarray(start, start + size).toString('utf8').split('\0')[0];
  for (; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (tar.length - offset < 1024 || !tar.subarray(offset).every(byte => byte === 0)) throw new Error('Invalid trailing runtime tar data');
      ended = true; break;
    }
    const checksum = string(header, 148, 8).trim();
    if (!/^[0-7]+$/.test(checksum)) throw new Error('Invalid tar checksum');
    const calculated = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (calculated !== parseInt(checksum, 8)) throw new Error('Runtime tar checksum mismatch');
    const sizeField = string(header, 124, 12).trim();
    if (!/^[0-7]+$/.test(sizeField)) throw new Error('Invalid tar size');
    const size = parseInt(sizeField, 8), type = string(header, 156, 1) || '0';
    const prefix = string(header, 345, 155), filename = string(header, 0, 100);
    const name = archivePath(prefix ? `${prefix}/${filename}` : filename);
    if (!['0', '5', '2'].includes(type)) throw new Error(`Unsupported runtime tar entry: ${type}`);
    if (entries.has(name)) throw new Error(`Duplicate runtime tar entry: ${name}`);
    if (type === '2') {
      const link = string(header, 157, 100);
      if (!link || /[\\\x00-\x1f\x7f:]/.test(link) || posix.isAbsolute(link)) throw new Error('Unsafe runtime symlink');
      archivePath(posix.join(posix.dirname(name), link));
    }
    entries.set(name, type);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (offset > tar.length) throw new Error('Truncated runtime tar entry');
  }
  if (!ended || !entries.size) throw new Error('Incomplete runtime archive');
  for (const name of entries.keys()) {
    let parent = posix.dirname(name);
    while (parent !== '.') {
      if (entries.has(parent) && entries.get(parent) !== '5') throw new Error('Archive entry traverses a non-directory');
      parent = posix.dirname(parent);
    }
  }
  return entries;
}

export function extractRuntimeArchive(archive, destination) {
  validateRuntimeArchive(readFileSync(archive));
  mkdirSync(destination, { recursive: true });
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe') : 'tar';
  execFileSync(tar, ['-xzf', archive, '-C', destination], { stdio: 'inherit' });
}
