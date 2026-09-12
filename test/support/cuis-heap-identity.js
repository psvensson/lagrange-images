// Proof-only detection of raw Spur identity forms. A native UUID's decimal-only segments
// are not bare oop identities. Check explicit address markers before masking UUID tokens,
// so an @-prefixed value or an address elsewhere in the same text cannot hide behind one.
export function findSpurHeapIdentity(text) {
  const explicit = text.match(/@[0-9a-f]{6,}|\b0x[0-9a-f]+\b/i);
  if (explicit) return explicit[0];
  const withoutNativeUuids = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    '<native-uuid>',
  );
  return withoutNativeUuids.match(/\/\d{7,}\b|\b\d{9,}\b/)?.[0] ?? null;
}
