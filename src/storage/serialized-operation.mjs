const storageOperations = new WeakMap();

export function createSerializedOperation(lockName) {
  let pending = Promise.resolve();

  return function run(operation) {
    const queued = pending.then(async () => {
      const locks = globalThis.navigator?.locks;
      if (locks?.request) return locks.request(lockName, operation);
      return operation();
    });
    pending = queued.catch(() => {});
    return queued;
  };
}

export function createSerializedStorageOperation(storage, lockName) {
  let operationsByLock = storageOperations.get(storage);
  if (!operationsByLock) {
    operationsByLock = new Map();
    storageOperations.set(storage, operationsByLock);
  }

  let operation = operationsByLock.get(lockName);
  if (!operation) {
    operation = createSerializedOperation(lockName);
    operationsByLock.set(lockName, operation);
  }
  return operation;
}
