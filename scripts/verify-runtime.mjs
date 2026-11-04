import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest, buildIdentity, releaseTag } from './runtime-package.mjs';
import { verifyLinuxAudioPrefix } from './linux-audio-runtime.mjs';
import { verifyMacosAudioRuntime } from './macos-audio-runtime.mjs';
import { verifyWindowsAudioRuntime } from './windows-audio-runtime.mjs';
import { verifyAudioRuntime, verifyEncodingCapabilities } from './verify-audio-runtime.mjs';

export function verifyRuntime(prefix, target, { smoke = true } = {}) {
  const info = manifest.targets[target];
  if (!info || info.platform !== process.platform) throw new Error(`Unsupported native runtime target ${target}`);
  const metadata = JSON.parse(readFileSync(join(prefix, '.ffmpeg-runtime.json'), 'utf8'));
  if (metadata.target !== target || metadata.buildIdentity !== buildIdentity || metadata.release !== releaseTag) throw new Error('Runtime build identity mismatch');
  if (info.platform === 'linux') verifyLinuxAudioPrefix(prefix, target);
  else if (info.platform === 'darwin') {
    verifyMacosAudioRuntime(prefix, target);
    const files = readdirSync(join(prefix, 'lib')).filter(name => name.endsWith('.dylib')).map(name => join(prefix, 'lib', name)).filter(path => !lstatSync(path).isSymbolicLink());
    for (const path of [...files, join(prefix, 'bin/ffmpeg')]) {
      execFileSync('lipo', [path, '-verify_arch', target.startsWith('aarch64') ? 'arm64' : 'x86_64']);
      const commands = execFileSync('otool', ['-l', path], { encoding: 'utf8' });
      const minimum = commands.match(/cmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)[\s\S]*?(?:minos|version) ([0-9.]+)/)?.[1];
      const compare = value => value.split('.').reduce((result, part, index) => result + Number(part) * 1000 ** (2 - index), 0);
      if (!minimum || compare(minimum) > compare(info.minimumSystemVersion)) throw new Error(`macOS deployment minimum mismatch in ${path}: ${minimum}`);
    }
  }
  else verifyWindowsAudioRuntime(prefix, target);
  const env = { ...process.env, PKG_CONFIG_PATH: join(prefix, 'lib/pkgconfig'), LD_LIBRARY_PATH: join(prefix, 'lib'), DYLD_LIBRARY_PATH: join(prefix, 'lib') };
  if (info.platform !== 'win32') verifyAudioRuntime({ prefix, env });
  verifyEncodingCapabilities(prefix, { env });
  for (const dependency of ['ffmpeg', ...manifest.encodingDependencies.map(dep => dep.name)]) {
    if (!existsSync(join(prefix, 'share/licenses', dependency))) throw new Error(`Missing ${dependency} license`);
  }
  if (smoke) {
    const work = mkdtempSync(join(tmpdir(), 'ffmpeg-smoke-'));
    try {
      const input = join(work, 'input.wav');
      const wav = Buffer.alloc(44 + 4800 * 2);
      wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
      wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40); writeFileSync(input, wav);
      const ffmpeg = join(prefix, 'bin', info.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      const run = args => execFileSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', ...args], { env, stdio: 'inherit' });
      const encoded = join(work, 'encoded.flac'), decoded = join(work, 'decoded.wav');
      run(['-i', input, '-c:a', 'flac', encoded]);
      run(['-i', encoded, '-c:a', 'pcm_s16le', decoded]);
      if (readFileSync(decoded).length < 9600) throw new Error('Encode/decode smoke produced no PCM');
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  return metadata;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verifyRuntime(resolve(process.argv[3]), process.argv[2]);
