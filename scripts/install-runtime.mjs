import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { extractRuntimeArchive } from './archive.mjs';
import { relocateRuntime, manifest, buildIdentity } from './runtime-package.mjs';

const [target, archive, destination, expectedCommit] = process.argv.slice(2);
if (!manifest.targets[target] || manifest.targets[target].platform !== process.platform) throw new Error(`Unsupported native target ${target}`);
const prefix = resolve(destination);
extractRuntimeArchive(resolve(archive), prefix);
const metadata = JSON.parse(readFileSync(join(prefix, '.ffmpeg-runtime.json'), 'utf8'));
if (metadata.target !== target || metadata.buildIdentity !== buildIdentity || metadata.producerCommit !== expectedCommit || typeof metadata.prefix !== 'string' || !metadata.prefix) throw new Error('Extracted runtime identity mismatch');
relocateRuntime(prefix, target, metadata.prefix);
