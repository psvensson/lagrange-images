import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  AuthorityError,
  ComponentHostImportRegistry,
  WASM_COMPONENT_BINDING_V1,
  WASM_COMPONENT_BINDING_V2,
  WASM_COMPONENT_V1,
  bytesValue,
  createAuthorityService,
  createJcoComponentRuntime,
  createRuntime,
  installCallableInterface,
  installWasmComponentBinding,
  installWasmComponentBindingV2,
  objectRef,
  textValue,
} from '../src/runtime.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const HOST_READER = join(FIXTURES, 'host-values-component', 'host-values.component.wasm');
const PURE = join(FIXTURES, 'normalize-component', 'normalize.component.wasm');

const HOST_VALUES_INTERFACE = 'lagrange:proof/host-values';
const READ = 'host-value/read';

const STORE = Object.freeze({'public-message': 'hello', 'private-message': 'secret'});

// The host adapter. It receives `require` and nothing else — no authority, no context, no
// principal, no grants — and authorizes the concrete resource at the moment of the call.
function hostValuesProvider(seen) {
  return ({require, ...rest}) => {
    if (seen) Object.assign(seen, {providerArgs: ['require', ...Object.keys(rest)].sort()});
    return {
      readValue(name) {
        require({operation: READ, resource: name});
        return STORE[name] ?? '';
      },
    };
  };
}

async function seed({
  declare = [HOST_VALUES_INTERFACE],
  register = true,
  grants = null,
  version = 2,
  component = HOST_READER,
  functionName = 'read-host-value',
  seen = null,
} = {}) {
  const authority = createAuthorityService();
  const hostImports = new ComponentHostImportRegistry();
  if (register) hostImports.register(HOST_VALUES_INTERFACE, hostValuesProvider(seen));

  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority,
    componentRuntime: createJcoComponentRuntime(),
    componentHostImports: hostImports,
  });
  await runtime.images.createImage({id: 'demo'});

  const artifact = await runtime.images.putCodeArtifact('demo', {
    id: 'component', representation: WASM_COMPONENT_V1,
    content: bytesValue(await readFile(component)), languageId: 'rust',
  });
  const callableInterface = await installCallableInterface({
    images: runtime.images, imageId: 'demo', interfaceId: 'iface',
    functionName, parameters: ['string'], result: 'string',
  });
  const install = version === 1 ? installWasmComponentBinding : installWasmComponentBindingV2;
  const binding = await install({
    images: runtime.images,
    callableInterface: objectRef('demo', callableInterface.id),
    component: objectRef('demo', artifact.id),
    bindingId: 'binding', blockId: 'block',
    ...(version === 1 ? {} : {hostImports: declare}),
  });

  const context = grants === null ? null : authority.issue({principal: 'alice', grants});
  const call = async (name) => {
    const activation = await runtime.invocations.invokeBlock(objectRef('demo', 'block'), [textValue(name)]);
    return await runtime.executor.execute(activation, context === null ? {} : {authority: context});
  };
  return {runtime, authority, context, binding, call};
}

// Case 1
test('wasm-component-binding/v1 stays frozen and can never wire a host import', async () => {
  const {runtime, binding, call} = await seed({
    version: 1,
    grants: [{operation: READ, resource: 'public-message'}],
  });
  try {
    assert.equal(binding.bindingArtifact.representation, WASM_COMPONENT_BINDING_V1);
    // Broad authority does not help: v1 has no declaration, so nothing is wired.
    await assert.rejects(call('public-message'),
      /requires host import lagrange:proof\/host-values, which its binding does not declare/);
  } finally {
    await runtime.close();
  }
});

// Case 2
test('a v2 binding that declares nothing cannot satisfy an import, whatever the caller holds', async () => {
  const {runtime, call} = await seed({
    declare: [],
    grants: [{operation: READ, resource: 'public-message'}, {operation: READ, resource: 'private-message'}],
  });
  try {
    await assert.rejects(call('public-message'), {name: 'UndeclaredHostImportError'});
  } finally {
    await runtime.close();
  }
});

test('a declared import with no registered provider is unavailable, not unauthorized', async () => {
  const {runtime, call} = await seed({
    register: false,
    grants: [{operation: READ, resource: 'public-message'}],
  });
  try {
    // Distinct from both linking failure and denial: the deployment simply cannot satisfy it.
    await assert.rejects(call('public-message'), {name: 'HostImportUnavailableError'});
  } finally {
    await runtime.close();
  }
});

