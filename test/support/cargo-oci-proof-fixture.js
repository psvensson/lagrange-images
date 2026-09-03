// The closed Cargo project the real digest-pinned OCI proof compiles (Bead lagrange-images-1h9).
//
// Everything the build needs is produced here as bytes and enters the toolchain only as explicit
// CodeArtifacts: manifest, lock, one Rust source, the canonical vendor source-replacement config
// and one vendored library package. Nothing is read from the host, and no path in this file is
// ever handed to Cargo directly — `test/cargo-rustc-oci-real.test.js` puts every entry into the
// image and lets `ToolchainService` materialize the workspace.
//
// The vendored package pretends to be a crates.io package (that is what source replacement means),
// so its `.cargo-checksum.json` and the `Cargo.lock` checksum must agree or real Cargo refuses the
// build. Both are derived from the actual file bytes below, which is what makes the falsifiers in
// the proof honest: change a vendored byte and the two disagree.
import {createHash} from 'node:crypto';

const PROOF_PACKAGE = 'lagrange-cargo-proof';
const PROOF_BINARY = 'lagrange_cargo_proof';
const PROOF_EXPORT = 'lagrange_scaled_sum';
const PROOF_TRIPLE = 'wasm32-unknown-unknown';
const VENDOR_PACKAGE = 'tiny-math';
const VENDOR_VERSION = '1.0.0';
const VENDOR_ASSET_BYTES = Buffer.from([0x00, 0x01, 0x02, 0xff]);
const CARGO_VENDOR_CONFIG = '[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "vendor"\n';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// `#![no_std]` keeps the vendored crate free of anything that would make the produced module
// import a host function: `wasm-scalar-call/v0` refuses an imported module, so an accidental
// import would fail the execution half of the proof rather than pass it quietly.
function vendorLibrarySource(scale) {
  return `#![no_std]\n\nconst SCALE: i32 = ${scale};\n\npub fn scaled_sum(left: i32, right: i32) -> i32 {\n    left.wrapping_add(right).wrapping_mul(SCALE)\n}\n`;
}

const PROOF_SOURCE = `#[no_mangle]\npub extern "C" fn ${PROOF_EXPORT}(left: i32, right: i32) -> i32 {\n    tiny_math::scaled_sum(left, right)\n}\n\nfn main() {}\n`;

const PROOF_MANIFEST = `[package]
name = "${PROOF_PACKAGE}"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "${PROOF_BINARY}"
path = "src/main.rs"

[dependencies]
${VENDOR_PACKAGE} = "${VENDOR_VERSION}"

[profile.release]
opt-level = "s"
panic = "abort"
strip = true
`;

const VENDOR_MANIFEST = `[package]
name = "${VENDOR_PACKAGE}"
version = "${VENDOR_VERSION}"
edition = "2021"

[lib]
name = "tiny_math"
path = "src/lib.rs"
`;

function lockText(packageChecksum) {
  return `version = 4

[[package]]
name = "${PROOF_PACKAGE}"
version = "0.1.0"
dependencies = [
 "${VENDOR_PACKAGE}",
]

[[package]]
name = "${VENDOR_PACKAGE}"
version = "${VENDOR_VERSION}"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${packageChecksum}"
`;
}

/**
 * Build the explicit artifact material for one closed Cargo project.
 *
 * @param {object} [options]
 * @param {number} [options.scale] multiplier compiled into the vendored library; the proof reads
 *   it back out of the executed WASM, so two different values must produce two different results.
 * @param {string|null} [options.corruptVendorLibrary] replacement text written for the vendored
 *   library *without* updating `.cargo-checksum.json` — the "changed input" falsifier.
 * @param {string|null} [options.lockChecksum] overrides only the `Cargo.lock` checksum, leaving the
 *   vendor package internally consistent — the falsifier real Cargo, not this repository, catches.
 */
function cargoOciProofFixture({scale = 3, corruptVendorLibrary = null, lockChecksum = null} = {}) {
  const declaredLibrary = vendorLibrarySource(scale);
  const writtenLibrary = corruptVendorLibrary ?? declaredLibrary;
  const files = [
    {path: 'Cargo.toml', declared: Buffer.from(VENDOR_MANIFEST, 'utf8'), text: VENDOR_MANIFEST},
    {path: 'src/lib.rs', declared: Buffer.from(declaredLibrary, 'utf8'), text: writtenLibrary},
    {path: 'assets/data.bin', declared: VENDOR_ASSET_BYTES, bytes: VENDOR_ASSET_BYTES},
  ];
  const checksums = Object.fromEntries(files.map(({path, declared}) => [path, sha256(declared)]));
  // A directory source has no `.crate` archive to hash, so the package checksum is only ever a
  // stable identity for the vendored bytes. Deriving it from the declared file digests means a
  // vendored change that is honestly re-checksummed also moves the lock entry, exactly as a real
  // registry release would.
  const packageChecksum = sha256(Buffer.from(files.map(({path}) => `${path}:${checksums[path]}`).join('\n'), 'utf8'));
  const checksumJson = JSON.stringify({package: packageChecksum, files: checksums});

  return Object.freeze({
    binary: PROOF_BINARY,
    exportName: PROOF_EXPORT,
    triple: PROOF_TRIPLE,
    vendorPackageDirectory: VENDOR_PACKAGE,
    packageChecksum,
    manifestText: PROOF_MANIFEST,
    lockText: lockText(lockChecksum ?? packageChecksum),
    sourcePath: 'src/main.rs',
    sourceText: PROOF_SOURCE,
    configText: CARGO_VENDOR_CONFIG,
    vendorFiles: Object.freeze([
      ...files.map(({path, text, bytes}) => Object.freeze({
        path: `vendor/${VENDOR_PACKAGE}/${path}`,
        text,
        bytes,
      })),
      Object.freeze({path: `vendor/${VENDOR_PACKAGE}/.cargo-checksum.json`, text: checksumJson}),
    ]),
    expected(left, right) {
      return Math.imul(left + right, scale) | 0;
    },
  });
}

export {
  CARGO_VENDOR_CONFIG,
  PROOF_BINARY,
  PROOF_EXPORT,
  PROOF_PACKAGE,
  PROOF_TRIPLE,
  VENDOR_PACKAGE,
  cargoOciProofFixture,
};
