import {
  installSmalltalkKernel, installSmalltalkAllocationProtocol, installSmalltalkEqualityProtocol,
  installSmalltalkControlFlow, installSmalltalkIndexedProtocol, installSmalltalkInstanceVariableProtocol,
  installSmalltalkDictionaryProtocol, installSmalltalkSymbolProtocol, installSmalltalkStringTestingProtocol,
  installSmalltalkTextByteArrayProtocol, textValue,
} from '../../src/runtime.js';

export async function seedStringEquality(runtime, imageId, lane, omit = null) {
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});
  const options = {images: runtime.images, compilation: runtime.compilation, imageId, lane};
  for (const [name, install] of [
    ['allocation', installSmalltalkAllocationProtocol], ['equality', installSmalltalkEqualityProtocol],
    ['controlFlow', installSmalltalkControlFlow], ['indexed', installSmalltalkIndexedProtocol],
    ['instanceVariables', installSmalltalkInstanceVariableProtocol], ['dictionary', installSmalltalkDictionaryProtocol],
    ['symbol', installSmalltalkSymbolProtocol], ['stringTesting', installSmalltalkStringTestingProtocol],
    ['text', installSmalltalkTextByteArrayProtocol],
  ]) if (name !== omit) await install(options);
  return options;
}

export function stringEqualitySender(runtime, imageId) {
  return async (receiver, selector, args = []) => runtime.executor.execute(await runtime.invocations.sendMessage({
    languageId: 'symmetric-smalltalk', receiver, message: textValue(selector), arguments: args,
  }, {dispatchImage: imageId}));
}
