// Immutable frames are shared by recipients; only these queue links belong to a socket.
export class OutboundQueue {
  constructor() {
    this.head = null;
    this.tail = null;
    this.size = 0;
    this.bytes = 0;
    this.scope = null;
    this.latest = new Map();
  }

  push(frame, coalesce) {
    const scope = frame.scope;
    if (!scope || scope !== this.scope) {
      this.latest.clear();
      this.scope = scope || null;
    }
    const privateNode = frame.kind === 'm.private' && this.latest.get(frame.kind);
    if (privateNode && privateNode.frame.owner !== frame.owner) this.latest.clear();
    const previous = scope && coalesce ? this.latest.get(frame.kind) : null;
    if (previous) this.remove(previous);
    const node = previous || { frame: null, prev: null, next: null };
    node.frame = frame;
    node.prev = this.tail;
    node.next = null;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    this.size++;
    this.bytes += frame.bytes;
    if (scope) this.latest.set(frame.kind, node);
    return !!previous;
  }

  remove(node) {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    const frame = node.frame;
    this.size--;
    this.bytes -= frame.bytes;
    if (this.latest.get(frame.kind) === node) this.latest.delete(frame.kind);
    node.prev = node.next = node.frame = null;
    return frame;
  }

  shift() { return this.head ? this.remove(this.head) : null; }
}
