import {createHash} from 'node:crypto';
import {
  OBJECT_READ_OPERATION,
  OBJECT_WRITE_OPERATION,
  objectResource,
} from '../authority/object-resource.js';
import {
  ComponentHostImportRegistry,
  normalizeHostImportSpecifier,
} from '../callable/host-import-registry.js';
import {
  CALLABLE_TYPES,
  installCallableInterface,
} from '../callable/interface-artifacts.js';
import {installCallableInterfaceV2} from '../callable/interface-v2-artifacts.js';
import {isCompositeType} from '../callable/type-grammar.js';
import {installWasmComponentBindingV2} from '../callable/wasm-component-binding.js';
import {OBJECT_CREATE_OPERATION} from '../callable/image-creation-binding.js';
import {
  objectVersionToken,
  parseObjectVersionToken,
  putObjectAtExpectedVersion,
} from '../object/version-token.js';
import {uuid as randomUUID} from '../support/default-crypto.js';
import {
  booleanValue,
  bytesValue,
  float64Value,
  integerValue,
  objectRef,
  textValue,
} from '../value/index.js';
import {
  CARGO_VENDOR_CONFIG_V1,
  RUST_CARGO_CONFIG_V1,
  RUST_CARGO_VENDOR_FILE_V1,
  normalizeVendorPath,
} from './cargo-rustc-oci-provider.js';

const LAGRANGE_RUST_SDK_V1 = 'lagrange-rust-sdk/v1';

const LAGRANGE_HOST_IMAGE_READ_SPECIFIER = 'lagrange:host/image-read@1.0.0';
const LAGRANGE_HOST_IMAGE_MUTATE_SPECIFIER = 'lagrange:host/image-mutate@1.0.0';
const LAGRANGE_HOST_IMAGE_CREATE_SPECIFIER = 'lagrange:host/image-create@1.0.0';
const LAGRANGE_HOST_IMAGE_OBSERVE_SPECIFIER = 'lagrange:host/image-observe@1.0.0';
const LAGRANGE_HOST_CALLABLE_DISPATCH_SPECIFIER = 'lagrange:host/callable-dispatch@1.0.0';

const LAGRANGE_RUST_HOST_IMPORTS = Object.freeze([
  LAGRANGE_HOST_CALLABLE_DISPATCH_SPECIFIER,
  LAGRANGE_HOST_IMAGE_CREATE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_MUTATE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_OBSERVE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_READ_SPECIFIER,
]);

const SUPPORTED_HOST_IMPORT_SET = new Set(LAGRANGE_RUST_HOST_IMPORTS);

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertRustCrateIdentifier(value, label) {
  const name = requiredText(value, label);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new TypeError(`${label} must be a valid Rust crate identifier`);
  }
  return name;
}

function normalizeSdkHostImports(hostImports = LAGRANGE_RUST_HOST_IMPORTS) {
  if (!Array.isArray(hostImports)) {
    throw new TypeError('Lagrange Rust SDK hostImports must be an array');
  }
  const seen = new Set();
  for (const entry of hostImports) {
    const specifier = normalizeHostImportSpecifier(entry, 'Lagrange Rust SDK host import');
    if (!SUPPORTED_HOST_IMPORT_SET.has(specifier)) {
      throw new TypeError(`unsupported Lagrange Rust SDK host import specifier: ${specifier}`);
    }
    if (seen.has(specifier)) {
      throw new TypeError(`duplicate Lagrange Rust SDK host import specifier: ${specifier}`);
    }
    seen.add(specifier);
  }
  return Object.freeze([...seen].sort());
}

