/** Provides serialized execution queues for general and storage-scoped operations. */

const storageOperations = new WeakMap<
  object,
  Map<string, SerializedOperation>
>();

/** Represents an operation that may receive a browser lock and complete asynchronously. */
type Operation<Result> = (
  lock?: Lock | null,
) => Result | PromiseLike<Result>;

/** Queues operations sequentially and preserves each operation's result or error. */
interface SerializedOperation {
  <Result>(operation: Operation<Result>): Promise<Awaited<Result>>;
}

/** Creates a queue that executes one operation at a time, using the Lock API when available. */
export function createSerializedOperation(
  lockName: string,
): SerializedOperation {
  let pending: Promise<unknown> = Promise.resolve();

  /** Runs an operation after all previously queued operations have settled. */
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

/** Returns the shared serialized queue for a storage object and lock name. */
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