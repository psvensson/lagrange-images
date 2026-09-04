import {createHash} from 'node:crypto';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {LineProcessRunner} from './line-process-runner.js';
import {
  StdioValueBridgeCallError,
  awaitBridgeReady,
  bridgeCall,
  bridgeQuit,
  createBridgeHandle,
  decodeBridgeValue,
  encodeBridgeValue,
  forceStopSession,
} from './stdio-value-bridge.js';

const OPENSMALLTALK_CUIS_PROVIDER_ID = 'smalltalk/opensmalltalk-cuis';
const OPENSMALLTALK_CUIS_PROVIDER_V0 = 'opensmalltalk-cuis-runtime/v0';
const CUIS_STDIO_BRIDGE_V0 = 'lagrange-cuis-stdio/v0';
const CUIS_STDIO_BRIDGE_V1 = 'lagrange-cuis-stdio/v1';
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9._-]*$/;
const SAFE_PACKAGE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.pck\.st$/;

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
  return value;
}

function providerIdentity(vmIdentity, imageIdentity) {
  const digest = createHash('sha256')
    .update(JSON.stringify({vmIdentity, imageIdentity}))
    .digest('hex');
  return `${OPENSMALLTALK_CUIS_PROVIDER_V0}/${digest}`;
}

function normalizePackageSpec(value, index) {
  exactKeys(value, ['identity', 'path'], `OpenSmalltalk Cuis package ${index}`);
  const path = resolve(requiredText(value.path, `OpenSmalltalk Cuis package ${index} path`));
  const fileName = basename(path);
  if (!SAFE_PACKAGE_FILE.test(fileName) || fileName.includes('..')) {
    throw new TypeError(`OpenSmalltalk Cuis package ${index} filename must be a safe .pck.st basename`);
  }
  return Object.freeze({
    identity: requiredText(value.identity, `OpenSmalltalk Cuis package ${index} identity`),
    path,
    fileName,
  });
}

function normalizeStartSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new TypeError('OpenSmalltalk Cuis runtime spec must be an object');
  }
  const keys = Object.keys(spec);
  if (keys.some((key) => key !== 'packages')) {
    throw new TypeError('OpenSmalltalk Cuis runtime spec supports only packages');
  }
  const packages = spec.packages ?? [];
  if (!Array.isArray(packages)) throw new TypeError('OpenSmalltalk Cuis packages must be an array');
  const normalized = packages.map((entry, index) => normalizePackageSpec(entry, index));
  const identities = new Set();
  const fileNames = new Set();
  for (const entry of normalized) {
    if (identities.has(entry.identity)) throw new TypeError(`duplicate OpenSmalltalk Cuis package identity: ${entry.identity}`);
    if (fileNames.has(entry.fileName)) throw new TypeError(`duplicate OpenSmalltalk Cuis package filename: ${entry.fileName}`);
    identities.add(entry.identity);
    fileNames.add(entry.fileName);
  }
  return Object.freeze({packages: Object.freeze(normalized)});
}

function normalizeInterface(value) {
  exactKeys(value, ['operation', 'service'], 'OpenSmalltalk Cuis interface');
  const service = requiredText(value.service, 'OpenSmalltalk Cuis interface service');
  const operation = requiredText(value.operation, 'OpenSmalltalk Cuis interface operation');
  if (!SAFE_NAME.test(service)) throw new TypeError('OpenSmalltalk Cuis interface service contains unsafe characters');
  if (!SAFE_NAME.test(operation)) throw new TypeError('OpenSmalltalk Cuis interface operation contains unsafe characters');
  const exported = (service === 'proof' && ['add', 'echo', 'factorial'].includes(operation))
    || (service === 'json' && operation === 'package-proof')
    || (service === 'cluster' && operation === 'package-proof')
    || (service === 'text' && operation === 'normalize')
    || (service === 'bytes' && operation === 'reverse')
    || (service === 'float' && operation === 'scale')
    || (service === 'text' && operation === 'normalize-all')
    || (service === 'item' && ['relabel', 'relabel-all', 'make'].includes(operation));
  if (!exported) throw new TypeError(`OpenSmalltalk Cuis interface not exported: ${service}/${operation}`);
  return Object.freeze({service, operation});
}

