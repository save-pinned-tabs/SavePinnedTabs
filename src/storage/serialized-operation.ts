const storageOperations = new WeakMap<
  object,
  Map<string, SerializedOperation>
>();

type Operation<Result> = (
  lock?: Lock | null,
) => Result | PromiseLike<Result>;

interface SerializedOperation {
  <Result>(operation: Operation<Result>): Promise<Awaited<Result>>;
}

export function createSerializedOperation(
  lockName: string,
): SerializedOperation {
  let pending: Promise<unknown> = Promise.resolve();

  return function run<Result>(
    operation: Operation<Result>,
  ): Promise<Awaited<Result>> {
    const queued = pending.then(
      async (): Promise<Awaited<Result>> => {
        const locks = globalThis.navigator?.locks;
        if (locks?.request) {
          return await locks.request(
            lockName,
            (lock) => Promise.resolve(operation(lock)),
          );
        }

        return await operation();
      },
    );

    pending = queued.catch(() => {});
    return queued;
  };
}

export function createSerializedStorageOperation(
  storage: object,
  lockName: string,
): SerializedOperation {
  let operationsByLock = storageOperations.get(storage);
  if (!operationsByLock) {
    operationsByLock = new Map<string, SerializedOperation>();
    storageOperations.set(storage, operationsByLock);
  }

  let operation = operationsByLock.get(lockName);
  if (!operation) {
    operation = createSerializedOperation(lockName);
    operationsByLock.set(lockName, operation);
  }

  return operation;
}