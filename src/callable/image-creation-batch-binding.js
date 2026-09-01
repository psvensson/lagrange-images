import {uuid as randomUUID} from '../support/default-crypto.js';
import {SHAPE_INDEXED} from '../object/model.js';
import {objectRef, textValue} from '../value/index.js';
import {assertBlockApplicationReceiver} from '../execution/block-application.js';
import {objectResource} from '../authority/object-resource.js';
import {objectVersionToken} from '../object/version-token.js';
import {
  CALLABLE_INTERFACE_DEPENDENCY_ROLE,
  assertBindingDependencies,
  normalizeObjectRef,
  resolveCallableInterface,
} from './binding-artifacts.js';
import {CALLABLE_TYPES, assertImages, hostLeafToCanonical} from './interface-artifacts.js';
import {assertCallableInterfaceArguments} from './interface-v2-artifacts.js';
import {unpackCompositeValue} from './composite-codec.js';
import {resolveDeclaredType} from './type-grammar.js';
import {
  BEHAVIOR_SHAPE_ID,
  KERNEL_NIL_ID,
  OBJECT_CREATE_OPERATION,
  OBJECT_EDGE_WRITE_OPERATION,
  ObjectCreationConflictError,
  assertBehaviorRecord,
  assertFieldMappingCovers,
  assertIndexedFieldType,
  normalizeCreationFields,
  parseEdgeTarget,
} from './image-creation-binding.js';

// ADR 0067. An authorized atomic image-local creation batch: N create specs in ONE call, committed
// in ONE backend.transaction (all records + history, or none). The novel authorization rule is
// transaction-local fresh-object provenance: an edge to an EXISTING object T requires
// object/edge-write(T); an edge to a member created in THIS SAME batch is justified by that
// member's own object/create grant. Local names are request-syntax only, never ObjectRef/Value/
// authority, and never leak.
const IMAGE_CREATION_BATCH_BINDING_V1 = 'image-creation-batch-binding/v1';

// Reserved member-record fields: `class` (the member's class-id, required) and `name` (the local
// name, optional). Neither becomes a durable slot value; both are consumed by the batch lane.
const RESERVED_MEMBER_FIELDS = new Set(['class', 'name']);

// create-many(values: list<member-record>) -> string
// Each member record carries `class` (required, a class-id string), `name` (optional, the local
// name), plus the per-class data fields the binding maps. The binding's `fields` is a per-class
// map: class-id -> field list (same normalized shape as the single lane's).
//
// The member-record type is the union of all fields across all mapped classes. Each class's
// mapping covers a subset of the record fields; validate that subset, not exact bidirectional
// coverage (a Presentation member does not carry the Perspective-only `presentations` field).
function assertBatchCreationInterface(descriptor, fieldsByClass = {}) {
  const {parameters, result, types = {}} = descriptor;
  if (parameters.length !== 1) {
    throw new TypeError(
      `${IMAGE_CREATION_BATCH_BINDING_V1} requires parameters (values: list<member-record>)`,
    );
  }
  if (result !== 'string') {
    throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} must return the version tokens as string`);
  }
  const list = resolveDeclaredType(parameters[0], types);
  if (!list || list.kind !== 'list') {
    throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} values parameter must be a list type`);
  }
  const record = resolveDeclaredType(list.element, types);
  if (!record || record.kind !== 'record') {
    throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} values element must be a declared record type`);
  }
  // Validate the reserved fields.
  const classField = record.fields.find((f) => f.name === 'class');
  if (!classField || classField.type !== 'string') {
    throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} member record must declare a class field of type string`);
  }
  const nameField = record.fields.find((f) => f.name === 'name');
  if (nameField && nameField.type !== 'string') {
    throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} member record name field must be string when present`);
  }
  const recordFieldsByName = new Map(record.fields.map((f) => [f.name, f]));
  // Validate every class's mapping against the interface record.
  for (const [classId, fields] of Object.entries(fieldsByClass)) {
    const indexedFields = new Map(fields.filter((f) => f.indexed).map((f) => [f.name, f.edge]));
    for (const field of fields) {
      const recordField = recordFieldsByName.get(field.name);
      if (!recordField) {
        throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} class ${classId} maps ${field.name}, which the member record does not declare`);
      }
      if (indexedFields.has(field.name)) {
        assertIndexedFieldType(recordField, types, `${IMAGE_CREATION_BATCH_BINDING_V1} class ${classId} indexed field ${field.name}`, indexedFields.get(field.name));
        continue;
      }
      if (!CALLABLE_TYPES.includes(recordField.type)) {
        throw new TypeError(
          `${IMAGE_CREATION_BATCH_BINDING_V1} class ${classId} field ${field.name} must be a leaf type; v1 does not write nested values`,
        );
      }
    }
  }
  return record;
}