function expectedArity(service, operation) {
  if (service === 'proof' && operation === 'add') return 2;
  if (service === 'proof' && operation === 'echo') return 1;
  if (service === 'proof' && operation === 'factorial') return 1;
  if (service === 'json' && operation === 'package-proof') return 0;
  if (service === 'cluster' && operation === 'package-proof') return 0;
  if (service === 'text' && operation === 'normalize') return 1;
  if (service === 'bytes' && operation === 'reverse') return 1;
  if (service === 'float' && operation === 'scale') return 2;
  if (service === 'text' && operation === 'normalize-all') return 1;
  if (service === 'item' && operation === 'relabel') return 1;
  if (service === 'item' && operation === 'relabel-all') return 1;
  if (service === 'item' && operation === 'make') return 2;
  throw new TypeError(`OpenSmalltalk Cuis interface not exported: ${service}/${operation}`);
}

// Every bridge method is compiled separately so that one bad method cannot silence the
// whole bridge: Cuis compiles a doIt as a single unit, so a syntax error anywhere in a
// large script suppresses all output, including the BOOT lines used to diagnose it.
const BRIDGE_METHODS = Object.freeze([
`add: a to: b
    ^ a + b`,
// echo exists so every canonical scalar can be round-tripped through the real VM:
// it is the only exported operation that both decodes and re-encodes an arbitrary Value.
`echo: aValue
    ^ aValue`,
`factorial: n
    n < 0 ifTrue: [ ^ self error: 'factorial requires a non-negative integer' ].
    n = 0 ifTrue: [ ^ 1 ].
    ^ n * (self factorial: n - 1)`,
`jsonPackageProof
    | jsonClass parsed rendered reparsed numbers nested |
    jsonClass := Smalltalk at: #Json.
    parsed := jsonClass readFrom: '{"numbers":[3,5,8],"ok":true,"nested":{"name":"cuis"}}' readStream.
    rendered := jsonClass render: parsed.
    reparsed := jsonClass readFrom: rendered readStream.
    numbers := reparsed at: 'numbers'.
    nested := reparsed at: 'nested'.
    ^ (((numbers at: 1) + (numbers at: 2) + (numbers at: 3)) = 16)
        and: [ (reparsed at: 'ok') = true
        and: [ (nested at: 'name') = 'cuis' ]]`,
// cluster/package-proof (Bead lagrange-images-d57): exercise REAL behavior from the
// multi-package cluster, not merely class presence. Compression is pure-Smalltalk and
// headless-safe: round-trip a ByteArray through gzip. The compress idiom is the package's
// own (GZipWriteStream on: aStream, nextPutAll:, close — cf. compressFile); decompress is
// ByteArray>>unzipped (GZipReadStream on: upToEnd). We require the decompress to equal the
// original AND the compressed form to differ (a vacuous pass-through fails the second
// clause). WeakDictionaries (the diamond of the dependency DAG) is exercised via
// WeakValueDictionary (key held strong, value weak) with the value also held in a local so
// it cannot be GC'd mid-method. If the cluster were not genuinely installed, Smalltalk at:
// would raise and the call would fail — so a passing result proves presence AND function.
`clusterPackageProof
    | source sink compressor compressed decompressed weakDict heldValue |
    source := 'lagrange-cuis-cluster-proof' asByteArray.
    sink := ByteArray writeStream.
    compressor := (Smalltalk at: #GZipWriteStream) on: sink.
    compressor nextPutAll: source.
    compressor close.
    compressed := sink contents.
    decompressed := compressed unzipped.
    heldValue := 'cluster-present' asByteArray.
    weakDict := (Smalltalk at: #WeakValueDictionary) new.
    weakDict at: 'marker' put: heldValue.
    ^ (decompressed asString = 'lagrange-cuis-cluster-proof')
        and: [ compressed ~= source
        and: [ (weakDict at: 'marker') == heldValue ]]`,
// normalize/v1: lowercase, collapse each whitespace run to one space, trim both ends.
// This is the shared specification the Component lane implements too.
`normalizeText: aString
    | outStream pendingSpace startedText |
    outStream := WriteStream on: (UnicodeString new: aString size).
    pendingSpace := false.
    startedText := false.
    aString asLowercase do: [ :eachChar |
        (self lagrangeIsWhitespace: eachChar)
            ifTrue: [ startedText ifTrue: [ pendingSpace := true ] ]
            ifFalse: [
                pendingSpace ifTrue: [ outStream nextPut: Character space ].
                pendingSpace := false.
                startedText := true.
                outStream nextPut: eachChar ] ].
    ^ outStream contents`,
// Mirrors the Component lane's `reverse`: it cannot succeed unless every byte value and
// its position survived the bridge encoding.
`reverseBytes: aByteArray
    ^ aByteArray reversed`,
// Mirrors the Component lane's `scale`. IEEE 754 double multiply is exactly specified, so
// the two lanes must agree bit for bit or the boundary lost precision.
`scaleFloat: aFloat by: aFactor
    ^ aFloat * aFactor`,
// Composite payload support. The host strips the interface-composite/v0 envelope header
// before the call and stamps it afterwards, so the image never sees a fingerprint and never
// needs SHA-256. The bridge learns no general nested grammar either: each operation knows
// its own signature, so these helpers decode exactly the shapes those signatures name.
`lagrangeU32At: anIndex in: aByteArray
    ^ (((aByteArray at: anIndex) bitShift: 24)
        + ((aByteArray at: anIndex + 1) bitShift: 16)
        + ((aByteArray at: anIndex + 2) bitShift: 8)
        + (aByteArray at: anIndex + 3))`,
`lagrangeWriteU32: anInteger on: aStream
    aStream nextPut: ((anInteger bitShift: -24) bitAnd: 255).
    aStream nextPut: ((anInteger bitShift: -16) bitAnd: 255).
    aStream nextPut: ((anInteger bitShift: -8) bitAnd: 255).
    aStream nextPut: (anInteger bitAnd: 255)`,
`lagrangeS64At: anIndex in: aByteArray
    | unsigned |
    unsigned := 0.
    0 to: 7 do: [ :offset | unsigned := (unsigned bitShift: 8) + (aByteArray at: anIndex + offset) ].
    ^ unsigned >= 9223372036854775808
        ifTrue: [ unsigned - 18446744073709551616 ]
        ifFalse: [ unsigned ]`,
`lagrangeWriteS64: anInteger on: aStream
    | unsigned |
    unsigned := anInteger < 0
        ifTrue: [ anInteger + 18446744073709551616 ]
        ifFalse: [ anInteger ].
    7 to: 0 by: -1 do: [ :index |
        aStream nextPut: ((unsigned bitShift: (index * -8)) bitAnd: 255) ]`,
`lagrangeDecodeStringList: anEnvelope
    | position count items length |
    position := 1.
    count := self lagrangeU32At: position in: anEnvelope.
    position := position + 4.
    items := OrderedCollection new.
    count timesRepeat: [
        length := self lagrangeU32At: position in: anEnvelope.
        position := position + 4.
        (position + length - 1) > anEnvelope size ifTrue: [ ^ self error: 'composite envelope ended early' ].
        items add: (UnicodeString fromUtf8Bytes: (anEnvelope copyFrom: position to: position + length - 1)).
        position := position + length ].
    (position = (anEnvelope size + 1)) ifFalse: [ ^ self error: 'composite envelope has trailing bytes' ].
    ^ items asArray`,
`lagrangeEncodeStringList: anArray
    | stream |
    stream := WriteStream on: (ByteArray new: 64).
    self lagrangeWriteU32: anArray size on: stream.
    anArray do: [ :eachString |
        | bytes |
        bytes := eachString asUtf8Bytes.
        self lagrangeWriteU32: bytes size on: stream.
        bytes do: [ :eachByte | stream nextPut: eachByte ] ].
    ^ stream contents`,
`normalizeAllTexts: aPayload
    ^ self lagrangeEncodeStringList: ((self lagrangeDecodeStringList: aPayload)
        collect: [ :eachString | self normalizeText: eachString ])`,
// record item { name: string, quantity: s64, enabled: bool }
// A record payload is positional in declared field order, which is what schema-directed
// means: there are no names on the wire. The Array here is this proof service's own
// representation; a real personality would choose its own.
`lagrangeDecodeItemFrom: aPayload at: aPosition
    | position length name quantity enabled |
    position := aPosition.
    length := self lagrangeU32At: position in: aPayload.
    position := position + 4.
    (position + length - 1) > aPayload size ifTrue: [ ^ self error: 'item payload ended early' ].
    name := UnicodeString fromUtf8Bytes: (aPayload copyFrom: position to: position + length - 1).
    position := position + length.
    quantity := self lagrangeS64At: position in: aPayload.
    position := position + 8.
    enabled := (aPayload at: position) = 1.
    ^ Array with: (Array with: name with: quantity with: enabled) with: position + 1`,
`lagrangeDecodeItem: aPayload
    | decoded |
    decoded := self lagrangeDecodeItemFrom: aPayload at: 1.
    (decoded at: 2) = (aPayload size + 1) ifFalse: [ ^ self error: 'item payload has trailing bytes' ].
    ^ decoded at: 1`,
`lagrangeDecodeItemList: aPayload
    | position count items decoded |
    position := 1.
    count := self lagrangeU32At: position in: aPayload.
    position := position + 4.
    items := OrderedCollection new.
    count timesRepeat: [
        decoded := self lagrangeDecodeItemFrom: aPayload at: position.
        items add: (decoded at: 1).
        position := decoded at: 2 ].
    position = (aPayload size + 1) ifFalse: [ ^ self error: 'item list payload has trailing bytes' ].
    ^ items asArray`,
`lagrangeEncodeItemOn: aStream item: anArray
    | bytes |
    bytes := (anArray at: 1) asUtf8Bytes.
    self lagrangeWriteU32: bytes size on: aStream.
    bytes do: [ :eachByte | aStream nextPut: eachByte ].
    self lagrangeWriteS64: (anArray at: 2) on: aStream.
    aStream nextPut: ((anArray at: 3) ifTrue: [ 1 ] ifFalse: [ 0 ])`,
`lagrangeEncodeItem: anArray
    | stream |
    stream := WriteStream on: (ByteArray new: 32).
    self lagrangeEncodeItemOn: stream item: anArray.
    ^ stream contents`,
`lagrangeEncodeItemList: anArray
    | stream |
    stream := WriteStream on: (ByteArray new: 64).
    self lagrangeWriteU32: anArray size on: stream.
    anArray do: [ :eachItem | self lagrangeEncodeItemOn: stream item: eachItem ].
    ^ stream contents`,
`lagrangeRelabelItem: anArray
    ^ Array
        with: (self normalizeText: (anArray at: 1))
        with: (anArray at: 2)
        with: (anArray at: 3) not`,
`relabelItem: aPayload
    ^ self lagrangeEncodeItem: (self lagrangeRelabelItem: (self lagrangeDecodeItem: aPayload))`,
`relabelAllItems: aPayload
    ^ self lagrangeEncodeItemList: ((self lagrangeDecodeItemList: aPayload)
        collect: [ :eachItem | self lagrangeRelabelItem: eachItem ])`,
`makeItem: aName quantity: aQuantity
    ^ self lagrangeEncodeItem: (Array
        with: (self normalizeText: aName)
        with: aQuantity
        with: aQuantity > 0)`,
`lagrangeIsWhitespace: aChar
    | code |
    code := aChar codePoint.
    ^ code = 32 or: [ code >= 9 and: [ code <= 13 ] ]`,
`lagrangeHexToInteger: hexText
    | total |
    total := 0.
    hexText asUppercase do: [ :eachChar |
        | digit |
        digit := eachChar digitValue.
        (digit < 0 or: [ digit > 15 ]) ifTrue: [ ^ self error: 'invalid hex payload' ].
        total := total * 16 + digit ].
    ^ total`,
`lagrangeIntegerToHex: anInteger digits: digitCount
    | alphabet outStream remaining slots |
    alphabet := '0123456789abcdef'.
    slots := Array new: digitCount.
    remaining := anInteger.
    digitCount to: 1 by: -1 do: [ :index |
        slots at: index put: (alphabet at: (remaining bitAnd: 15) + 1).
        remaining := remaining bitShift: -4 ].
    outStream := WriteStream on: (String new: digitCount).
    slots do: [ :eachChar | outStream nextPut: eachChar ].
    ^ outStream contents`,
`lagrangeIsUnreservedByte: aByte
    (aByte >= 48 and: [ aByte <= 57 ]) ifTrue: [ ^ true ].
    (aByte >= 65 and: [ aByte <= 90 ]) ifTrue: [ ^ true ].
    (aByte >= 97 and: [ aByte <= 122 ]) ifTrue: [ ^ true ].
    ^ aByte = 45 or: [ aByte = 46 or: [ aByte = 95 or: [ aByte = 126 ] ] ]`,
`lagrangePercentEncode: aString
    | outStream |
    outStream := WriteStream on: (String new: 64).
    aString asUtf8Bytes do: [ :eachByte |
        (self lagrangeIsUnreservedByte: eachByte)
            ifTrue: [ outStream nextPut: (Character value: eachByte) ]
            ifFalse: [
                outStream nextPut: (Character value: 37).
                outStream nextPutAll: (self lagrangeIntegerToHex: eachByte digits: 2) asUppercase ] ].
    ^ outStream contents`,
// Text is built as a UnicodeString, not a String: Cuis String holds only code points
// 0-255 and `String fromUtf8Bytes:` silently drops anything above that.
`lagrangePercentDecode: encodedText
    | byteStream position eachChar |
    byteStream := WriteStream on: (ByteArray new: 64).
    position := 1.
    [ position <= encodedText size ] whileTrue: [
        eachChar := encodedText at: position.
        eachChar codePoint = 37
            ifTrue: [
                byteStream nextPut: (self lagrangeHexToInteger: (encodedText copyFrom: position + 1 to: position + 2)).
                position := position + 3 ]
            ifFalse: [
                byteStream nextPut: eachChar codePoint.
                position := position + 1 ] ].
    ^ UnicodeString fromUtf8Bytes: byteStream contents`,
`lagrangeDecode: token
    | prefix payload |
    token size < 2 ifTrue: [ ^ self error: 'unsupported bridge value' ].
    prefix := token copyFrom: 1 to: 2.
    payload := token copyFrom: 3 to: token size.
    prefix = 'i:' ifTrue: [ ^ payload asNumber ].
    prefix = 'b:' ifTrue: [ ^ payload = '1' ].
    prefix = 'f:' ifTrue: [ ^ Float fromIEEE64Bit: (self lagrangeHexToInteger: payload) ].
    prefix = 'e:' ifTrue: [ ^ self lagrangePercentDecode: payload ].
    prefix = 'd:' ifTrue: [ ^ payload base64Decoded ].
    ^ self error: 'unsupported bridge value'`,
// Cuis `ByteArray>>base64Encoded` wraps its output with a newline every 72 characters,
// which silently truncates any payload over 54 bytes on a line-framed protocol. The
// newlines are stripped here so the encoding stays canonical, unwrapped base64.
`lagrangeEncode: aValue
    aValue isInteger ifTrue: [ ^ 'i:', aValue printString ].
    aValue == true ifTrue: [ ^ 'b:1' ].
    aValue == false ifTrue: [ ^ 'b:0' ].
    aValue isFloat ifTrue: [ ^ 'f:', (self lagrangeIntegerToHex: aValue asIEEE64BitWord digits: 16) ].
    aValue isString ifTrue: [ ^ 'e:', (self lagrangePercentEncode: aValue) ].
    (aValue isKindOf: ByteArray) ifTrue: [
        ^ 'd:', ((aValue base64Encoded copyWithout: Character lf) copyWithout: Character cr) ].
    ^ self error: 'unsupported result value'`,
`lagrangeDispatch: fields
    | serviceName operation |
    (fields size >= 4 and: [ (fields at: 1) = 'CALL' ]) ifFalse: [ ^ self error: 'bad request' ].
    serviceName := fields at: 3.
    operation := fields at: 4.
    (serviceName = 'proof' and: [ operation = 'add' ]) ifTrue: [
        fields size = 6 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self add: (self lagrangeDecode: (fields at: 5)) to: (self lagrangeDecode: (fields at: 6)) ].
    (serviceName = 'proof' and: [ operation = 'echo' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self echo: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'proof' and: [ operation = 'factorial' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self factorial: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'json' and: [ operation = 'package-proof' ]) ifTrue: [
        fields size = 4 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self jsonPackageProof ].
    (serviceName = 'cluster' and: [ operation = 'package-proof' ]) ifTrue: [
        fields size = 4 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self clusterPackageProof ].
    (serviceName = 'text' and: [ operation = 'normalize' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self normalizeText: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'text' and: [ operation = 'normalize-all' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self normalizeAllTexts: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'item' and: [ operation = 'relabel' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self relabelItem: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'item' and: [ operation = 'relabel-all' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self relabelAllItems: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'item' and: [ operation = 'make' ]) ifTrue: [
        fields size = 6 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self makeItem: (self lagrangeDecode: (fields at: 5))
            quantity: (self lagrangeDecode: (fields at: 6)) ].
    (serviceName = 'bytes' and: [ operation = 'reverse' ]) ifTrue: [
        fields size = 5 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self reverseBytes: (self lagrangeDecode: (fields at: 5)) ].
    (serviceName = 'float' and: [ operation = 'scale' ]) ifTrue: [
        fields size = 6 ifFalse: [ ^ self error: 'bad arity' ].
        ^ self scaleFloat: (self lagrangeDecode: (fields at: 5)) by: (self lagrangeDecode: (fields at: 6)) ].
    ^ self error: 'unknown operation'`,
]);

