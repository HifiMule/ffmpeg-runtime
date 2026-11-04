#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildRuntime } from './build-runtime.mjs';
import { verifyRuntime } from './verify-runtime.mjs';
import { root, manifest, buildIdentity, releaseTag, assetName, sha256, relocateRuntime } from './runtime-package.mjs';
import { extractRuntimeArchive } from './archive.mjs';

const target = process.argv[2], out = resolve(process.argv[3] ?? join(root, 'dist'));
if (!manifest.targets[target]) throw new Error(`Unsupported target ${target}`);
const prefix = buildRuntime(target);
verifyRuntime(prefix, target);
mkdirSync(out, { recursive: true });
const name = assetName(target), archive = join(out, name);
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe') : 'tar';
execFileSync(tar, ['--format=ustar', '-czf', archive, '-C', prefix, '.'], { stdio: 'inherit' });
const relocated = mkdtempSync(join(tmpdir(), 'ffmpeg-relocated-'));
try {
  // Remove the producer prefix so unresolved absolute load paths cannot pass accidentally.
  rmSync(prefix, { recursive: true });
  extractRuntimeArchive(archive, relocated);
  relocateRuntime(relocated, target, prefix);
  verifyRuntime(relocated, target);
  const metadata = JSON.parse(readFileSync(join(relocated, '.ffmpeg-runtime.json'), 'utf8'));
  writeFileSync(join(out, `${target}.json`), JSON.stringify({ schemaVersion: 1, release: releaseTag, producerCommit: metadata.producerCommit, buildIdentity, target, asset: name, sha256: sha256(archive), relocatedVerified: true }, null, 2) + '\n');
} finally { rmSync(relocated, { recursive: true, force: true }); }
