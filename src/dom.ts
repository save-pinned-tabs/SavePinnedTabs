type ElementConstructor<T extends Element> = abstract new () => T;

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
