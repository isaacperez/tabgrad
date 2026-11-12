/** Require a concrete control from the shared workspace markup. */
export function required<T extends Element>(
  root: ParentNode,
  selector: string,
  constructor: { new (...args: never[]): T },
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor)) throw new Error(`Missing playground control: ${selector}`);
  return element;
}
