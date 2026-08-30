# Pinned upstream msgpack-smalltalk source closure

This directory vendors an exact, byte-for-byte subset of the upstream
[msgpack-smalltalk](https://github.com/msgpack/msgpack-smalltalk) repository so
that WS3 can compile and execute authentic upstream MessagePack code through
the Symmetric Smalltalk pipeline. CI never fetches upstream; everything needed
is pinned here.

## Provenance

- Upstream repository: https://github.com/msgpack/msgpack-smalltalk
- Pinned revision (full SHA): `3e3823625409cbd45f7c5bf79be94d1e9135baa9`
- Retrieved as: https://github.com/msgpack/msgpack-smalltalk/archive/3e3823625409cbd45f7c5bf79be94d1e9135baa9.tar.gz
- Source format: FileTree (`*.class/`, `*.extension/`, `properties.json`, per-method `.st` files)
- License: the upstream repository at this revision carries **no LICENSE/COPYING
  file**; only `README.md` (which states no license). The vendored files retain
  upstream authorship and are used here as test fixtures only.

## What is pinned

The `MessagePack-Core.package` subset containing exactly the ten classes needed
for a scalar encode + decode round-trip through the upstream dispatch graph
(`MpMessagePack pack:`/`unpack:`):

- `MpConstants` — type-code constants (class-side)
- `MpError` — error type
- `MpPortableUtil` — dialect abstraction (class variables `Default`, `DialectSpecificClass`)
- `MpSettings` — settings dictionary wrapper
- `MpTypeMapper` — type-mapper base (class-instance variable `actionMap`)
- `MpEncodeTypeMapper` — encode dispatch
- `MpDecodeTypeMapper` — decode dispatch
- `MpEncoder` — encoder
- `MpDecoder` — decoder
- `MpMessagePack` — entry point (`pack:`/`unpack:`/`packUnpack:`)

All files under these class directories are copied unmodified from the pinned
revision. Dialect-specific subclasses (`MessagePack-Squeak-Core`,
`MessagePack-Pharo-Core`, `MessagePack-VW`), the `BaselineOf`/`ConfigurationOf`
packages, tests, and the various `*.extension` directories are intentionally
excluded from this first closure.

## Fidelity rule

Upstream source stays unchanged. Any dialect adaptation required by Symmetric
Smalltalk is applied explicitly, at load time, in the loader/test seam — never
by editing these vendored files.
