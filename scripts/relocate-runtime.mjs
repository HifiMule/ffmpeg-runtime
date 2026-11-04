import { resolve } from 'node:path';
import { relocateRuntime } from './runtime-package.mjs';
const [target, prefix, previous, finalPrefix = prefix] = process.argv.slice(2);
relocateRuntime(resolve(prefix), target, resolve(previous), undefined, resolve(finalPrefix));