function normalizeSdkExports(exportsList = []) {
  if (!Array.isArray(exportsList)) {
    throw new TypeError('Lagrange Rust SDK exports must be an array');
  }
  const seenNames = new Set();
  return Object.freeze(exportsList.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`Lagrange Rust SDK export ${index} must be an object`);
    }
    const name = requiredText(entry.name ?? entry.function, `Lagrange Rust SDK export ${index} name`);
    const fnName = requiredText(entry.function ?? entry.name, `Lagrange Rust SDK export ${index} function`);
    if (seenNames.has(name)) {
      throw new TypeError(`duplicate Lagrange Rust SDK export: ${name}`);
    }
    seenNames.add(name);
    if (!Array.isArray(entry.parameters)) {
      throw new TypeError(`Lagrange Rust SDK export ${name} parameters must be an array`);
    }
    const parameters = Object.freeze(
      entry.parameters.map((param, paramIndex) => requiredText(
        param,
        `Lagrange Rust SDK export ${name} parameter ${paramIndex}`,
      )),
    );
    const result = requiredText(entry.result, `Lagrange Rust SDK export ${name} result`);
    const types = entry.types && typeof entry.types === 'object' && !Array.isArray(entry.types)
      ? Object.freeze({...entry.types})
      : Object.freeze({});
    return Object.freeze({
      name,
      function: fnName,
      parameters,
      result,
      types,
    });
  }));
}

