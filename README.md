# HifiMule FFmpeg runtime

Build recipes and verified SDK/runtime archives for HifiMule. This repository is
pinned as HifiMule's `dependencies/ffmpeg-runtime` Git submodule. Compiled archives
belong in releases, never in Git.

`manifest.json` pins sources, codecs, ABI versions, configure flags and the four
shipping targets. App playback policy and Rust bindings stay in HifiMule. These
scripts were extracted from HifiMule and retain its GPL-2.0 license. FFmpeg and
codecs retain their individual licenses and source URLs in
`THIRD_PARTY_AUDIO_NOTICES.md`; the recipes do not enable FFmpeg GPL codecs.

## Build and test

Use Node.js 24 or newer on the target's native platform. Install:

- Linux: C compiler, make, pkg-config, NASM, GnuPG, curl, tar, xz and binutils.
- macOS: Xcode command line tools, pkg-config, NASM and GnuPG.
- Windows: Visual Studio C++ Build Tools, CMake, MSYS2 with make, sed, grep, gawk,
  diffutils, pkgconf and gnupg. `MSYS2_ROOT` selects the MSYS2 installation.

```sh
rtk node --test tests/*.test.mjs
rtk node scripts/build-runtime.mjs aarch64-apple-darwin
rtk node scripts/package-runtime.mjs aarch64-apple-darwin
```

Builds verify official FFmpeg checksums/signatures and codec source hashes.
Archives include headers, linking/shared libraries, ffmpeg, licenses and receipts.
Packaging extracts elsewhere, removes the original prefix, relocates metadata/load
paths and checks ABI, architecture, macOS minimums, capabilities and encode/decode.
`dist/<target>.json` records checksum, producer commit and build identity.

## Publish a dependency revision

1. Update manifest/recipes and increment `recipeRevision`, even when FFmpeg's
   version stays unchanged. Never replace published assets.
2. Commit and push, then tag that commit with
   `ffmpeg-<ffmpegRelease>-r<recipeRevision>` and push the tag.
3. The workflow validates Windows x64, Linux x64, macOS Intel and ARM64. Only after
   all targets pass does it publish archives and `release-manifest.json`. Manual
   dispatch validates without publishing.
4. Update HifiMule's submodule to that commit. Download the published manifest and
   pass it to HifiMule's `scripts/pin-audio-runtime.mjs`. Review/commit the resulting
   lock with the submodule pointer after candidate package verification.

Retain Ubuntu 22.04 Linux compatibility and macOS minimums 10.15 Intel / 11.0 ARM64.
Toolchain/recipe changes require a new revision. App buffer policy never changes
the dependency identity.
