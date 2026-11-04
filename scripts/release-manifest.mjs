import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root, manifest, buildIdentity, releaseTag, assetName, sha256 } from './runtime-package.mjs';

const out = resolve(process.argv[2] ?? 'dist');
const producerCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const targets = {};
for (const target of Object.keys(manifest.targets)) {
  const receipt = JSON.parse(readFileSync(join(out, `${target}.json`), 'utf8'));
  const asset = assetName(target);
  if (receipt.target !== target || receipt.release !== releaseTag || receipt.buildIdentity !== buildIdentity || receipt.producerCommit !== producerCommit || receipt.asset !== asset || receipt.relocatedVerified !== true || receipt.sha256 !== sha256(join(out, asset))) throw new Error(`Unverified or mismatched release asset ${target}`);
  targets[target] = { asset, sha256: receipt.sha256 };
}
writeFileSync(join(out, 'release-manifest.json'), JSON.stringify({ schemaVersion: 1, repository: 'HifiMule/ffmpeg-runtime', release: releaseTag, producerCommit, buildIdentity, targets }, null, 2) + '\n');
