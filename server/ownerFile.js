// The owner (服主) mark, server-verified (移植自用户分支): a small JSON file named by SP_OWNER_FILE,
// `{ "names": ["…"], "keySha256": "<64 hex>" }` — `names`: the owner's reserved nicknames, `keySha256`: the SHA-256 (hex)
// of the owner key.
//   * A `hello` whose optional `owner` key hashes to keySha256 (crypto.timingSafeEqual) makes that session the owner
//     (server/net.js onHelloMsg): `welcome.owner: true`, room.state seats[] / spectators[] `owner: true`. It is decided
//     again on every hello — a resume or a repeated hello without the key is no owner.
//   * Anybody else's hello whose name folds (ownerNameKey: NFKC, no whitespace / invisible characters, case-folded) to a
//     reserved name is refused with NAME_REJECTED, detail NAME_RESERVED, before a reconnect token is looked up (like a
//     rejected name: the identity stays intact until a valid name comes).
//   * No env, a missing file or an invalid one (any other key or value) = off: nobody is the owner, no name is reserved.
//     The file is re-read when its modification time changes, checked every `pollMs` off the request path like
//     server/onlineLimit.js; mount its DIRECTORY (an editor replaces the file's inode).
// The key, its hash and the file's contents are never logged or sent: the log says only how many names were loaded.
import { promises as fs } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

/** The NAME_REJECTED detail of a reserved name (the client may say so instead of the moderation text). */
export const NAME_RESERVED = 'reserved';
/** Bounds of the file: names and their length (a nickname is at most NAME_MAX_LEN = 12; room for older spellings). */
export const OWNER_FILE_LIMITS = Object.freeze({ names: 64, nameLength: 64 });

const FOLD_DROP_RE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}]/gu;
/** The form two names are compared in: NFKC, whitespace and invisible characters removed, case-folded. */
export const ownerNameKey = (name) => (typeof name === 'string'
  ? name.normalize('NFKC').replace(FOLD_DROP_RE, '').toUpperCase().toLowerCase() : '');

/**
 * @param {unknown} doc parsed file contents
 * @returns {{ names: Set<string>, hash: Buffer } | null} the folded reserved names and the key's digest; null when invalid
 */
export function parseOwnerFile(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (Object.keys(doc).some((key) => key !== 'names' && key !== 'keySha256')) return null;
  const { names, keySha256 } = /** @type {any} */ (doc);
  if (typeof keySha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(keySha256)) return null;
  if (!Array.isArray(names) || names.length > OWNER_FILE_LIMITS.names) return null;
  const folded = new Set();
  for (const name of names) {
    const key = typeof name === 'string' && name.length <= OWNER_FILE_LIMITS.nameLength ? ownerNameKey(name) : '';
    if (!key) return null;
    folded.add(key);
  }
  return { names: folded, hash: Buffer.from(keySha256, 'hex') };
}

/**
 * @param {{ file?: string | null, pollMs?: number, log?: { info: Function, warn: Function } }} [opts]
 * @returns {{ verify: (key: unknown) => boolean, reserved: (name: unknown) => boolean, active: () => boolean,
 *   refresh: () => Promise<boolean>, close: () => void }}
 *   verify: the key is the owner's · reserved: a name only the owner may use · active: a valid file is loaded
 */
export function createOwnerFile({ file = null, pollMs = 5000, log = { info() {}, warn() {} } } = {}) {
  let state = null, stamp = null, warned = null, timer = null, closed = false;
  const set = (next) => {
    if (next) log.info(`[owner] owner file loaded: ${next.names.size} names`);
    else if (state) log.info('[owner] owner file gone: owner mark off');
    state = next;
  };
  const check = async () => {
    if (!file || closed) return !!state;
    try {
      let st;
      try { st = await fs.stat(file); } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
        if (stamp !== 'missing') { stamp = 'missing'; set(null); }
        return !!state;
      }
      const next = `${st.mtimeMs}:${st.size}:${st.ino}`;
      if (next === stamp) return !!state;
      stamp = next;
      let parsed = null;
      // never log a parse error: its message may quote the file
      try { parsed = parseOwnerFile(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { parsed = null; }
      if (parsed) { warned = null; set(parsed); }
      else {
        state = null;
        if (warned !== next) { warned = next; log.warn('[owner] owner file invalid: owner mark off'); }
      }
    } catch (e) {
      if (warned !== 'error') { warned = 'error'; log.warn(`[owner] cannot read the owner file: ${e?.code || 'error'}`); }
    }
    return !!state;
  };
  // checks run one after another, like server/onlineLimit.js
  let chain = Promise.resolve(false);
  const refresh = () => (chain = chain.then(check, check));
  if (file) {
    void refresh();
    timer = setInterval(() => { void refresh(); }, Math.max(250, pollMs));
    timer.unref?.();
  }
  const verify = (key) => {
    if (!state || typeof key !== 'string' || !key) return false;
    return timingSafeEqual(createHash('sha256').update(key, 'utf8').digest(), state.hash);
  };
  const reserved = (name) => !!state && state.names.has(ownerNameKey(name));
  return { verify, reserved, active: () => !!state, refresh,
    close: () => { closed = true; if (timer) clearInterval(timer); timer = null; } };
}
