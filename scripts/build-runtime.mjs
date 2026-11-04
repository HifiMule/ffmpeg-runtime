#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, manifest, buildIdentity, releaseTag, sha256 } from './runtime-package.mjs';
import { ensureLinuxAudioRuntime } from './linux-audio-runtime.mjs';
import { ensureMacosAudioRuntime } from './macos-audio-runtime.mjs';
import { ensureWindowsAudioRuntime, windowsBuildEnvironment, findMsys2Bash, prependWindowsPath } from './windows-audio-runtime.mjs';

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

export function buildRuntime(target) {
  const info = manifest.targets[target];
  if (!info || info.platform !== process.platform) throw new Error(`Build ${target} on its native supported platform`);
  // Overrides are consumer conveniences, never inputs to a published producer build.
  delete process.env.HIFIMULE_FFMPEG_PREFIX;
  delete process.env.FFMPEG_DIR;
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  let env = process.env;
  if (process.platform === 'win32') {
    env = windowsBuildEnvironment(target);
    const bash = findMsys2Bash(env);
    if (bash) env = prependWindowsPath(env, join(bash, '..'));
  }
  const sourceCache = join(root, 'target/audio-runtime/sources');
  const archive = join(sourceCache, `ffmpeg-${manifest.ffmpegRelease}.tar.xz`);
  const signature = `${archive}.asc`, key = join(sourceCache, 'ffmpeg-devel.asc');
  // Unix builders already verify the source hash; authenticate its upstream signer too.
  if (info.platform !== 'win32') {
    mkdirSync(sourceCache, { recursive: true });
    if (!existsSync(archive) || sha256(archive) !== manifest.sourceSha256) run('curl', ['--fail', '--location', '--retry', '5', '--output', archive, manifest.sourceUrl]);
    if (sha256(archive) !== manifest.sourceSha256) throw new Error('FFmpeg source checksum mismatch');
    for (const [url, path] of [[manifest.signatureUrl, signature], [manifest.signingKeyUrl, key]]) {
      run('curl', ['--fail', '--location', '--retry', '5', '--output', path, url]);
    }
    const home = mkdtempSync(join(tmpdir(), 'ffmpeg-gpg-'));
    try {
      run('gpg', ['--batch', '--homedir', home, '--import', key]);
      const fingerprints = execFileSync('gpg', ['--batch', '--homedir', home, '--with-colons', '--fingerprint'], { encoding: 'utf8' });
      if (!fingerprints.split('\n').some(line => line.split(':')[0] === 'fpr' && line.split(':')[9] === manifest.signingKey)) throw new Error('FFmpeg signing key fingerprint mismatch');
      const status = execFileSync('gpg', ['--batch', '--homedir', home, '--status-fd', '1', '--verify', signature, archive], { encoding: 'utf8' });
      if (status.match(/^\[GNUPG:\] VALIDSIG ([0-9A-F]+) /m)?.[1] !== manifest.signingKey) throw new Error('FFmpeg upstream signature mismatch');
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
  const cachedPrefix = join(root, 'target/audio-runtime', `ffmpeg-${manifest.ffmpegRelease}-${info.platform === 'win32' ? 'official-' : ''}${target}`);
  if (existsSync(cachedPrefix)) {
    const receipt = join(cachedPrefix, '.ffmpeg-runtime.json');
    const previous = existsSync(receipt) ? JSON.parse(readFileSync(receipt, 'utf8')) : {};
    if (previous.buildIdentity !== buildIdentity || previous.producerCommit !== commit) rmSync(cachedPrefix, { recursive: true, force: true });
  }
  const prefix = info.platform === 'linux' ? ensureLinuxAudioRuntime(target)
    : info.platform === 'darwin' ? ensureMacosAudioRuntime(target)
      : ensureWindowsAudioRuntime(target, { env });
  copyFileSync(join(root, 'THIRD_PARTY_AUDIO_NOTICES.md'), join(prefix, 'THIRD_PARTY_AUDIO_NOTICES.md'));
  const work = mkdtempSync(join(tmpdir(), 'ffmpeg-license-'));
  const tar = info.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe') : 'tar';
  try {
    run(tar, ['-xf', archive, '-C', work, `ffmpeg-${manifest.ffmpegRelease}/COPYING.LGPLv2.1`]);
    const licenses = join(prefix, 'share/licenses/ffmpeg');
    mkdirSync(licenses, { recursive: true });
    copyFileSync(join(work, `ffmpeg-${manifest.ffmpegRelease}/COPYING.LGPLv2.1`), join(licenses, 'COPYING.LGPLv2.1'));
  } finally { rmSync(work, { recursive: true, force: true }); }
  const compiler = info.platform === 'win32' ? 'cl.exe' : 'cc';
  let toolchain;
  try { toolchain = execFileSync(compiler, info.platform === 'win32' ? [] : ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { toolchain = `${error.stdout ?? ''}${error.stderr ?? ''}`; }
  if (!toolchain?.trim()) throw new Error('Could not record compiler toolchain');
  writeFileSync(join(prefix, '.ffmpeg-runtime.json'), JSON.stringify({ schemaVersion: 1, release: releaseTag, producerCommit: commit, buildIdentity, target, prefix, toolchain: toolchain.trim(), runner: process.env.ImageVersion ?? process.version }, null, 2) + '\n');
  return prefix;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prefix = buildRuntime(process.argv[2]);
  if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify({ prefix }) + '\n');
  else console.log(prefix);
}
