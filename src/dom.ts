/** Provides type-safe lookup and validation of DOM elements. */

type ElementConstructor<T extends Element> = abstract new () => T;

/** Retrieves an element by ID and throws if it is missing or has an unexpected type. */
export function requireElement<T extends Element>(
  document: Document,
  id: string,
  constructor: ElementConstructor<T>,
): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) {
    throw new Error(
      `Required element #${id} is missing or has an unexpected type.`,
    );
  }
  return element;
}