function sha256Hex(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function buildSdkCargoToml({packageName, version, edition}) {
  return [
    '[package]',
    `name = "${packageName}"`,
    `version = "${version}"`,
    `edition = "${edition}"`,
    'publish = false',
    '',
    '[lib]',
    'path = "src/lib.rs"',
    '',
  ].join('\n');
}

function buildSdkLibRs({packageName, version, hostImports, exportsList}) {
  const lines = [
    '//! Generated Lagrange Rust Host SDK (`lagrange-rust-sdk/v1`).',
    '//! Provides explicit, capability-checked host-call bindings for WASM Components.',
    '#![no_std]',
    'extern crate alloc;',
    '',
    'use alloc::string::String;',
    'use alloc::vec::Vec;',
    '',
    `pub const SDK_SCHEMA: &str = "${LAGRANGE_RUST_SDK_V1}";`,
    `pub const SDK_PACKAGE_NAME: &str = "${packageName}";`,
    `pub const SDK_VERSION: &str = "${version}";`,
    '',
    '#[derive(Clone, Debug, PartialEq, Eq)]',
    'pub struct ObjectVersionToken(pub String);',
    '',
    '#[derive(Clone, Debug, PartialEq, Eq)]',
    'pub struct ObjectObservation {',
    '    pub object_id: String,',
    '    pub version_token: ObjectVersionToken,',
    '}',
    '',
    '#[derive(Clone, Debug, PartialEq)]',
    'pub enum HostValue {',
    '    Bool(bool),',
    '    S32(i32),',
    '    S64(i64),',
    '    F64(f64),',
    '    Text(String),',
    '    Bytes(Vec<u8>),',
    '}',
    '',
  ];

  if (hostImports.includes(LAGRANGE_HOST_IMAGE_READ_SPECIFIER)) {
    lines.push(
      `pub const HOST_IMAGE_READ_SPECIFIER: &str = "${LAGRANGE_HOST_IMAGE_READ_SPECIFIER}";`,
      '',
      'pub trait HostImageRead {',
      '    fn read_slot(&self, alias: &str, slot: &str) -> Result<HostValue, String>;',
      '    fn read_object_version(&self, alias: &str) -> Result<ObjectVersionToken, String>;',
      '}',
      '',
      '#[link(wasm_import_module = "lagrange:host/image-read@1.0.0")]',
      'extern "C" {',
      '    pub fn lagrange_host_read_slot_s64(alias_ptr: *const u8, alias_len: usize, slot_ptr: *const u8, slot_len: usize) -> i64;',
      '}',
      '',
    );
  }

  if (hostImports.includes(LAGRANGE_HOST_IMAGE_MUTATE_SPECIFIER)) {
    lines.push(
      `pub const HOST_IMAGE_MUTATE_SPECIFIER: &str = "${LAGRANGE_HOST_IMAGE_MUTATE_SPECIFIER}";`,
      '',
      'pub trait HostImageMutate {',
      '    fn write_slot(',
      '        &self,',
      '        alias: &str,',
      '        slot: &str,',
      '        value: HostValue,',
      '        expected_version: &ObjectVersionToken,',
      '    ) -> Result<ObjectVersionToken, String>;',
      '}',
      '',
      '#[link(wasm_import_module = "lagrange:host/image-mutate@1.0.0")]',
      'extern "C" {',
      '    pub fn lagrange_host_write_slot_s64(alias_ptr: *const u8, alias_len: usize, slot_ptr: *const u8, slot_len: usize, value: i64) -> i32;',
      '}',
      '',
    );
  }

  if (hostImports.includes(LAGRANGE_HOST_IMAGE_CREATE_SPECIFIER)) {
    lines.push(
      `pub const HOST_IMAGE_CREATE_SPECIFIER: &str = "${LAGRANGE_HOST_IMAGE_CREATE_SPECIFIER}";`,
      '',
      'pub trait HostImageCreate {',
      '    fn create_instance(',
      '        &self,',
      '        class_alias: &str,',
      '        slots: &[(&str, HostValue)],',
      '    ) -> Result<(String, ObjectVersionToken), String>;',
      '}',
      '',
    );
  }

  if (hostImports.includes(LAGRANGE_HOST_IMAGE_OBSERVE_SPECIFIER)) {
    lines.push(
      `pub const HOST_IMAGE_OBSERVE_SPECIFIER: &str = "${LAGRANGE_HOST_IMAGE_OBSERVE_SPECIFIER}";`,
      '',
      'pub trait HostImageObserve {',
      '    fn observe(&self, aliases: &[&str]) -> Result<Vec<ObjectObservation>, String>;',
      '}',
      '',
    );
  }

  if (hostImports.includes(LAGRANGE_HOST_CALLABLE_DISPATCH_SPECIFIER)) {
    lines.push(
      `pub const HOST_CALLABLE_DISPATCH_SPECIFIER: &str = "${LAGRANGE_HOST_CALLABLE_DISPATCH_SPECIFIER}";`,
      '',
      'pub trait HostCallableDispatch {',
      '    fn invoke_callable(&self, target_alias: &str, args: &[HostValue]) -> Result<HostValue, String>;',
      '}',
      '',
    );
  }

  if (exportsList.length > 0) {
    lines.push('pub mod declared_exports {');
    for (const exp of exportsList) {
      const constIdent = exp.name.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
      lines.push(`    pub const EXPORT_${constIdent}: &str = "${exp.function}";`);
    }
    lines.push('}', '');
  }

  return lines.join('\n');
}

function buildSdkWitWorld({hostImports, exportsList}) {
  const lines = [
    'package lagrange:sdk@1.0.0;',
    '',
    'world lagrange-component {',
  ];
  for (const specifier of hostImports) {
    lines.push(`  import ${specifier};`);
  }
  for (const exp of exportsList) {
    const params = exp.parameters.map((type, idx) => `p${idx}: ${type}`).join(', ');
    lines.push(`  export ${exp.function}: func(${params}) -> ${exp.result};`);
  }
  lines.push('}', '');
  return lines.join('\n');
}

function generateLagrangeRustSdkCrate({
  packageName = 'lagrange_sdk',
  version = '0.1.0',
  edition = '2021',
  vendorDirectory = 'vendor/lagrange_sdk',
  hostImports = LAGRANGE_RUST_HOST_IMPORTS,
  exports: exportsList = [],
} = {}) {
  const normalizedPkg = assertRustCrateIdentifier(packageName, 'Lagrange Rust SDK packageName');
  const normalizedVersion = requiredText(version, 'Lagrange Rust SDK version');
  const normalizedEdition = requiredText(edition, 'Lagrange Rust SDK edition');
  if (!['2018', '2021', '2024'].includes(normalizedEdition)) {
    throw new TypeError('Lagrange Rust SDK edition must be 2018, 2021 or 2024');
  }
  const cargoTomlPath = normalizeVendorPath(`${vendorDirectory}/Cargo.toml`, 'Lagrange Rust SDK Cargo.toml path');
  const normalizedVendorDir = cargoTomlPath.slice(0, -'/Cargo.toml'.length);
  const libRsPath = normalizeVendorPath(`${normalizedVendorDir}/src/lib.rs`, 'Lagrange Rust SDK lib.rs path');
  const checksumPath = normalizeVendorPath(
    `${normalizedVendorDir}/.cargo-checksum.json`,
    'Lagrange Rust SDK checksum path',
  );

  const normalizedImports = normalizeSdkHostImports(hostImports);
  const normalizedExports = normalizeSdkExports(exportsList);

  const cargoToml = buildSdkCargoToml({
    packageName: normalizedPkg,
    version: normalizedVersion,
    edition: normalizedEdition,
  });
  const libRs = buildSdkLibRs({
    packageName: normalizedPkg,
    version: normalizedVersion,
    hostImports: normalizedImports,
    exportsList: normalizedExports,
  });
  const checksumPayload = JSON.stringify({
    files: {
      'Cargo.toml': sha256Hex(cargoToml),
      'src/lib.rs': sha256Hex(libRs),
    },
    package: null,
  });
  const witWorld = buildSdkWitWorld({
    hostImports: normalizedImports,
    exportsList: normalizedExports,
  });

  return Object.freeze({
    schema: LAGRANGE_RUST_SDK_V1,
    packageName: normalizedPkg,
    version: normalizedVersion,
    edition: normalizedEdition,
    vendorDirectory: normalizedVendorDir,
    hostImports: normalizedImports,
    exports: normalizedExports,
    witWorld,
    files: Object.freeze({
      [cargoTomlPath]: cargoToml,
      [libRsPath]: libRs,
      [checksumPath]: checksumPayload,
    }),
  });
}

async function materializeLagrangeRustSdkArtifacts({
  images,
  imageId,
  sdk = generateLagrangeRustSdkCrate(),
  idPrefix = 'rust-sdk',
  includeCargoConfig = true,
} = {}) {
  if (!images || typeof images.putCodeArtifact !== 'function') {
    throw new TypeError('materializeLagrangeRustSdkArtifacts requires an images service with putCodeArtifact');
  }
  const targetImageId = requiredText(imageId, 'materializeLagrangeRustSdkArtifacts imageId');
  const prefix = requiredText(idPrefix, 'materializeLagrangeRustSdkArtifacts idPrefix');
  if (!sdk || sdk.schema !== LAGRANGE_RUST_SDK_V1 || !sdk.files || typeof sdk.files !== 'object') {
    throw new TypeError(`sdk must be a ${LAGRANGE_RUST_SDK_V1} descriptor`);
  }

  const vendorArtifacts = [];
  const sortedEntries = Object.entries(sdk.files).sort(([left], [right]) => left.localeCompare(right));
  for (const [logicalPath, contentText] of sortedEntries) {
    const safeSuffix = logicalPath.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const artifact = await images.putCodeArtifact(targetImageId, {
      id: `${prefix}:${safeSuffix}`,
      languageId: 'rust',
      representation: RUST_CARGO_VENDOR_FILE_V1,
      logicalPath,
      content: textValue(contentText),
      dependencies: [],
      metadata: {
        sdkSchema: LAGRANGE_RUST_SDK_V1,
        sdkPackageName: sdk.packageName,
        sdkVersion: sdk.version,
      },
    });
    vendorArtifacts.push(artifact);
  }

  let configArtifact = null;
  if (includeCargoConfig) {
    configArtifact = await images.putCodeArtifact(targetImageId, {
      id: `${prefix}:cargo-config`,
      languageId: 'rust',
      representation: RUST_CARGO_CONFIG_V1,
      logicalPath: '.cargo/config.toml',
      content: textValue(CARGO_VENDOR_CONFIG_V1),
      dependencies: [],
      metadata: {
        sdkSchema: LAGRANGE_RUST_SDK_V1,
      },
    });
  }

  const allArtifacts = configArtifact ? [...vendorArtifacts, configArtifact] : [...vendorArtifacts];
  const refs = allArtifacts.map((artifact) => objectRef(targetImageId, artifact.id));

  return Object.freeze({
    sdk,
    vendorArtifacts: Object.freeze(vendorArtifacts),
    configArtifact,
    artifacts: Object.freeze(allArtifacts),
    refs: Object.freeze(refs),
  });
}

function hostValueToCanonical(raw) {
  if (raw && typeof raw === 'object' && typeof raw.kind === 'string') {
    return raw;
  }
  if (typeof raw === 'boolean') return booleanValue(raw);
  if (typeof raw === 'bigint') return integerValue(raw);
  if (typeof raw === 'number') {
    return Number.isInteger(raw) ? integerValue(raw) : float64Value(raw);
  }
  if (typeof raw === 'string') return textValue(raw);
  if (raw instanceof Uint8Array) return bytesValue(raw);
  throw new TypeError(`unsupported Lagrange Rust SDK host value: ${typeof raw}`);
}

function canonicalToHostPrimitive(value) {
  if (!value || typeof value !== 'object') return value;
  switch (value.kind) {
    case 'boolean':
      return value.value;
    case 'integer':
      return Number(value.value);
    case 'float64':
      return Number(value.value);
    case 'text':
      return value.value;
    case 'bytes':
      return Buffer.from(value.base64, 'base64');
    default:
      return value;
  }
}

async function resolveSlotIdByName(images, imageId, shapeRef, slotOrName) {
  const slotKey = requiredText(slotOrName, 'slot identifier');
  if (!shapeRef || typeof images.getShape !== 'function') return slotKey;
  const shape = await images.getShape(shapeRef.imageId ?? imageId, shapeRef.objectId ?? shapeRef);
  if (!shape || !Array.isArray(shape.slots)) return slotKey;
  const matched = shape.slots.find((slot) => slot.id === slotKey || slot.name === slotKey);
  return matched ? matched.id : slotKey;
}

function createLagrangeRustHostBindings({
  images,
  imageId,
  readableObjects = {},
  mutableObjects = {},
  creatableShapes = {},
  callableTargets = {},
  registry = null,
} = {}) {
  if (!images || typeof images.getObject !== 'function' || typeof images.putObject !== 'function') {
    throw new TypeError('createLagrangeRustHostBindings requires an images service');
  }
  const boundImageId = requiredText(imageId, 'createLagrangeRustHostBindings imageId');
  const hostRegistry = registry ?? new ComponentHostImportRegistry();

  const readableMap = new Map(Object.entries(readableObjects ?? {}));
  const mutableMap = new Map(Object.entries(mutableObjects ?? {}));
  const creatableMap = new Map(Object.entries(creatableShapes ?? {}));
  const callableMap = new Map(Object.entries(callableTargets ?? {}));

  hostRegistry.register(LAGRANGE_HOST_IMAGE_READ_SPECIFIER, async ({require}) => ({
    async readSlot(alias, slotName) {
      const objectId = readableMap.get(requiredText(alias, 'readable object alias'));
      if (!objectId) {
        throw new TypeError(`undeclared readable object alias: ${alias}`);
      }
      require({
        operation: OBJECT_READ_OPERATION,
        resource: objectResource(boundImageId, objectId),
      });
      const object = await images.getObject(boundImageId, objectId);
      if (!object) {
        throw new TypeError(`readable object not found: ${boundImageId}/${objectId}`);
      }
      const slotId = await resolveSlotIdByName(images, boundImageId, object.shape, slotName);
      if (!Object.hasOwn(object.slots ?? {}, slotId)) {
        throw new TypeError(`slot ${slotName} not found on ${boundImageId}/${objectId}`);
      }
      return canonicalToHostPrimitive(object.slots[slotId]);
    },
    async readObjectVersion(alias) {
      const objectId = readableMap.get(requiredText(alias, 'readable object alias'));
      if (!objectId) {
        throw new TypeError(`undeclared readable object alias: ${alias}`);
      }
      require({
        operation: OBJECT_READ_OPERATION,
        resource: objectResource(boundImageId, objectId),
      });
      const object = await images.getObject(boundImageId, objectId);
      if (!object) {
        throw new TypeError(`readable object not found: ${boundImageId}/${objectId}`);
      }
      return objectVersionToken(boundImageId, objectId, object._version);
    },
  }));

  hostRegistry.register(LAGRANGE_HOST_IMAGE_MUTATE_SPECIFIER, async ({require}) => ({
    async writeSlot(alias, slotName, rawValue, expectedVersionToken) {
      const objectId = mutableMap.get(requiredText(alias, 'mutable object alias'));
      if (!objectId) {
        throw new TypeError(`undeclared mutable object alias: ${alias}`);
      }
      const expectedVersion = parseObjectVersionToken(expectedVersionToken, boundImageId, objectId);
      require({
        operation: OBJECT_WRITE_OPERATION,
        resource: objectResource(boundImageId, objectId),
      });
      const current = await images.getObject(boundImageId, objectId);
      if (!current) {
        throw new TypeError(`mutable object not found: ${boundImageId}/${objectId}`);
      }
      const slotId = await resolveSlotIdByName(images, boundImageId, current.shape, slotName);
      if (!Object.hasOwn(current.slots ?? {}, slotId)) {
        throw new TypeError(`slot ${slotName} not found on ${boundImageId}/${objectId}`);
      }
      const updated = await putObjectAtExpectedVersion(
        images,
        boundImageId,
        {
          id: current.id,
          shape: current.shape,
          behavior: current.behavior ?? null,
          slots: {
            ...current.slots,
            [slotId]: hostValueToCanonical(rawValue),
          },
          ...(current.indexed ? {indexed: current.indexed} : {}),
          metadata: current.metadata ?? {},
        },
        expectedVersion,
      );
      return objectVersionToken(boundImageId, objectId, updated._version);
    },
  }));

  hostRegistry.register(LAGRANGE_HOST_IMAGE_CREATE_SPECIFIER, async ({require}) => ({
    async createInstance(shapeAlias, slotEntries = {}) {
      const spec = creatableMap.get(requiredText(shapeAlias, 'creatable shape alias'));
      if (!spec || typeof spec !== 'object') {
        throw new TypeError(`undeclared creatable shape alias: ${shapeAlias}`);
      }
      const shapeId = requiredText(spec.shapeId, `creatable shape ${shapeAlias} shapeId`);
      const authTargetId = spec.classId ?? shapeId;
      require({
        operation: OBJECT_CREATE_OPERATION,
        resource: objectResource(boundImageId, authTargetId),
      });
      const shape = await images.getShape(boundImageId, shapeId);
      if (!shape) {
        throw new TypeError(`creatable shape not found: ${boundImageId}/${shapeId}`);
      }
      const slots = {};
      for (const slot of shape.slots) {
        if (Object.hasOwn(slotEntries, slot.name)) {
          slots[slot.id] = hostValueToCanonical(slotEntries[slot.name]);
        } else if (Object.hasOwn(slotEntries, slot.id)) {
          slots[slot.id] = hostValueToCanonical(slotEntries[slot.id]);
        } else if (spec.defaultSlotValue !== undefined) {
          slots[slot.id] = hostValueToCanonical(spec.defaultSlotValue);
        } else {
          throw new TypeError(`missing initial value for slot ${slot.name} (${slot.id})`);
        }
      }
      const mintedId = typeof spec.newObjectId === 'function' ? spec.newObjectId() : randomUUID();
      const created = await images.putObject(
        boundImageId,
        {
          id: mintedId,
          shape: objectRef(boundImageId, shapeId),
          behavior: spec.behaviorId ? objectRef(boundImageId, spec.behaviorId) : null,
          slots,
        },
        {expectedVersion: 0},
      );
      return Object.freeze({
        objectId: created.id,
        versionToken: objectVersionToken(boundImageId, created.id, created._version),
      });
    },
  }));

  hostRegistry.register(LAGRANGE_HOST_IMAGE_OBSERVE_SPECIFIER, async ({require}) => ({
    async observe(aliases = []) {
      if (!Array.isArray(aliases)) {
        throw new TypeError('observe aliases must be an array');
      }
      const observations = [];
      for (const alias of aliases) {
        const objectId = readableMap.get(requiredText(alias, 'observed object alias'));
        if (!objectId) {
          throw new TypeError(`undeclared readable object alias: ${alias}`);
        }
        require({
          operation: OBJECT_READ_OPERATION,
          resource: objectResource(boundImageId, objectId),
        });
        const object = await images.getObject(boundImageId, objectId);
        if (!object) {
          throw new TypeError(`observed object not found: ${boundImageId}/${objectId}`);
        }
        observations.push(Object.freeze({
          alias,
          objectId,
          versionToken: objectVersionToken(boundImageId, objectId, object._version),
        }));
      }
      return Object.freeze(observations);
    },
  }));

  hostRegistry.register(LAGRANGE_HOST_CALLABLE_DISPATCH_SPECIFIER, async ({require}) => ({
    async invokeCallable(targetAlias, rawArgs = []) {
      const target = callableMap.get(requiredText(targetAlias, 'callable target alias'));
      if (!target || typeof target !== 'object') {
        throw new TypeError(`undeclared callable target alias: ${targetAlias}`);
      }
      const blockRef = target.blockRef;
      if (!blockRef || typeof blockRef.imageId !== 'string' || typeof blockRef.objectId !== 'string') {
        throw new TypeError(`callable target ${targetAlias} requires a blockRef`);
      }
      if (typeof target.invoke !== 'function') {
        throw new TypeError(`callable target ${targetAlias} requires an invoke(args) function`);
      }
      require({
        operation: OBJECT_READ_OPERATION,
        resource: objectResource(blockRef.imageId, blockRef.objectId),
      });
      const canonicalArgs = Array.isArray(rawArgs)
        ? rawArgs.map((arg) => hostValueToCanonical(arg))
        : [];
      const result = await target.invoke(canonicalArgs);
      return canonicalToHostPrimitive(result);
    },
  }));

  return hostRegistry;
}

async function installLagrangeRustComponentWithHostSdk({
  images,
  imageId,
  component,
  exports: exportsList = [],
  hostImports = LAGRANGE_RUST_HOST_IMPORTS,
  idPrefix = 'rust-component',
} = {}) {
  if (!images || typeof images.putCodeArtifact !== 'function') {
    throw new TypeError('installLagrangeRustComponentWithHostSdk requires an images service');
  }
  const targetImageId = requiredText(imageId, 'installLagrangeRustComponentWithHostSdk imageId');
  const prefix = requiredText(idPrefix, 'installLagrangeRustComponentWithHostSdk idPrefix');
  const normalizedImports = normalizeSdkHostImports(hostImports);
  const normalizedExports = normalizeSdkExports(exportsList);
  if (normalizedExports.length === 0) {
    throw new TypeError('installLagrangeRustComponentWithHostSdk requires at least one export descriptor');
  }

  const componentRef = component?.kind === 'object-ref'
    ? component
    : objectRef(component?.imageId ?? targetImageId, requiredText(component?.id ?? component?.objectId, 'component id'));

  const installedExports = {};
  for (const exp of normalizedExports) {
    const usesComposite = Object.keys(exp.types).length > 0
      || isCompositeType(exp.result)
      || exp.parameters.some((param) => isCompositeType(param) || !CALLABLE_TYPES.includes(param));
    const interfaceArtifact = usesComposite
      ? await installCallableInterfaceV2({
        images,
        imageId: targetImageId,
        interfaceId: `${prefix}:interface:${exp.name}`,
        functionName: exp.function,
        parameters: exp.parameters,
        result: exp.result,
        types: exp.types,
      })
      : await installCallableInterface({
        images,
        imageId: targetImageId,
        interfaceId: `${prefix}:interface:${exp.name}`,
        functionName: exp.function,
        parameters: exp.parameters,
        result: exp.result,
      });

    const bound = await installWasmComponentBindingV2({
      images,
      imageId: targetImageId,
      bindingId: `${prefix}:binding:${exp.name}`,
      blockId: `${prefix}:block:${exp.name}`,
      callableInterface: objectRef(targetImageId, interfaceArtifact.id),
      component: componentRef,
      hostImports: normalizedImports,
    });
    installedExports[exp.name] = Object.freeze({
      exportName: exp.name,
      functionName: exp.function,
      interfaceArtifact,
      bindingArtifact: bound.bindingArtifact,
      block: bound.block,
      blockRef: objectRef(targetImageId, bound.block.id),
    });
  }

  return Object.freeze({
    imageId: targetImageId,
    componentRef,
    hostImports: normalizedImports,
    exports: Object.freeze(installedExports),
  });
}

export {
  LAGRANGE_HOST_CALLABLE_DISPATCH_SPECIFIER,
  LAGRANGE_HOST_IMAGE_CREATE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_MUTATE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_OBSERVE_SPECIFIER,
  LAGRANGE_HOST_IMAGE_READ_SPECIFIER,
  LAGRANGE_RUST_HOST_IMPORTS,
  LAGRANGE_RUST_SDK_V1,
  canonicalToHostPrimitive,
  createLagrangeRustHostBindings,
  generateLagrangeRustSdkCrate,
  hostValueToCanonical,
  installLagrangeRustComponentWithHostSdk,
  materializeLagrangeRustSdkArtifacts,
};
