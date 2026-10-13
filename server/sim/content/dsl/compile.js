// C2 seam for WP-C. P1b never interprets a DSL or executes third-party code.
export function compileDsl() {
  throw Object.assign(new Error('DSL content is unavailable in P1b'), { code: 'PLUGIN_DSL_UNAVAILABLE' });
}
