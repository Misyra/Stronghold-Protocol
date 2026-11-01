/**
 * Ambient declarations for the isomorphic globals the shared/ slice reads: URL, URLSearchParams and
 * AbortSignal exist as globals on both hosts — every evergreen browser and modern Node (URL and
 * URLSearchParams since 10.10, AbortSignal.timeout since 17.3) — but no lib declares them here: the
 * shared checkJs slice intentionally loads no DOM/Node lib (shared/plugins/scriptLoad.js works around
 * the same gap with `globalThis`). Kept to the members shared/ actually uses; widen when needed.
 *   URL: https://url.spec.whatwg.org/#url-class
 *   AbortSignal.timeout: https://developer.mozilla.org/docs/Web/API/AbortSignal/timeout_static
 */

declare class URL {
  constructor(url: string | URL, base?: string | URL);
  // WHATWG: every member but origin has a setter (shared/resourcePaths.js rewrites pathname).
  href: string;
  protocol: string;
  username: string;
  password: string;
  readonly origin: string;
  pathname: string;
  search: string;
  hash: string;
}

declare class URLSearchParams {
  constructor(init?: string);
  get(name: string): string | null;
  has(name: string): boolean;
  append(name: string, value: string): void;
  set(name: string, value: string): void;
  delete(name: string): void;
  toString(): string;
}

declare class AbortSignal {
  get aborted(): boolean;
  static abort(reason?: unknown): AbortSignal;
  static timeout(milliseconds: number): AbortSignal;
}
