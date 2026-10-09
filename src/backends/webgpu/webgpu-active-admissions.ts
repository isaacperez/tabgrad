interface Admission<T> {
  readonly value: T;
  readonly id: number;
  active: boolean;
  left: Admission<T> | undefined;
  right: Admission<T> | undefined;
  height: number;
  count: number;
}

function height<T>(node: Admission<T> | undefined): number { return node?.height ?? 0; }
function count<T>(node: Admission<T> | undefined): number { return node?.count ?? 0; }

function update<T>(node: Admission<T>): Admission<T> {
  node.height = 1 + Math.max(height(node.left), height(node.right));
  node.count = Number(node.active) + count(node.left) + count(node.right);
  return node;
}

function rotateRight<T>(node: Admission<T>): Admission<T> {
  const left = node.left!;
  node.left = left.right;
  left.right = update(node);
  return update(left);
}

function rotateLeft<T>(node: Admission<T>): Admission<T> {
  const right = node.right!;
  node.right = right.left;
  right.left = update(node);
  return update(right);
}

function balance<T>(node: Admission<T>): Admission<T> {
  update(node);
  const difference = height(node.left) - height(node.right);
  if (difference > 1) {
    if (height(node.left!.left) < height(node.left!.right)) node.left = rotateLeft(node.left!);
    return rotateRight(node);
  }
  if (difference < -1) {
    if (height(node.right!.right) < height(node.right!.left)) node.right = rotateRight(node.right!);
    return rotateLeft(node);
  }
  return node;
}

function insert<T>(root: Admission<T> | undefined, node: Admission<T>): Admission<T> {
  if (root === undefined) return node;
  if (node.id < root.id) root.left = insert(root.left, node);
  else root.right = insert(root.right, node);
  return balance(root);
}

function remove<T>(root: Admission<T> | undefined, id: number): Admission<T> | undefined {
  if (root === undefined) return undefined;
  if (id < root.id) root.left = remove(root.left, id);
  else if (id > root.id) root.right = remove(root.right, id);
  else {
    if (root.left === undefined) return root.right;
    if (root.right === undefined) return root.left;
    let successor = root.right;
    while (successor.left !== undefined) successor = successor.left;
    const right = remove(root.right, successor.id);
    successor.left = root.left;
    successor.right = right;
    root = successor;
  }
  return balance(root);
}

function activate<T>(root: Admission<T>, id: number, active: boolean): Admission<T> {
  if (id === root.id) root.active = active;
  else if (id < root.id) root.left = activate(root.left!, id, active);
  else root.right = activate(root.right!, id, active);
  return update(root);
}

function next<T>(root: Admission<T> | undefined, cursor: number): T | undefined {
  if (root === undefined || root.count === 0) return undefined;
  if (root.id <= cursor) return next(root.right, cursor);
  return next(root.left, cursor) ?? (root.active ? root.value : next(root.right, cursor));
}

/** One consumer-owned ordered index; nested checkpoints retain only a cursor. */
export class ActiveGpuAdmissions<T> {
  #root: Admission<T> | undefined;
  readonly #nodes = new Map<T, Admission<T>>();

  add(value: T, id: number): void {
    const node: Admission<T> = { value, id, active: true, left: undefined, right: undefined, height: 1, count: 1 };
    this.#root = insert(this.#root, node);
    this.#nodes.set(value, node);
  }

  delete(value: T): void {
    const node = this.#nodes.get(value);
    if (node === undefined) return;
    this.#root = remove(this.#root, node.id);
    this.#nodes.delete(value);
  }

  setActive(value: T, active: boolean): void {
    const node = this.#nodes.get(value);
    if (node === undefined || node.active === active) return;
    this.#root = activate(this.#root!, node.id, active);
  }

  nextAfter(cursor: number): T | undefined { return next(this.#root, cursor); }
}
