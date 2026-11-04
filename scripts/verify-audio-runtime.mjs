#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';


const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
if (manifest.ffmpegRelease !== '9.0.2' || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)) {
  throw new Error('Audio runtime manifest is incomplete');
}

export const audioRuntimeVerification = Object.freeze({
  environmentVariable: 'HIFIMULE_FFMPEG_RUNTIME_VERIFIED',
  value: 'ffmpeg-9-runtime-verified-v3',
});

export function withoutAudioRuntimeVerification(env = process.env) {
  const clean = { ...env };
  delete clean[audioRuntimeVerification.environmentVariable];
  return clean;
}

export function withAudioRuntimeVerification(env) {
  return {
    ...withoutAudioRuntimeVerification(env),
    [audioRuntimeVerification.environmentVariable]: audioRuntimeVerification.value,
  };
}

function versionParts(version) {
  if (!/^\d+(?:\.\d+){2}$/.test(version)) return undefined;
  return version.split('.').map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function verifyEncodingCapabilities(prefix, options = {}) {
  const execute = options.execFileSync ?? execFileSync;
  const executable = resolve(prefix, 'bin', (options.platform ?? process.platform) === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  for (const [kind, required] of [['encoders', manifest.requiredEncoders], ['muxers', manifest.requiredMuxers]]) {
    const listing = execute(executable, ['-hide_banner', `-${kind}`], { encoding: 'utf8', env: options.env ?? process.env });
    const names = new Set(listing.split(/\r?\n/).flatMap(line => line.trim().split(/\s+/)[1]?.split(',') ?? []));
    for (const name of required) if (!names.has(name)) throw new Error(`Controlled audio runtime is missing required ${kind}: ${name}`);
  }
}

export function verifyAudioRuntime(options = {}) {
  const execute = options.execFileSync ?? execFileSync;
  const prefix = options.prefix ? resolve(options.prefix) : undefined;
  const baseEnv = withoutAudioRuntimeVerification(options.env ?? process.env);
  const pkgConfigEnv = prefix
    ? {
        ...baseEnv,
        PKG_CONFIG_PATH: [resolve(prefix, 'lib/pkgconfig'), baseEnv.PKG_CONFIG_PATH]
          .filter(Boolean)
          .join(':'),
      }
    : baseEnv;
  const versions = {};

  for (const [library, expectedVersion] of Object.entries(manifest.abiVersions)) {
    const packageName = `lib${library}`;
    let version;
    try {
      version = execute('pkg-config', ['--modversion', packageName], {
        encoding: 'utf8',
        env: pkgConfigEnv,
      }).trim();
    } catch (error) {
      const location = prefix ? ` under controlled prefix ${prefix}` : '';
      const expectation = prefix
        ? `exact ABI ${expectedVersion}`
        : `ABI ${expectedVersion} or newer within major ${expectedVersion.split('.')[0]}`;
      throw new Error(
        `Controlled FFmpeg ${manifest.ffmpegRelease} dependency ${packageName}${location} could not be verified. ` +
        `Expected ${expectation}. Ensure pkg-config can read the validated runtime metadata.`,
        { cause: error },
      );
    }
    const expectedParts = versionParts(expectedVersion);
    const foundParts = versionParts(version);
    const exactPrefixMatch = prefix && version === expectedVersion;
    const compatibleHostMatch = !prefix && foundParts && expectedParts &&
      foundParts[0] === expectedParts[0] && compareVersions(foundParts, expectedParts) >= 0;
    if (!exactPrefixMatch && !compatibleHostMatch) {
      const expectation = prefix
        ? `exact ABI ${expectedVersion}`
        : `ABI ${expectedVersion} or newer within major ${expectedParts[0]}`;
      throw new Error(`${packageName} ABI mismatch: expected ${expectation}, found ${version}`);
    }
    versions[packageName] = version;
    if (prefix) {
      const libdir = resolve(execute('pkg-config', ['--variable=libdir', packageName], {
        encoding: 'utf8',
        env: pkgConfigEnv,
      }).trim());
      const relativeLibdir = relative(prefix, libdir);
      if (relativeLibdir === '..' || relativeLibdir.startsWith(`..${sep}`) || isAbsolute(relativeLibdir)) {
        throw new Error(`${packageName} resolved outside controlled prefix ${prefix}: ${libdir}`);
      }
    }
  }
  return { ffmpegRelease: manifest.ffmpegRelease, prefix, versions };
}