function smalltalkStringLiteral(source) {
  return `'${source.replace(/'/g, "''")}'`;
}

function bridgeSelector(methodSource) {
  const header = methodSource.split('\n', 1)[0].trim();
  const tokens = header.split(/\s+/);
  if (!tokens[0].endsWith(':')) return tokens[0];
  return tokens.filter((_, index) => index % 2 === 0).join('');
}

function packageInstallSource(packages) {
  return packages
    .map(({fileName}) => `output nextPutAll: 'BOOT\tPACKAGE\t${fileName}\tSTART'; newLine; flush.\nCodePackageFile installPackage: DirectoryEntry currentDirectory // '${fileName}'.\noutput nextPutAll: 'BOOT\tPACKAGE\t${fileName}\tDONE'; newLine; flush.`)
    .join('\n');
}

function bridgeSource(packages = []) {
  const installPackages = packageInstallSource(packages);
  const compileCalls = BRIDGE_METHODS
    .map((methodSource) => `compileMethod value: ${smalltalkStringLiteral(methodSource)}.`)
    .join('\n');
  const selectorList = BRIDGE_METHODS.map((methodSource) => bridgeSelector(methodSource)).join(' ');
  return `| input output service done line fields requestId callResult readLine compileMethod missing |
output := StdIOWriteStream stdout.
output nextPutAll: 'BOOT\tBRIDGE\tSTART'; newLine; flush.
output nextPutAll: 'BOOT\tBRIDGE\tCOMPILE'; newLine; flush.
Object subclass: #LagrangeProofService
    instanceVariableNames: ''
    classVariableNames: ''
    poolDictionaries: ''
    category: 'Lagrange-Bridge'.
compileMethod := [ :methodSource |
    [ LagrangeProofService compile: methodSource ] on: Error do: [ :compileError | nil ] ].
${compileCalls}
missing := #(${selectorList}) reject: [ :selector | LagrangeProofService includesSelector: selector ].
missing isEmpty
    ifTrue: [ output nextPutAll: 'BOOT\tBRIDGE\tCOMPILED'; newLine; flush ]
    ifFalse: [
        output nextPutAll: 'BOOT\tBRIDGE\tUNCOMPILED\t'; nextPutAll: missing printString; newLine; flush ].
service := LagrangeProofService new.
${installPackages}
input := StdIOReadStream stdin.
readLine := [ | char stream |
    stream := WriteStream on: (String new: 64).
    [
        char := input next.
        char = Character lf
    ] whileFalse: [ stream nextPut: char ].
    stream contents ].
output
    nextPutAll: 'READY';
    nextPut: Character tab;
    nextPutAll: '${CUIS_STDIO_BRIDGE_V1}';
    newLine;
    flush.
done := false.
[ done ] whileFalse: [
    line := readLine value.
    line notEmpty ifTrue: [
        fields := line findTokens: Character tab asString.
        fields notEmpty ifTrue: [
            (fields at: 1) = 'QUIT'
                ifTrue: [
                    output nextPutAll: 'BYE'; newLine; flush.
                    done := true ]
                ifFalse: [
                    requestId := fields size > 1 ifTrue: [ fields at: 2 ] ifFalse: [ 'unknown' ].
                    [
                        callResult := service lagrangeDispatch: fields.
                        output
                            nextPutAll: 'OK';
                            nextPut: Character tab;
                            nextPutAll: requestId;
                            nextPut: Character tab;
                            nextPutAll: (service lagrangeEncode: callResult);
                            newLine;
                            flush
                    ] on: Error do: [ :callError |
                        output
                            nextPutAll: 'ERR';
                            nextPut: Character tab;
                            nextPutAll: requestId;
                            nextPut: Character tab;
                            nextPutAll: 'bridge-error';
                            newLine;
                            flush ] ] ] ] ].
Smalltalk quitPrimitive: 0.
`;
}