// Case 3 — the decision this ADR turns on.
test('a declared import is wired even with no authority; the call is what gets denied', async () => {
  const {runtime, call} = await seed({grants: null});
  try {
    // Not UndeclaredHostImportError: the interface is present, so this is an execution-time
    // authorization failure rather than a linking failure. undeclared != unauthorized.
    await assert.rejects(call('public-message'), /no authority context was supplied/);
  } finally {
    await runtime.close();
  }

  // With a context that simply lacks the grant, the failure is an AuthorityError.
  const {runtime: r2, call: call2} = await seed({
    grants: [{operation: 'host-value/write', resource: 'public-message'}],
  });
  try {
    await assert.rejects(call2('public-message'), /not authorized: host-value\/read on public-message/);
  } finally {
    await r2.close();
  }
});

// Cases 4 and 5 — ADR 0037's two deferred intersection cases, now closed.
test('authorization is per concrete resource, decided when the guest actually calls', async () => {
  const {runtime, call} = await seed({
    grants: [{operation: READ, resource: 'public-message'}],
  });
  try {
    assert.deepEqual(await call('public-message'), textValue('hello'));
    // Same interface, same operation, same activation shape — different resource.
    await assert.rejects(call('private-message'), /not authorized: host-value\/read on private-message/);
  } finally {
    await runtime.close();
  }
});

// Case 6 — the reason nothing may be precomputed.
test('revocation stays live because authorization is not snapshotted at instantiation', async () => {
  const {runtime, authority, context, call} = await seed({
    grants: [{operation: READ, resource: 'public-message'}],
  });
  try {
    assert.deepEqual(await call('public-message'), textValue('hello'));
    authority.revoke(context);
    // A precomputed `declared ∩ granted` at instantiation would still permit this.
    await assert.rejects(call('public-message'), /authority revoked/);
  } finally {
    await runtime.close();
  }
});

// Case 7
test('the durable binding declares interface names and nothing authority-shaped', async () => {
  const {runtime, binding} = await seed({grants: [{operation: READ, resource: 'public-message'}]});
  try {
    assert.equal(binding.bindingArtifact.representation, WASM_COMPONENT_BINDING_V2);
    const descriptor = JSON.parse(binding.bindingArtifact.content.value);
    assert.deepEqual(Object.keys(descriptor).sort(), ['abi', 'hostImports']);
    assert.deepEqual(descriptor.hostImports, [HOST_VALUES_INTERFACE]);

    const serialised = JSON.stringify(binding.bindingArtifact).toLowerCase();
    for (const leak of ['alice', 'principal', 'grant', 'authority', 'public-message', 'secret']) {
      assert.ok(!serialised.includes(leak), `binding leaked ${leak}`);
    }
  } finally {
    await runtime.close();
  }
});

// Case 8
test('a host import provider receives require and nothing else', async () => {
  const seen = {};
  const {runtime, call} = await seed({
    grants: [{operation: READ, resource: 'public-message'}],
    seen,
  });
  try {
    await call('public-message');
    assert.deepEqual(seen.providerArgs, ['require'],
      'a provider must receive only require, never authority, context, principal or grants');
  } finally {
    await runtime.close();
  }
});

// Case 9
test('no ambient or undeclared import reaches the guest', async () => {
  const runtime = await createRuntime({
    backend: {mode: 'mock'},
    authority: createAuthorityService(),
    componentRuntime: createJcoComponentRuntime(),
  });
  try {
    await runtime.images.createImage({id: 'demo'});
    const artifact = await runtime.images.putCodeArtifact('demo', {
      id: 'component', representation: WASM_COMPONENT_V1,
      content: bytesValue(await readFile(HOST_READER)), languageId: 'rust',
    });
    // The Component's own requirements are the only thing that gets wired, and only when
    // declared. WASI is absent because it was never declared, not because it was filtered.
    const required = await runtime.codeExecutors.get(WASM_COMPONENT_BINDING_V2)
      .componentRuntime.requiredImports(artifact);
    assert.deepEqual([...required], [HOST_VALUES_INTERFACE]);
    assert.ok(!required.some((specifier) => specifier.startsWith('wasi:')));
  } finally {
    await runtime.close();
  }
});

// Case 10
test('pure Components are unaffected: no imports, no authority, still work', async () => {
  const {runtime, call} = await seed({
    component: PURE, functionName: 'normalize', declare: [], grants: null,
  });
  try {
    // No authority context at all, and a v2 binding declaring nothing: a Component that
    // imports nothing is still perfectly executable.
    assert.deepEqual(await call('  Hello   World  '), textValue('hello world'));
  } finally {
    await runtime.close();
  }
});

test('authority errors from a host import surface as AuthorityError, not as a trap', async () => {
  const authority = createAuthorityService();
  const context = authority.issue({principal: 'alice', grants: []});
  assert.throws(() => authority.require(context, {operation: READ, resource: 'public-message'}), AuthorityError);
});
