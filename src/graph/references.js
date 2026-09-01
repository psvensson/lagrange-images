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
    // Canonical edge order: slot edges are enumerated by stable slot id (code-unit order), never
    // by insertion order, so two semantically identical records built with opposite insertion
    // order yield the same edge sequence. Fixed structural edges (shape, behavior) keep their
    // semantic order first; the indexed part (an ordinary ordered array) retains its own order.
    for (const slotId of Object.keys(record.slots).sort()) refs.push(...referencesOfValue(record.slots[slotId]));
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
    // Canonical edge order: binding edges are enumerated by stable binding id (code-unit order),
    // never by insertion order. `parent` (a fixed structural edge) keeps its semantic position
    // first. Note a binding may be {value} | {unbound} | {cell}; only `value` carries a ref.
    for (const bindingId of Object.keys(record.bindings).sort()) {
      refs.push(...referencesOfValue(record.bindings[bindingId].value));
    }
    return refs;
  }
  if (record?.kind === 'block') {
    assertBlockRecord(record);
    return record.environment ? [record.code, record.environment] : [record.code];
  }
  throw new TypeError(`unknown record kind: ${record?.kind ?? 'missing'}`);
}

export {referencesOfRecord};
