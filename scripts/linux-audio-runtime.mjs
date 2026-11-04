import { acquireRuntimeLock } from "./runtime-lock.mjs";
export { acquireRuntimeLock as acquireLinuxAudioRuntimeLock } from "./runtime-lock.mjs";
import { buildEncodingDependencies, encodingDependencyReceipt } from "./encoding-dependencies.mjs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";



const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const receiptName = ".hifimule-audio-runtime.json";
const machines = { "aarch64-unknown-linux-gnu": "AArch64", "x86_64-unknown-linux-gnu": "Advanced Micro Devices X86-64" };
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: options.stdio ?? ["ignore", "pipe", "pipe"], env: { ...(options.env ?? process.env), LC_ALL: "C" } });
}
function expectedReceipt(target) {
  return { schemaVersion: 1, targetTriple: target, ffmpegRelease: manifest.ffmpegRelease, sourceSha256: manifest.sourceSha256, encodingDependencies: encodingDependencyReceipt, configureFlags: ["--disable-autodetect", ...manifest.configureFlags], abiVersions: manifest.abiVersions };
}
function pcEnv(prefix) {
  return { ...process.env, PKG_CONFIG_PATH: [join(prefix, "lib/pkgconfig"), process.env.PKG_CONFIG_PATH].filter(Boolean).join(":") };
}
function elf(path) {
  const header = run("readelf", ["-h", path]);
  const dynamic = run("readelf", ["-d", path]);
  return { machine: header.match(/^\s*Machine:\s*(.+)$/m)?.[1]?.trim(), soname: dynamic.match(/\(SONAME\).*\[([^\]]+)\]/)?.[1], needed: [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map((m) => m[1]) };
}
function assertElf(path, target, soname) {
  if (!lstatSync(path).isFile()) throw new Error(`Expected regular ELF file: ${path}`);
  const meta = elf(path);
  if (meta.machine !== machines[target]) throw new Error(`ELF architecture mismatch for ${path}: ${meta.machine || "unknown"}`);
  if (soname && meta.soname !== soname) throw new Error(`ELF SONAME mismatch for ${path}: ${meta.soname || "missing"}`);
  return meta;
}
export function validateLinuxRuntimeReceipt(prefix, target) {
  const path = join(prefix, receiptName);
  if (!existsSync(path)) throw new Error(`Controlled runtime receipt is missing: ${path}`);
  let found;
  try { found = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error(`Controlled runtime receipt is invalid: ${path}`); }
  if (JSON.stringify(found) !== JSON.stringify(expectedReceipt(target))) throw new Error(`Controlled runtime receipt is stale: ${path}`);
  return found;
}
export function verifyLinuxAudioPrefix(prefix, target, options = {}) {
  if (!machines[target]) throw new Error(`Unsupported Linux audio runtime target: ${target}`);
  prefix = realpathSync(prefix);
  if (!options.skipReceipt) validateLinuxRuntimeReceipt(prefix, target);
  const env = pcEnv(prefix);
  for (const [library, version] of Object.entries(manifest.abiVersions)) {
    const name = `lib${library}`;
    const actual = run("pkg-config", ["--modversion", name], { env }).trim();
    const libdir = realpathSync(run("pkg-config", ["--variable=libdir", name], { env }).trim());
    if (actual !== version) throw new Error(`${name} version mismatch in ${prefix}: ${actual}`);
    if (libdir !== prefix && !libdir.startsWith(`${prefix}/`)) throw new Error(`${name} resolved outside controlled prefix: ${libdir}`);
    assertElf(realpathSync(join(libdir, `${name}.so`)), target, `${name}.so.${version.split(".")[0]}`);
  }
  return prefix;
}
function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function download(archive) {
  const temp = `${archive}.${process.pid}.${randomUUID()}.tmp`;
  try { run("curl", ["--fail", "--location", "--retry", "5", "--retry-all-errors", "--connect-timeout", "30", "--max-time", "300", "--retry-max-time", "600", "--output", temp, manifest.sourceUrl], { stdio: "inherit" }); if (sha(temp) !== manifest.sourceSha256) throw new Error("FFmpeg source checksum mismatch"); renameSync(temp, archive); }
  finally { rmSync(temp, { force: true }); }
}
function relocatePkgConfigFiles(staging, prefix) {
  const pcDir = join(staging, "lib/pkgconfig");
  for (const name of readdirSync(pcDir)) {
    if (!name.endsWith(".pc")) continue;
    const path = join(pcDir, name);
    const relocated = readFileSync(path, "utf8").split(staging).join(prefix);
    if (relocated.includes(staging)) throw new Error(`Failed to relocate pkg-config metadata: ${path}`);
    writeFileSync(path, relocated);
  }
}
export function ensureLinuxAudioRuntime(target) {
  if (process.platform !== "linux") throw new Error("The controlled Linux audio runtime can only be prepared on Linux");
  if (!machines[target]) throw new Error(`Unsupported Linux audio runtime target: ${target}`);
  const override = process.env.HIFIMULE_FFMPEG_PREFIX;
  const prefix = resolve(override || join(root, "target/audio-runtime", `ffmpeg-${manifest.ffmpegRelease}-${target}`));
  if (override) return verifyLinuxAudioPrefix(prefix, target);
  const unlock = acquireRuntimeLock(`${prefix}.lock`);
  try {
    if (existsSync(prefix)) { try { return verifyLinuxAudioPrefix(prefix, target); } catch { rmSync(prefix, { recursive: true, force: true }); } }
    const cache = join(root, "target/audio-runtime/sources");
    const archive = join(cache, `ffmpeg-${manifest.ffmpegRelease}.tar.xz`);
    const work = join(cache, `build-${target}-${process.pid}-${randomUUID()}`);
    const source = join(work, `ffmpeg-${manifest.ffmpegRelease}`);
    const staging = `${prefix}.staging-${process.pid}-${randomUUID()}`;
    mkdirSync(cache, { recursive: true });
    try {
      if (!existsSync(archive) || sha(archive) !== manifest.sourceSha256) { rmSync(archive, { force: true }); download(archive); }
      mkdirSync(work); run("tar", ["-xf", archive, "-C", work], { stdio: "inherit" }); mkdirSync(staging);
      const env = buildEncodingDependencies({ cache, work, prefix: staging, target });
      run("./configure", [`--prefix=${staging}`, `--extra-cflags=-I${staging}/include`, `--extra-ldflags=-L${staging}/lib`, "--pkg-config-flags=--static", "--disable-autodetect", ...manifest.configureFlags], { cwd: source, env, stdio: "inherit" });
      run("make", [`-j${Math.min(8, Math.max(1, availableParallelism()))}`], { cwd: source, stdio: "inherit" });
      run("make", ["install"], { cwd: source, stdio: "inherit" });
      writeFileSync(join(staging, receiptName), `${JSON.stringify(expectedReceipt(target), null, 2)}\n`);
      verifyLinuxAudioPrefix(staging, target);
      relocatePkgConfigFiles(staging, prefix);
      renameSync(staging, prefix);
    } finally { rmSync(work, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true }); }
    return verifyLinuxAudioPrefix(prefix, target);
  } finally { unlock(); }
}
