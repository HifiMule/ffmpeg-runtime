import { buildEncodingDependencies, encodingDependencyReceipt } from "./encoding-dependencies.mjs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";



const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const targets = {
  "x86_64-apple-darwin": { arch: "x86_64", minimum: "10.15" },
  "aarch64-apple-darwin": { arch: "arm64", minimum: "11.0" },
};
const receiptName = ".hifimule-audio-runtime.json";

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: options.stdio ?? ["ignore", "pipe", "pipe"], env: options.env ?? process.env });
}
function sha(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function relocatePkgConfigFiles(staging, prefix) {
  const directory = join(staging, "lib/pkgconfig");
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".pc")) continue;
    const path = join(directory, name);
    writeFileSync(path, readFileSync(path, "utf8").split(staging).join(prefix));
  }
}
function expectedReceipt(target) {
  const info = targets[target];
  return {
    schemaVersion: 1,
    targetTriple: target,
    ffmpegRelease: manifest.ffmpegRelease,
    sourceUrl: manifest.sourceUrl,
    signatureUrl: manifest.signatureUrl,
    signingKey: manifest.signingKey,
    sourceSha256: manifest.sourceSha256,
    configureFlags: ["--disable-autodetect", `--arch=${info.arch}`, "--target-os=darwin", ...manifest.configureFlags],
    abiVersions: manifest.abiVersions,
    encodingDependencies: encodingDependencyReceipt,
    minimumSystemVersion: info.minimum,
  };
}
export function macosRuntimeReceipt(target) {
  if (!targets[target]) throw new Error(`Unsupported macOS audio runtime target: ${target}`);
  return expectedReceipt(target);
}
function dylibFor(prefix, library, major) {
  const candidates = readdirSync(join(prefix, "lib"))
    .filter((name) => name.startsWith(`lib${library}.`) && name.endsWith(".dylib"));
  const exact = candidates.find((name) => name === `lib${library}.${major}.dylib`)
    ?? candidates.find((name) => name.includes(`.${major}.`));
  if (!exact) throw new Error(`Controlled macOS runtime is missing lib${library}.${major}.dylib`);
  return join(prefix, "lib", exact);
}
function relocateMachOLoadPaths(staging, prefix, execute = run) {
  const dylibs = readdirSync(join(staging, "lib"))
    .map((name) => join(staging, "lib", name))
    .filter((path) => path.endsWith(".dylib") && !lstatSync(path).isSymbolicLink());
  for (const path of [...dylibs, join(staging, "bin/ffmpeg")]) {
    const identifiers = path.endsWith('.dylib') ? execute("otool", ["-D", path]).split("\n").slice(1).map((line) => line.trim()).filter(Boolean) : [];
    for (const identifier of identifiers.filter((value) => value.startsWith(`${staging}/`))) {
      execute("install_name_tool", ["-id", identifier.replace(staging, prefix), path]);
    }
    const dependencies = execute("otool", ["-L", path]).split("\n").slice(1)
      .map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
    for (const dependency of dependencies.filter((value) => value.startsWith(`${staging}/`))) {
      execute("install_name_tool", ["-change", dependency, dependency.replace(staging, prefix), path]);
    }
    execute("codesign", ["--force", "--sign", "-", path]);
  }
}
export function verifyMacosAudioRuntime(prefix, target, options = {}) {
  const info = targets[target];
  if (!info) throw new Error(`Unsupported macOS audio runtime target: ${target}`);
  prefix = resolve(prefix);
  const expectedLoadPrefix = resolve(options.expectedLoadPrefix ?? prefix);
  const receiptPath = join(prefix, receiptName);
  if (!existsSync(receiptPath)) throw new Error(`Controlled macOS runtime receipt is missing: ${receiptPath}`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (JSON.stringify(receipt) !== JSON.stringify(expectedReceipt(target))) throw new Error(`Controlled macOS runtime receipt is stale: ${receiptPath}`);
  const env = { ...process.env, PKG_CONFIG_PATH: join(prefix, "lib/pkgconfig") };
  const execute = options.run ?? run;
  for (const [library, version] of Object.entries(manifest.abiVersions)) {
    const actual = execute("pkg-config", ["--modversion", `lib${library}`], { env }).trim();
    if (actual !== version) throw new Error(`lib${library} version mismatch: expected ${version}, found ${actual}`);
    execute("lipo", [dylibFor(prefix, library, version.split(".")[0]), "-verify_arch", info.arch]);
    const loadCommands = execute("otool", ["-L", dylibFor(prefix, library, version.split(".")[0])]);
    const dependencies = loadCommands.split("\n").slice(1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
    if (dependencies.some((dependency) => dependency.includes(".staging-")
      || dependency.includes("target/audio-runtime") && !dependency.startsWith(`${expectedLoadPrefix}/`))) {
      throw new Error(`lib${library} contains stale controlled-runtime load paths:\n${dependencies.join("\n")}`);
    }
  }
  return prefix;
}
export function ensureMacosAudioRuntime(target, options = {}) {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("The controlled macOS audio runtime can only be prepared on macOS");
  const info = targets[target];
  if (!info) throw new Error(`Unsupported macOS audio runtime target: ${target}`);
  const baseEnv = options.env ?? process.env;
  if (baseEnv.HIFIMULE_FFMPEG_PREFIX) return verifyMacosAudioRuntime(baseEnv.HIFIMULE_FFMPEG_PREFIX, target, options);
  const cacheRoot = resolve(options.cacheRoot ?? join(root, "target/audio-runtime"));
  const prefix = resolve(options.prefix ?? join(cacheRoot, `ffmpeg-${manifest.ffmpegRelease}-${target}`));
  if (existsSync(prefix)) { try { return verifyMacosAudioRuntime(prefix, target); } catch { rmSync(prefix, { recursive: true, force: true }); } }
  const sources = join(cacheRoot, "sources");
  const archive = join(sources, `ffmpeg-${manifest.ffmpegRelease}.tar.xz`);
  const work = join(cacheRoot, `macos-${target}-${process.pid}-${randomUUID()}`);
  const staging = `${prefix}.staging-${process.pid}-${randomUUID()}`;
  const execute = options.run ?? run;
  mkdirSync(sources, { recursive: true });
  try {
    if (!existsSync(archive) || sha(archive) !== manifest.sourceSha256) {
      const temporary = `${archive}.tmp-${randomUUID()}`;
      execute("curl", ["--fail", "--location", "--retry", "5", "--retry-all-errors", "--connect-timeout", "30", "--max-time", "300", "--retry-max-time", "600", "--output", temporary, manifest.sourceUrl], { stdio: "inherit" });
      if (sha(temporary) !== manifest.sourceSha256) throw new Error("FFmpeg source checksum mismatch");
      renameSync(temporary, archive);
    }
    mkdirSync(work, { recursive: true });
    mkdirSync(staging, { recursive: true });
    execute("tar", ["-xf", archive, "-C", work], { stdio: "inherit" });
    const source = join(work, `ffmpeg-${manifest.ffmpegRelease}`);
    let env = { ...baseEnv, MACOSX_DEPLOYMENT_TARGET: info.minimum, CC: `clang -arch ${info.arch}`, CFLAGS: `-arch ${info.arch}`, LDFLAGS: `-arch ${info.arch}` };
    env = buildEncodingDependencies({ cache: sources, work, prefix: staging, target, env });
    execute("./configure", [`--prefix=${staging}`, `--extra-cflags=-I${staging}/include`, `--extra-ldflags=-L${staging}/lib`, "--pkg-config-flags=--static", "--disable-autodetect", `--arch=${info.arch}`, "--target-os=darwin", ...manifest.configureFlags], { cwd: source, env, stdio: "inherit" });
    execute("make", [`-j${Math.min(8, Math.max(1, availableParallelism()))}`], { cwd: source, env, stdio: "inherit" });
    execute("make", ["install"], { cwd: source, env, stdio: "inherit" });
    relocateMachOLoadPaths(staging, prefix, execute);
    writeFileSync(join(staging, receiptName), `${JSON.stringify(expectedReceipt(target), null, 2)}\n`);
    verifyMacosAudioRuntime(staging, target, { expectedLoadPrefix: prefix });
    relocatePkgConfigFiles(staging, prefix);
    renameSync(staging, prefix);
    return verifyMacosAudioRuntime(prefix, target);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}
