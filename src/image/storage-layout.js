const IMAGE_COLLECTION = 'images';

const records = (imageId) => `image:${imageId}:objects`;
const snapshots = (imageId) => `image:${imageId}:snapshots`;
const history = (imageId) => `image:${imageId}:history`;

export {
  IMAGE_COLLECTION,
  history,
  records,
  snapshots,
};