// The indexed-field type check is identical to the single lane's; it is re-exported from
// image-creation-binding.js to keep the two lanes byte-identical.

function normalizeBatchFields(fieldsByClass, label) {
  if (!fieldsByClass || typeof fieldsByClass !== 'object' || Array.isArray(fieldsByClass)) {
    throw new TypeError(`${label} fields must be an object keyed by class-id`);
  }
  const normalized = {};
  for (const [classId, fields] of Object.entries(fieldsByClass)) {
    normalized[classId] = normalizeCreationFields(fields, `${label} class ${classId}`);
  }
  return Object.freeze(normalized);
}

function parseImageCreationBatchBindingArtifact(artifact) {
  if (!artifact || artifact.kind !== 'code-artifact' || artifact.representation !== IMAGE_CREATION_BATCH_BINDING_V1) {
    throw new TypeError(`artifact must be ${IMAGE_CREATION_BATCH_BINDING_V1}`);
  }
  if (artifact.content?.kind !== 'text') throw new TypeError('image creation batch binding content must be a text Value');
  assertBindingDependencies(artifact, [CALLABLE_INTERFACE_DEPENDENCY_ROLE], IMAGE_CREATION_BATCH_BINDING_V1);
  let decoded;
  try {
    decoded = JSON.parse(artifact.content.value);
  } catch (error) {
    throw new TypeError('image creation batch binding content must be valid JSON', {cause: error});
  }
  const expected = ['abi', 'fields'];
  const actual = Object.keys(decoded).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} descriptor must contain exactly ${expected.join(', ')}`);
  }
  if (decoded.abi !== IMAGE_CREATION_BATCH_BINDING_V1) {
    throw new TypeError(`unsupported image creation batch binding ABI: ${decoded.abi}`);
  }
  return Object.freeze({fields: normalizeBatchFields(decoded.fields, IMAGE_CREATION_BATCH_BINDING_V1)});
}

async function installImageCreationBatchBinding({
  images,
  callableInterface,
  fields,
  imageId = null,
  bindingId = randomUUID(),
  blockId = randomUUID(),
  bindingMetadata = {},
  blockMetadata = {},
} = {}) {
  const imageService = assertImages(images);
  const interfaceRef = normalizeObjectRef(callableInterface, 'image creation batch binding interface');
  const interfaceArtifact = await imageService.getCodeArtifact(interfaceRef.imageId, interfaceRef.objectId);
  if (!interfaceArtifact) {
    throw new TypeError(`callable interface not found: ${interfaceRef.imageId}/${interfaceRef.objectId}`);
  }
  const targetImageId = imageId ?? interfaceRef.imageId;
  const normalizedFields = normalizeBatchFields(fields, IMAGE_CREATION_BATCH_BINDING_V1);

  const {descriptor} = await resolveCallableInterface(
    imageService,
    {dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}]},
    IMAGE_CREATION_BATCH_BINDING_V1,
  );
  assertBatchCreationInterface(descriptor, normalizedFields);

  const bindingArtifact = await imageService.putCodeArtifact(targetImageId, {
    id: bindingId,
    representation: IMAGE_CREATION_BATCH_BINDING_V1,
    content: textValue(JSON.stringify({
      abi: IMAGE_CREATION_BATCH_BINDING_V1,
      fields: Object.fromEntries(Object.entries(normalizedFields).map(([classId, fields]) => [
        classId,
        fields.map((f) => (f.indexed ? {name: f.name, indexed: true, edge: f.edge} : {name: f.name, slot: f.slot, edge: f.edge})),
      ])),
    })),
    dependencies: [{role: CALLABLE_INTERFACE_DEPENDENCY_ROLE, artifact: interfaceRef}],
    metadata: bindingMetadata,
  });
  const block = await imageService.putBlock(targetImageId, {
    id: blockId,
    code: objectRef(targetImageId, bindingArtifact.id),
    environment: null,
    metadata: blockMetadata,
  });
  return Object.freeze({bindingArtifact, block, interfaceRef});
}

// The local-name prefix for intra-batch edge references. `local:<name>` refers to the member whose
// `name` field equals <name>. This is request-syntax only; it never becomes a durable Value.
const LOCAL_PREFIX = 'local:';

function isLocalRef(text) {
  return typeof text === 'string' && text.startsWith(LOCAL_PREFIX);
}

function localNameOf(text) {
  return text.slice(LOCAL_PREFIX.length);
}

function createImageCreationBatchBindingV1Executor({newObjectId = randomUUID, maxIdentityAttempts = 8} = {}) {
  return Object.freeze({
    async execute({activation, code}, {images, require}) {
      if (!code || code.representation !== IMAGE_CREATION_BATCH_BINDING_V1) {
        throw new TypeError(`image creation batch executor requires ${IMAGE_CREATION_BATCH_BINDING_V1}`);
      }
      assertBlockApplicationReceiver(activation, IMAGE_CREATION_BATCH_BINDING_V1);
      if (activation.environment !== null) {
        throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} does not accept a lexical environment`);
      }
      const binding = parseImageCreationBatchBindingArtifact(code);
      const {descriptor} = await resolveCallableInterface(images, code, IMAGE_CREATION_BATCH_BINDING_V1);
      const record = assertBatchCreationInterface(descriptor, binding.fields);

      const args = assertCallableInterfaceArguments(descriptor, activation.arguments, descriptor.function);
      const imageId = code.imageId;

      const values = unpackCompositeValue(
        args[0], descriptor.parameters[0], descriptor.types ?? {}, `${descriptor.function} values`,
      );
      if (!Array.isArray(values) || values.length === 0) {
        throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} values must be a non-empty list`);
      }

      // Parse local names first: collect every member's `name` and reject duplicates. Names are
      // batch-global; a name collision across different classes is still a duplicate.
      const localNames = new Map();
      for (const [index, value] of values.entries()) {
        if (Object.hasOwn(value, 'name')) {
          const name = value.name;
          if (typeof name !== 'string' || name.length === 0) {
            throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} member ${index} name must be a non-empty string`);
          }
          if (localNames.has(name)) {
            throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} duplicate local name: ${name}`);
          }
          localNames.set(name, index);
        }
      }

      // Phase A: authorize ALL and build ALL records before any durable write. Each member carries
      // its own class; require(object/create) fires per member's class (ADR 0067 §2a).
      const nil = objectRef(imageId, KERNEL_NIL_ID);
      const built = [];
      for (const [index, value] of values.entries()) {
        if (!Object.hasOwn(value, 'class')) {
          throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} member ${index} must declare a class`);
        }
        const classId = value.class;
        if (typeof classId !== 'string' || classId.length === 0) {
          throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} member ${index} class must be a non-empty string`);
        }
        const classFields = binding.fields[classId];
        if (!classFields) {
          throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} member ${index} class ${classId} is not mapped by this binding`);
        }

        // Per-class require: object/create on this member's own class.
        require({operation: OBJECT_CREATE_OPERATION, resource: objectResource(imageId, classId)});

        // Then the class read, within the granted scope.
        const classRecord = await images.getObject(imageId, classId);
        if (!classRecord) throw new TypeError(`class not found: ${imageId}/${classId}`);
        const instanceShapeRef = assertBehaviorRecord(classRecord, imageId, classId);
        if (instanceShapeRef.objectId === KERNEL_NIL_ID) {
          throw new TypeError(`class ${imageId}/${classId} is not instantiable: instanceShape is nil`);
        }
        const shape = await images.getShape(instanceShapeRef.imageId, instanceShapeRef.objectId);
        if (!shape) throw new TypeError(`instance Shape not found: ${instanceShapeRef.imageId}/${instanceShapeRef.objectId}`);

        // Build the field mapping for this class directly from its normalized field list. The
        // member-record type is the union of all classes' fields; this class's mapping covers only
        // its own subset, so assertFieldMappingCovers (exact bidirectional coverage) is not the
        // right check here.
        const mapped = new Map(classFields.map((f) => [f.name, f.indexed ? {indexed: true, edge: f.edge} : {slot: f.slot, edge: f.edge}]));

        // Fail closed (ADR 0062 parity): the member-record type is the union of all classes'
        // fields, so a caller can set a field this member's class does NOT map — e.g. the
        // Perspective-only `presentations` edge field on a Presentation member. Dropping that
        // value silently would be fail-open (caller intent, possibly an edge reference, vanishing
        // without authorization or error). Reject any provided data key the class does not map,
        // before any slot is built, matching the single lane's "extra slot fails the shape match"
        // philosophy at the mapping layer.
        //
        // The composite codec requires every declared union field to be present on every member, so
        // a class-inappropriate field always arrives; the only value that carries NO caller intent
        // and NO edge reference is the empty list (the codec's zero for an indexed/list field). That
        // single case is tolerated. Everything else — a non-empty list (which could hold a ref or a
        // `local:` string) or any scalar (whose value is always caller-chosen, there being no zero
        // distinct from intent) — is rejected outright.
        for (const key of Object.keys(value)) {
          if (RESERVED_MEMBER_FIELDS.has(key)) continue;
          if (mapped.has(key)) continue;
          const supplied = value[key];
          const isCodecZeroList = Array.isArray(supplied) && supplied.length === 0;
          if (!isCodecZeroList) {
            throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} member ${index} supplies field ${key}, which class ${imageId}/${classId} does not map`);
          }
        }

        const slots = Object.fromEntries((shape.slots ?? []).map(({id}) => [id, nil]));
        const shapeSlotIds = new Set((shape.slots ?? []).map(({id}) => id));
        const isIndexed = shape.indexed === SHAPE_INDEXED.VALUES;
        let indexed = isIndexed ? [] : null;
        const localRefs = []; // {slotId, localName} or {indexedIndex, localName}

        for (const field of record.fields) {
          if (RESERVED_MEMBER_FIELDS.has(field.name)) continue;
          if (!Object.hasOwn(value, field.name)) continue;
          const mapping = mapped.get(field.name);
          // Unreachable for data keys (the fail-closed check above already rejected them); kept as
          // a defensive backstop so a future refactor cannot silently re-open the drop.
          if (!mapping) continue;
          if (mapping.indexed) {
            if (!isIndexed) {
              throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} supplies indexed field ${field.name}, but class ${imageId}/${classId} is not indexed`);
            }
            const listValue = value[field.name];
            if (!Array.isArray(listValue)) {
              throw new TypeError(`indexed field ${field.name} must be a list, got ${typeof listValue}`);
            }
            const elementType = resolveDeclaredType(field.type, descriptor.types ?? {}).element;
            indexed = listValue.map((element, elementIndex) => {
              const label = `indexed field ${field.name}[${elementIndex}]`;
              if (mapping.edge) {
                if (isLocalRef(element)) {
                  const name = localNameOf(element);
                  if (!localNames.has(name)) {
                    throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} unknown local name in ${label}: ${name}`);
                  }
                  localRefs.push({kind: 'indexed', index: elementIndex, localName: name});
                  return null; // placeholder, substituted in Phase B
                }
                const parsed = parseEdgeTarget(imageId, element, label);
                require({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, parsed.objectId)});
                return parsed;
              }
              return hostLeafToCanonical(element, elementType, label);
            });
            continue;
          }
          const {slot, edge} = mapping;
          if (!shapeSlotIds.has(slot)) {
            throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} maps field ${field.name} to slot ${slot}, which the instance Shape does not declare`);
          }
          if (edge) {
            const text = value[field.name];
            if (isLocalRef(text)) {
              const name = localNameOf(text);
              if (!localNames.has(name)) {
                throw new TypeError(`${IMAGE_CREATION_BATCH_BINDING_V1} unknown local name in edge field ${field.name}: ${name}`);
              }
              localRefs.push({kind: 'slot', slotId: slot, localName: name});
              slots[slot] = null; // placeholder, substituted in Phase B
            } else {
              const parsed = parseEdgeTarget(imageId, text, `edge field ${field.name}`);
              require({operation: OBJECT_EDGE_WRITE_OPERATION, resource: objectResource(imageId, parsed.objectId)});
              slots[slot] = parsed;
            }
          } else {
            slots[slot] = hostLeafToCanonical(value[field.name], field.type, `field ${field.name}`);
          }
        }

        built.push({index, classId, instanceShapeRef, slots, indexed, localRefs});
      }

      // Phase B: mint all N ids and substitute local-name targets with the minted ids. On
      // VersionConflictError the whole putObjects transaction aborts; retry with freshly minted
      // ids, bounded by maxIdentityAttempts.
      for (let attempt = 0; attempt < maxIdentityAttempts; attempt += 1) {
        const mintedIds = built.map(() => {
          const candidate = newObjectId();
          if (typeof candidate !== 'string' || candidate.length === 0) {
            throw new TypeError('object identity generator must answer non-empty text');
          }
          return candidate;
        });

        // Substitute local refs with minted ids and build the putObjects inputs.
        const inputs = [];
        for (const member of built) {
          const slots = {...member.slots};
          for (const ref of member.localRefs) {
            const targetIndex = localNames.get(ref.localName);
            const targetId = mintedIds[targetIndex];
            if (ref.kind === 'slot') {
              slots[ref.slotId] = objectRef(imageId, targetId);
            } else {
              member.indexed[ref.index] = objectRef(imageId, targetId);
            }
          }
          inputs.push({
            id: mintedIds[member.index],
            shape: member.instanceShapeRef,
            behavior: objectRef(imageId, member.classId),
            slots,
            ...(member.indexed === null ? {} : {indexed: member.indexed}),
            metadata: {},
          });
        }

        // Phase C: ONE backend.transaction committing all N put+append.
        try {
          const storedList = await images.putObjects(imageId, inputs, {expectedVersion: 0});
          const tokens = storedList.map((stored) => objectVersionToken(imageId, stored.id, stored._version));
          return textValue(tokens.join(','));
        } catch (error) {
          if (error?.name !== 'VersionConflictError') throw error;
          // A collision aborts the whole transaction; retry with freshly minted ids.
        }
      }
      throw new ObjectCreationConflictError(
        imageId,
        `could not find free object identities after ${maxIdentityAttempts} attempts`,
      );
    },
  });
}

export {
  IMAGE_CREATION_BATCH_BINDING_V1,
  OBJECT_CREATE_OPERATION,
  OBJECT_EDGE_WRITE_OPERATION,
  createImageCreationBatchBindingV1Executor,
  installImageCreationBatchBinding,
  parseImageCreationBatchBindingArtifact,
};
