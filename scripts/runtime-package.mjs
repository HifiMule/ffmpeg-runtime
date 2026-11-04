import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');
export const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
export const buildIdentity = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
export const releaseTag = `ffmpeg-${manifest.ffmpegRelease}-r${manifest.recipeRevision}`;
export const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export const assetName = target => `${releaseTag}-${target}.tar.gz`;

// Reused by consumers after extracting a producer archive at another location.
export function relocateRuntime(prefix, target, previousPrefix, execute = execFileSync, finalPrefix = prefix) {
  const pcdir = join(prefix, 'lib/pkgconfig');
  const portable = finalPrefix.replaceAll('\\', '/');
  if (existsSync(pcdir)) for (const name of readdirSync(pcdir).filter(name => name.endsWith('.pc'))) {
    const path = join(pcdir, name);
    const text = readFileSync(path, 'utf8');
    // All runtime metadata describes the extracted SDK, including private codecs.
    writeFileSync(path, text.replace(/^prefix=.*$/m, `prefix=${portable}`));
  }
  if (manifest.targets[target]?.platform !== 'darwin') return;
  const files = readdirSync(join(prefix, 'lib')).filter(name => name.endsWith('.dylib'))
    .map(name => join(prefix, 'lib', name)).filter(path => !lstatSync(path).isSymbolicLink());
  for (const path of [...files, join(prefix, 'bin/ffmpeg')]) {
    const options = { encoding: 'utf8' };
    if (path.endsWith('.dylib')) {
      const identifier = execute('otool', ['-D', path], options).split('\n').slice(1).find(line => line.trim())?.trim();
      if (identifier?.startsWith(`${previousPrefix}/`)) execute('install_name_tool', ['-id', identifier.replace(previousPrefix, finalPrefix), path]);
    }
    const dependencies = execute('otool', ['-L', path], options).split('\n').slice(1).map(line => line.trim().split(/\s+/)[0]).filter(Boolean);
    for (const dependency of dependencies) if (dependency.startsWith(`${previousPrefix}/`)) {
      execute('install_name_tool', ['-change', dependency, dependency.replace(previousPrefix, finalPrefix), path]);
    }
    execute('codesign', ['--force', '--sign', '-', path]);
    const remaining = execute('otool', ['-L', path], options);
    if (previousPrefix !== finalPrefix && remaining.includes(previousPrefix)) throw new Error(`Producer load path remains in ${path}`);
  }
}
