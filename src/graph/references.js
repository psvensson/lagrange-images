import {referencesOfValue} from '../value/index.js';
import {assertObjectRecord, assertShapeRecord} from '../object/model.js';
import {assertBlockRecord, assertCodeArtifactRecord, assertLexicalEnvironmentRecord} from '../execution/model.js';

function referencesOfRecord(record) {
  if (record?.kind === 'shape') {
    assertShapeRecord(record);
    return [];
  }
  if (record?.kind === 'object') {
    assertObjectRecord(record);
    const refs = [record.shape];
    if (record.behavior) refs.push(record.behavior);
    for (const value of Object.values(record.slots)) refs.push(...referencesOfValue(value));
    // ADR 0047: an indexed Value is just as much graph as a named-slot Value. Omitting this walk
    // would make a ref durable and readable while invisible to every graph operation built here.
    for (const value of record.indexed ?? []) refs.push(...referencesOfValue(value));
    return refs;
  }
  if (record?.kind === 'code-artifact') {
    assertCodeArtifactRecord(record);
    return [
      ...referencesOfValue(record.content),
      ...(record.dependencies ?? []).map(({artifact}) => artifact),
      ...record.derivedFrom,
    ];
  }
  if (record?.kind === 'lexical-environment') {
    assertLexicalEnvironmentRecord(record);
    const refs = record.parent ? [record.parent] : [];
    for (const binding of Object.values(record.bindings)) refs.push(...referencesOfValue(binding.value));
    return refs;
  }
  if (record?.kind === 'block') {
    assertBlockRecord(record);
    return record.environment ? [record.code, record.environment] : [record.code];
  }
  throw new TypeError(`unknown record kind: ${record?.kind ?? 'missing'}`);
}

export {referencesOfRecord};
