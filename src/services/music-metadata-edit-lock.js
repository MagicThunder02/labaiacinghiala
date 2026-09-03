'use strict';

let editQueue = Promise.resolve();

function withMusicMetadataEditLock(operation) {
  const current = editQueue.catch(() => {}).then(operation);
  editQueue = current;
  return current;
}

module.exports = {
  withMusicMetadataEditLock,
};
