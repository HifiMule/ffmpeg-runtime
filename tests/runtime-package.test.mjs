import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRuntimeArchive } from '../scripts/archive.mjs';
import { relocateRuntime, manifest, buildIdentity } from '../scripts/runtime-package.mjs';

function header(name, type = '0', link = '') {
  const h = Buffer.alloc(512); h.write(name, 0); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write('00000000000\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h.write(type, 156); h.write(link, 157); h.write('ustar\0', 257);
  const checksum = h.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0'); h.write(`${checksum}\0 `, 148);
  return h;
}
const tar = (...entries) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
test('ustar accepts library aliases and rejects traversal, links, extensions and trailing data', () => {
  assert.equal(validateRuntimeArchive(tar(header('./', '5'), header('./lib', '5'), header('./lib/a'), header('./lib/b', '2', 'a'))).size, 4);
  for (const entry of [header('../outside'), header('/outside'), header('C:/outside'), header('lib/b', '2', '../../outside'), header('pax', 'x')]) {
    assert.throws(() => validateRuntimeArchive(tar(entry)), /Unsafe|Unsupported/);
  }
  assert.throws(() => validateRuntimeArchive(tar(header('lib', '2', 'other'), header('lib/file'))), /non-directory/);
  assert.throws(() => validateRuntimeArchive(gzipSync(Buffer.concat([header('a'), Buffer.alloc(512), header('../outside'), Buffer.alloc(1024)]))), /trailing/);
  assert.throws(() => validateRuntimeArchive(gzipSync(Buffer.concat([header('a'), Buffer.alloc(512)]))), /trailing/);
  assert.throws(() => validateRuntimeArchive(tar(header('a'), header('./a'))), /Duplicate/);
});

test('relocation rewrites metadata and both macOS library and executable load paths', t => {
  const prefix = mkdtempSync(join(tmpdir(), 'runtime-relocation-')); t.after(() => rmSync(prefix, { recursive: true, force: true }));
  mkdirSync(join(prefix, 'lib/pkgconfig'), { recursive: true }); mkdirSync(join(prefix, 'bin'));
  const dylib = join(prefix, 'lib/libavcodec.63.dylib'), ffmpeg = join(prefix, 'bin/ffmpeg');
  writeFileSync(dylib, 'fixture'); writeFileSync(ffmpeg, 'fixture');
  writeFileSync(join(prefix, 'lib/pkgconfig/libavcodec.pc'), 'prefix=/producer\nlibdir=${prefix}/lib\n');
  const dependencies = new Map([[dylib, '/producer/lib/libavcodec.63.dylib'], [ffmpeg, '/producer/lib/libavcodec.63.dylib']]);
  const signed = [];
  const execute = (command, args) => {
    const file = args.at(-1);
    if (command === 'otool') return `${file}:\n\t${dependencies.get(file)}\n`;
    if (command === 'install_name_tool') { if (args[0] === '-change') dependencies.set(file, args[2]); return ''; }
    if (command === 'codesign') { signed.push(file); return ''; }
    assert.fail(command);
  };
  relocateRuntime(prefix, 'aarch64-apple-darwin', '/producer', execute);
  assert.deepEqual(new Set(signed), new Set([dylib, ffmpeg]));
  assert.ok([...dependencies.values()].every(path => path.startsWith(prefix)));
  assert.ok(readFileSync(join(prefix, 'lib/pkgconfig/libavcodec.pc'), 'utf8').startsWith(`prefix=${prefix.replaceAll('\\', '/')}\n`));
});

test('build contract excludes application settings and keeps four shipping targets', () => {
  assert.equal(Object.keys(manifest.targets).length, 4);
  for (const key of ['bufferPolicy', 'bindingVersions', 'verification']) assert.equal(key in manifest, false);
  assert.match(buildIdentity, /^[a-f0-9]{64}$/);
  assert.ok(manifest.windowsConfigureFlags.includes('--extra-cflags=-MD'));
});