// The Cuis call error keeps its name and `code` for existing consumers; the transport itself is
// the neutral stdio value bridge (stdio-value-bridge.js).
class OpenSmalltalkCuisCallError extends StdioValueBridgeCallError {
  constructor(code) {
    super('OpenSmalltalk Cuis', code);
    this.name = 'OpenSmalltalkCuisCallError';
  }
}

const RUNTIME_LABEL = 'OpenSmalltalk Cuis';

function createOpenSmalltalkCuisProvider({
  vmPath,
  imagePath,
  vmIdentity,
  imageIdentity,
  runner = new LineProcessRunner(),
  workspaceRoot = tmpdir(),
  startupTimeoutMs = 15_000,
  callTimeoutMs = 10_000,
  stopTimeoutMs = 5_000,
} = {}) {
  const executable = resolve(requiredText(vmPath, 'OpenSmalltalk VM path'));
  const image = resolve(requiredText(imagePath, 'Cuis image path'));
  const stableVmIdentity = requiredText(vmIdentity, 'OpenSmalltalk VM identity');
  const stableImageIdentity = requiredText(imageIdentity, 'Cuis image identity');
  if (!runner || typeof runner.start !== 'function') throw new TypeError('OpenSmalltalk runner must implement start(request)');
  const root = resolve(requiredText(workspaceRoot, 'OpenSmalltalk workspaceRoot'));
  positiveInteger(startupTimeoutMs, 'OpenSmalltalk startupTimeoutMs');
  positiveInteger(callTimeoutMs, 'OpenSmalltalk callTimeoutMs');
  positiveInteger(stopTimeoutMs, 'OpenSmalltalk stopTimeoutMs');
  const identity = providerIdentity(stableVmIdentity, stableImageIdentity);

  return Object.freeze({
    identity,
    vmIdentity: stableVmIdentity,
    imageIdentity: stableImageIdentity,
    async start(request) {
      const spec = normalizeStartSpec(request.spec);
      await mkdir(root, {recursive: true});
      const workspace = await mkdtemp(join(root, 'lagrange-cuis-runtime-'));
      const scriptPath = join(workspace, 'lagrange-bridge.st');
      let session = null;
      try {
        for (const packageSpec of spec.packages) {
          await copyFile(packageSpec.path, join(workspace, packageSpec.fileName));
        }
        await writeFile(scriptPath, bridgeSource(spec.packages), 'utf8');
        session = await runner.start({
          command: executable,
          args: ['-vm-sound-null', '-vm-display-null', image, '-s', scriptPath],
          cwd: workspace,
          environment: {},
        });
        await awaitBridgeReady(session, CUIS_STDIO_BRIDGE_V1, {timeoutMs: startupTimeoutMs, runtimeLabel: RUNTIME_LABEL});
        return Object.freeze({
          handle: createBridgeHandle(session, {workspace}),
          metadata: Object.freeze({
            runtime: 'OpenSmalltalkVM',
            image: 'Cuis',
            bridgeProtocol: CUIS_STDIO_BRIDGE_V1,
            vmIdentity: stableVmIdentity,
            imageIdentity: stableImageIdentity,
            packages: spec.packages.map(({identity: packageIdentity, fileName}) => Object.freeze({
              identity: packageIdentity,
              fileName,
            })),
          }),
        });
      } catch (error) {
        const stderrText = session ? session.stderrText() : '';
        if (session) await forceStopSession(session, stopTimeoutMs);
        await rm(workspace, {recursive: true, force: true});
        const detail = stderrText.trim().length > 0 ? `; stderr: ${stderrText.trim().slice(0, 500)}` : '';
        throw new TypeError(`${error.message}${detail}`, {cause: error});
      }
    },
    async call(handle, request) {
      const callable = normalizeInterface(request.interface);
      const arity = expectedArity(callable.service, callable.operation);
      if (request.arguments.length !== arity) {
        throw new TypeError(`OpenSmalltalk Cuis ${callable.service}/${callable.operation} expects ${arity} arguments`);
      }
      try {
        return await bridgeCall(handle, {
          service: callable.service, operation: callable.operation, arguments: request.arguments,
          timeoutMs: callTimeoutMs, runtimeLabel: RUNTIME_LABEL,
        });
      } catch (error) {
        if (error instanceof StdioValueBridgeCallError && !(error instanceof OpenSmalltalkCuisCallError)) {
          throw new OpenSmalltalkCuisCallError(error.code);
        }
        throw error;
      }
    },
    async stop(handle) {
      await bridgeQuit(handle, {timeoutMs: stopTimeoutMs, runtimeLabel: `${RUNTIME_LABEL} VM`});
      await rm(handle.workspace, {recursive: true, force: true});
    },
  });
}

export {
  CUIS_STDIO_BRIDGE_V0,
  CUIS_STDIO_BRIDGE_V1,
  OPENSMALLTALK_CUIS_PROVIDER_ID,
  OPENSMALLTALK_CUIS_PROVIDER_V0,
  OpenSmalltalkCuisCallError,
  bridgeSource as createCuisStdioBridgeSource,
  createOpenSmalltalkCuisProvider,
  decodeBridgeValue as decodeCuisBridgeValue,
  encodeBridgeValue as encodeCuisBridgeValue,
};