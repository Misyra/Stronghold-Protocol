// shared/plugins/offers.js — the declarative `offers` part of manifest 2 (PLUGIN API v2, docs/PLUGINS.md §10b):
// an interaction window a plugin asks the host to open. A window may narrow who it opens for (`when.bands`) and a
// card may carry a per-picker condition (`when`); both are declarative and evaluated per player at open time. Pure data: this module only reads and checks the files, it
// never runs plugin code and never touches the match. A window's *lifecycle* (open → collect g.offer → deadline →
// settle) is engine code, and a pick's effect is one of the closed effect primitives below.
//
// Round decoupling (the point of the part): `when.rounds` is an expression over the round number, not a fixed
// schedule — an explicit list [1, 3, 6, 11], "any", { every: N } or { from, to }. Nothing here knows which rounds a
// mode actually has, and nothing may special-case one: the caller asks `offerAt(offer, { at, round })` per round. A
// window declared for a round the mode never reaches simply never opens, and a window for a round the official
// content does not use (R3, R9 …) opens exactly like one for R1 — the timing is "before that round begins".
//
// Nothing in this module is on the vanilla loading path: a content set without a plugin that declares the part
// resolves no offer at all, so a room without plugins never opens a window (docs/PLUGINS.md, "Compatibility").
import { problem } from './dataUtils.js';
import { MAX_SEATS } from '../constants.js';
import { PLUGIN_OFFERS_MAX_WINDOW_SEC, PLUGIN_OFFER_SLOTS } from './limits.js';

/** The manifest field and permission of this part (shared/plugins/manifest.js PARTS / PERMISSIONS). */
export const OFFERS_PART = 'offers';
export const OFFERS_PERMISSION = 'offers';

/** The `offer` file version this build reads. A file's `offer` must equal it. */
export const OFFER_FILE_VERSION = 1;

/** When a window may open, relative to the match flow. Both are upstream's own moments. */
export const OFFER_WHEN = Object.freeze(['battleCheck', 'prep']);
/** Who the host waits for before it closes a window. */
export const OFFER_QUORUM = Object.freeze(['all', 'majority', 'none']);
/** What the host does when a deadline passes with the window still open. */
export const OFFER_TIMEOUT = Object.freeze(['auto', 'bot', 'skip']);
/** Batches a window may hold back until it closes. */
export const OFFER_DEFER = Object.freeze(['prepSettle']);
/**
 * The closed set of effect primitives a pick applies (no plugin code runs at settle time). Each one is a plain
 * object with one key; the host executes it with the picker's player scope.
 */
export const OFFER_EFFECTS = Object.freeze(['funds', 'pendingFunds', 'freeRefresh', 'layers', 'item', 'chess']);
// [ASSUMED] Small, uniform JSON pools and symbolic icons; no scripts, URLs, weights or dynamic sources.
export const OFFER_ICONS = Object.freeze(['funds', 'layers', 'item', 'chess', 'refresh']);
export const OFFER_CARDS_MAX = 128;
/** Optional author-facing UI fields, implemented by the API-2 host since 0.3.4. */
export const OFFER_UI_FIELDS = Object.freeze({ window: Object.freeze(['title', 'selector', 'selectors']), card: Object.freeze(['variants', 'quote']) });
/** Best-effort marker names inside a deferred batch, for messages: never a path and never code. */
export const OFFER_NAMES = Object.freeze(['enemy', 'player']);

/** @type {(v: unknown) => v is Record<string, any>} */
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const selectorId = v => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(v);
export const offerSelectors = offer => offer?.selectors ?? (offer?.selector ? [offer.selector] : []);
export const offerDefaultVariant = offer => offerSelectors(offer).length ? offerSelectors(offer).map(s => s.default).join(':') : undefined;
export function offerVariantIds(offer) {
  const selectors = offerSelectors(offer);
  let ids = selectors.length ? [''] : [];
  for (const selector of selectors) ids = ids.flatMap(id => selector.options.map(o => id ? id + ':' + o.id : o.id));
  return ids;
}
function readSelector(value) {
  if (!isObj(value) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80
    || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 6
    || Object.keys(value).some(k => !['label', 'default', 'options'].includes(k))) return null;
  const ids = new Set();
  for (const option of value.options) {
    if (!isObj(option) || !selectorId(option.id) || ids.has(option.id) || typeof option.name !== 'string'
      || !option.name.trim() || option.name.length > 40 || Object.keys(option).some(k => !['id', 'name'].includes(k))) return null;
    ids.add(option.id);
  }
  return ids.has(value.default) ? { label: value.label, default: value.default, options: value.options.map(o => ({ id: o.id, name: o.name })) } : null;
}

// A display-only quote. The grant is always a separately validated primitive, never computed from client amounts.
function readQuote(value) {
  if (!isObj(value) || !Number.isFinite(value.fraction) || value.fraction <= 0 || value.fraction > 1
    || !Number.isFinite(value.multiplier) || value.multiplier < 1 || value.multiplier > 100
    || !['debtCounter', 'creditLimitCounter'].every(k => typeof value[k] === 'string' && value[k].length > 0 && value[k].length <= 128)
    || Object.keys(value).some(k => !['fraction', 'multiplier', 'debtCounter', 'creditLimitCounter'].includes(k))) return null;
  return { fraction: value.fraction, multiplier: value.multiplier, debtCounter: value.debtCounter, creditLimitCounter: value.creditLimitCounter };
}

/**
 * Sanity ceiling for a round number in an expression. It is not a mode's last round (that is the mode's own data and
 * this module never reads it): it only keeps an expression finite, and it sits far above every official round count.
 */
export const OFFER_ROUND_MAX = 99;

/**
 * Check a `when.rounds` expression (the round set a window opens on). Absent means every round. Returns null when the
 * value is not an expression, else the normalised form the host evaluates with `roundsMatch`.
 * @param {unknown} v
 * @returns {null | { kind: 'list', rounds: number[] } | { kind: 'every', every: number } | { kind: 'range', from: number, to: number }}
 */
export function readRounds(v) {
  if (typeof v === 'string') return v === 'any' ? { kind: 'list', rounds: [] } : null;
  if (Array.isArray(v)) {
    if (!v.length || v.length > 64) return null;
    const rounds = [];
    for (const r of v) { if (!int(r, 1, OFFER_ROUND_MAX)) return null; if (!rounds.includes(r)) rounds.push(r); }
    return { kind: 'list', rounds: rounds.sort((a, b) => a - b) };
  }
  if (isObj(v)) {
    const o = /** @type {Record<string, unknown>} */ (v);
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === 'every' && int(o.every, 1, 32)) return { kind: 'every', every: /** @type {number} */ (o.every) };
    if (keys.length === 2 && has(o, 'from') && has(o, 'to') && int(o.from, 1, OFFER_ROUND_MAX) && int(o.to, 1, OFFER_ROUND_MAX) && /** @type {number} */ (o.from) <= /** @type {number} */ (o.to)) {
      return { kind: 'range', from: /** @type {number} */ (o.from), to: /** @type {number} */ (o.to) };
    }
  }
  return null;
}

/**
 * Does this expression open on `round`? The host calls it once per round; there is no round this function treats
 * specially.
 * @param {ReturnType<typeof readRounds>} rounds the normalised expression
 * @param {number} round
 */
export function roundsMatch(rounds, round) {
  if (!rounds || !Number.isInteger(round) || round < 1) return false;
  if (rounds.kind === 'every') return round % rounds.every === 0;
  if (rounds.kind === 'range') return round >= rounds.from && round <= rounds.to;
  // 'list': an empty list is the "any" spelling, every round
  return rounds.rounds.length === 0 || rounds.rounds.includes(round);
}

/**
 * The human-readable form of an expression (a message, a catalogue line — never parsed back).
 * @param {ReturnType<typeof readRounds>} rounds
 */
export function roundsText(rounds) {
  if (!rounds) return '';
  if (rounds.kind === 'every') return `every ${rounds.every}`;
  if (rounds.kind === 'range') return `${rounds.from}–${rounds.to}`;
  return rounds.rounds.length ? rounds.rounds.join(', ') : 'any';
}

/** A problem with one effect primitive, or null. Pure: the caller decides whether it is fatal. */
export function effectProblem(effect, at) {
  if (!isObj(effect)) return `${at}: not an object`;
  const keys = Object.keys(effect);
  if (keys.length !== 1 || !OFFER_EFFECTS.includes(keys[0])) return `${at}: one of ${OFFER_EFFECTS.join(', ')}`;
  const [kind] = keys;
  const v = effect[kind];
  const bad = `${at}.${kind}: wrong value`;
  // [ASSUMED] Grants only: at most 1000 funds, 999 layers, six refreshes or one record per pick.
  if (kind === 'funds' || kind === 'pendingFunds') return int(v, 0, 1000) ? null : bad;
  if (kind === 'freeRefresh') return int(v, 1, PLUGIN_OFFER_SLOTS) ? null : bad;
  if (kind === 'layers') return isObj(v) && Object.keys(v).length === 2 && typeof v.bond === 'string' && v.bond.length <= 64 && int(v.count, 1, 999) ? null : bad;
  if (kind === 'item' || kind === 'chess') return typeof v === 'string' && v.length <= 64 && v.trim() ? null : bad;
  return bad;
}

/**
 * Read a card's optional picker condition. `null` is "always"; `{ solo: true }` shows the card only when the picker
 * is the room's last standing player; `{ seat: k }` only when another player occupies seat k (1-based, the same
 * numbering the room UI uses). A closed vocabulary on purpose: no expressions, no code.
 * @param {unknown} v
 * @returns {{ solo: true } | { seat: number } | null}
 */
export function readCardWhen(v) {
  if (v === undefined) return null;
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  if (keys.length === 1 && v.solo === true) return { solo: true };
  if (keys.length === 1 && int(v.seat, 1, MAX_SEATS)) return { seat: v.seat };
  return null;
}

/** Read a JSON array (or {cards: [...]}); every rendered slot has a checked payload and effect. */
export function readOfferCards(raw, offer) {
  const cards = Array.isArray(raw) ? raw : raw?.cards;
  const problems = [];
  const bad = (path, message) => problems.push(problem('PLUGIN_OFFER_SHAPE', path, message));
  if (!Array.isArray(cards) || cards.length < offer.slots || cards.length > OFFER_CARDS_MAX) {
    bad('options.source', `expected ${offer.slots}–${OFFER_CARDS_MAX} cards`);
    return { cards: [], problems };
  }
  const ids = new Set();
  const out = cards.map((c, i) => {
    const at = `cards[${i}]`;
    if (!isObj(c)) { bad(at, 'card must be an object'); return null; }
    if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(c.id) || ids.has(c.id)) bad(`${at}.id`, 'unique card id required');
    ids.add(c.id);
    for (const [key, max] of Object.entries({ name: 80, desc: 240 })) {
      if (typeof c[key] !== 'string' || !c[key].trim() || c[key].length > max) bad(`${at}.${key}`, `nonempty text, at most ${max} characters`);
    }
    if (!OFFER_ICONS.includes(c.icon)) bad(`${at}.icon`, `one of ${OFFER_ICONS.join(', ')}`);
    const when = readCardWhen(c.when);
    if (c.when !== undefined && !when) bad(`${at}.when`, `"when" is { "solo": true } or { "seat": 1–${MAX_SEATS} } (a picker condition, see PLUGINS.md §10b)`);
    const effect = c.apply ?? offer.apply;
    const err = effectProblem(effect, `${at}.apply`);
    if (err) bad(`${at}.apply`, err);
    const quote = c.quote === undefined ? null : readQuote(c.quote);
    if (c.quote !== undefined && !quote) bad(`${at}.quote`, 'invalid margin quote');
    let variants = null;
    if (c.variants !== undefined) {
      const ids = offerVariantIds(offer);
      if (!ids.length || !isObj(c.variants) || Object.keys(c.variants).length !== ids.length
        || Object.keys(c.variants).some(k => !ids.includes(k))) bad(`${at}.variants`, 'variants must match every selector combination');
      else {
        variants = {};
        for (const [id, v] of Object.entries(c.variants)) {
          if (!isObj(v) || Object.keys(v).some(k => !['apply', 'quote'].includes(k)) || effectProblem(v.apply, `${at}.variants.${id}`)) {
            bad(`${at}.variants.${id}`, 'one validated grant primitive is required'); continue;
          }
          const q = v.quote === undefined ? quote : readQuote(v.quote);
          if (v.quote !== undefined && !q) bad(`${at}.variants.${id}.quote`, 'invalid margin quote');
          variants[id] = { effect: v.apply, ...(q ? { quote: q } : {}) };
        }
      }
    }
    return { id: c.id, name: c.name, desc: c.desc, icon: c.icon, effect, when,
      ...(quote ? { quote } : {}), ...(variants ? { variants } : {}) };
  });
  return { cards: problems.length ? [] : out, problems };
}

/**
 * Read and check one `offers/<id>.json` file (the shape of docs/PLUGINS.md §10b). Pure.
 * @param {unknown} raw the parsed file
 * @param {{ pluginId?: string, rel?: string }} [ctx]
 * @returns {{ offer: object | null, problems: { code: string, path: string, message: string }[], warnings: { code: string, path: string, message: string }[] }}
 */
export function readOfferFile(raw, { pluginId = '', rel = '' } = {}) {
  const problems = [];
  const warnings = [];
  const id = rel || (isObj(raw) && typeof (/** @type {Record<string, unknown>} */ (raw)).id === 'string' ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (raw).id) : '');
  const where = id ? `"${id}"` : 'offer';
  const p = (code, path, message) => problems.push({ code, path, message });
  const w = (code, path, message) => warnings.push({ code, path, message });
  const item = (code, message) => { p(code, where, message); return null; };
  if (!isObj(raw)) { item('PLUGIN_OFFER_SHAPE', `${where}: not a JSON object`); return { offer: null, problems, warnings }; }
  const o = /** @type {Record<string, any>} */ (raw);
  const selector = o.selector === undefined ? null : readSelector(o.selector);
  if (o.selector !== undefined && !selector) p('PLUGIN_OFFER_SHAPE', 'selector', 'selector requires 2–6 named options and a valid default');
  let selectors = null;
  if (o.selectors !== undefined) {
    if (o.selector !== undefined || !Array.isArray(o.selectors) || o.selectors.length < 1 || o.selectors.length > 2
      || o.selectors.some(s => !readSelector(s))) p('PLUGIN_OFFER_SHAPE', 'selectors', 'selectors is 1–2 valid selectors; do not also declare selector');
    else {
      selectors = o.selectors.map(readSelector);
      if (offerVariantIds({ selectors }).some(id => id.length > 64)) p('PLUGIN_OFFER_SHAPE', 'selectors', 'combined variant IDs must fit 64 characters');
    }
  }
  if (o.title !== undefined && (typeof o.title !== 'string' || !o.title.trim() || o.title.length > 80)) p('PLUGIN_OFFER_SHAPE', 'title', 'title is nonempty text up to 80 characters');
  if (o.offer !== OFFER_FILE_VERSION) p('PLUGIN_OFFER_SHAPE', 'offer', `"offer": ${JSON.stringify(o.offer)} is not ${OFFER_FILE_VERSION}`);
  const fileId = typeof o.id === 'string' ? o.id.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(fileId)) p('PLUGIN_OFFER_SHAPE', 'id', '"id" is 1–32 lower-case letters, digits and - (it names the window in messages and messages of the room)');
  // `when`: the moment and the rounds. `at` picks an upstream moment; `rounds` is an expression over the round number;
  // `bands` (optional) narrows the participants to players of these bands — a window nobody may open creates nothing.
  let at0 = null;
  let rounds = null;
  let bands = null;
  if (!isObj(o.when)) p('PLUGIN_OFFER_SHAPE', 'when', '"when" is { "at": ["battleCheck" | "prep", …], "rounds"?: …, "bands"?: [...] }');
  else {
    const list = Array.isArray(o.when.at) ? o.when.at : o.when.at === undefined ? [] : [o.when.at];
    const bad = list.filter((x) => !OFFER_WHEN.includes(x));
    if (!list.length || bad.length || new Set(list).size !== list.length) p('PLUGIN_OFFER_SHAPE', 'when.at', `"when.at" is one or more of ${OFFER_WHEN.map((x) => `"${x}"`).join(', ')}`);
    else at0 = OFFER_WHEN.filter((x) => list.includes(x));
    if (o.when.rounds !== undefined) {
      rounds = readRounds(o.when.rounds);
      if (!rounds) p('PLUGIN_OFFER_ROUNDS', 'when.rounds', `"when.rounds" is a list of rounds 1–${OFFER_ROUND_MAX}, "any", { "every": N } or { "from": R, "to": R }`);
    } else rounds = { kind: 'list', rounds: [] };
    if (o.when.bands !== undefined) {
      const list = Array.isArray(o.when.bands) ? o.when.bands : [o.when.bands];
      const badBand = list.filter((x) => typeof x !== 'string' || !x.trim() || x.length > 64);
      if (!list.length || list.length > 8 || badBand.length || new Set(list).size !== list.length) p('PLUGIN_OFFER_SHAPE', 'when.bands', '"when.bands" is 1–8 unique band ids (the window opens only for players of these bands)');
      else bands = list;
    }
    for (const k of Object.keys(o.when)) if (!['at', 'rounds', 'bands'].includes(k)) w('PLUGIN_OFFER_SHAPE', `when.${k}`, `"when.${k}" is not a field of "when" (ignored)`);
  }
  const windowSec = o.windowSec === undefined ? 0 : o.windowSec;
  if (!int(windowSec, 0, PLUGIN_OFFERS_MAX_WINDOW_SEC)) p('PLUGIN_OFFER_SHAPE', 'windowSec', `"windowSec" is 0–${PLUGIN_OFFERS_MAX_WINDOW_SEC} whole seconds (0 opens no window and holds nothing back)`);
  const quorum = o.quorum === undefined ? 'none' : o.quorum;
  if (!OFFER_QUORUM.includes(quorum)) p('PLUGIN_OFFER_SHAPE', 'quorum', `"quorum" is one of ${OFFER_QUORUM.map((x) => `"${x}"`).join(', ')}`);
  const onTimeout = o.onTimeout === undefined ? 'auto' : o.onTimeout;
  if (!OFFER_TIMEOUT.includes(onTimeout)) p('PLUGIN_OFFER_SHAPE', 'onTimeout', `"onTimeout" is one of ${OFFER_TIMEOUT.map((x) => `"${x}"`).join(', ')}`);
  const defer = o.defer === undefined ? [] : o.defer;
  if (!Array.isArray(defer) || defer.some((x) => !OFFER_DEFER.includes(x)) || new Set(defer).size !== defer.length) {
    p('PLUGIN_OFFER_SHAPE', 'defer', `"defer" is a list of ${OFFER_DEFER.map((x) => `"${x}"`).join(', ')} (the batches the host holds back while the window is open)`);
  }
  const slots = o.slots === undefined ? 1 : o.slots;
  if (!int(slots, 1, PLUGIN_OFFER_SLOTS)) p('PLUGIN_OFFER_SHAPE', 'slots', `"slots" is 1–${PLUGIN_OFFER_SLOTS} (the same cap as the host's own pick-one offers)`);
  let refresh = null;
  if (o.refresh !== undefined) {
    if (!isObj(o.refresh) || !int(o.refresh.perSlot, 0, 2) || Object.keys(o.refresh).some((k) => k !== 'perSlot')) p('PLUGIN_OFFER_SHAPE', 'refresh', '"refresh" is { "perSlot": 0–2 } (how many times a player may redraw one slot)');
    else refresh = { perSlot: o.refresh.perSlot };
  }
  // [ASSUMED] Shared enemy/player pools have no declarative effect semantics yet; refuse instead of ignoring.
  const shared = null;
  if (o.shared !== undefined) p('PLUGIN_OFFER_SHAPE', 'shared', 'shared option pools are not supported');
  // Only local JSON card pools are supported; the registry reads and hashes this transitive source.
  let options = null;
  if (!isObj(o.options) || typeof o.options.source !== 'string' || !o.options.source.trim()) {
    p('PLUGIN_OFFER_SHAPE', 'options', '"options" is { "source": "<file inside the plugin folder>" }');
  } else {
    const src = o.options.source.trim();
    if (src.includes('..') || src.startsWith('/') || src.includes('\\') || src.includes(':')) p('PLUGIN_OFFER_SHAPE', 'options.source', `"options.source": ${JSON.stringify(src)} is not a path inside the plugin folder`);
    else if (!src.endsWith('.json')) p('PLUGIN_OFFER_SHAPE', 'options.source', `"options.source": ${src} is not a .json file`);
    else options = { source: src };
    for (const k of Object.keys(o.options)) if (!['source', 'tiers'].includes(k)) w('PLUGIN_OFFER_SHAPE', `options.${k}`, `"options.${k}" is not a field of "options" (ignored)`);
    if (o.options.tiers !== undefined) w('PLUGIN_OFFER_SHAPE', 'options.tiers', '"options.tiers" is not read by this build (rounds pick the window: "when.rounds")');
  }
  // Optional fallback for cards without their own apply primitive. Never a script or SDK callback.
  if (o.apply !== undefined) {
    const message = effectProblem(o.apply, 'apply');
    if (message) p('PLUGIN_OFFER_SHAPE', 'apply', `"apply": ${message} (a pick applies one effect primitive, never code)`);
  }
  for (const k of Object.keys(o)) if (!['offer', 'id', 'when', 'windowSec', 'quorum', 'onTimeout', 'defer', 'slots', 'refresh', 'shared', 'options', 'apply', ...OFFER_UI_FIELDS.window].includes(k)) w('PLUGIN_OFFER_SHAPE', k, `"${k}" is not a field of an offer (ignored)`);
  if (problems.length) return { offer: null, problems, warnings };
  return {
    offer: {
      id: fileId, rel, pluginId, when: { at: at0, rounds, bands }, rounds, windowSec, quorum, onTimeout, defer, slots, refresh, shared, options,
      ...(o.apply === undefined ? {} : { apply: o.apply }),
      ...(selector ? { selector } : {}),
      ...(selectors ? { selectors } : {}),
      ...(o.title === undefined ? {} : { title: o.title }),
    },
    problems, warnings,
  };
}

/**
 * Does this offer open at `at` on `round`? The host's one question per (offer, moment, round) — it holds no round of
 * its own, so a declaration for R3 or R9 behaves exactly like one for R1.
 * @param {{ when: { at: string[] }, rounds: ReturnType<typeof readRounds> }} offer
 * @param {{ at: string, round: number }} q
 */
export function offerAt(offer, { at, round }) {
  return !!offer && !!offer.when && offer.when.at.includes(at) && roundsMatch(offer.rounds, round);
}

/**
 * The offers of a set that open at a moment and round, in the set's own order (the host then orders them like every
 * other plugin list: shared/plugins/order.js). Pure.
 *
 * An entry is either one plugin's own window — `{ id, offers: [...] }` (a registry plugin, whose `id` is the plugin id
 * and whose windows carry their own ids) — or one window of a content set, which the builder tags with the plugin that
 * declares it, `{ pluginId, id, … }`. `id` is never the window's own id at the entry level: a window names itself in
 * `offer.id`, so both shapes are unambiguous.
 * @param {readonly ({ id: string, offers?: readonly object[] } | { pluginId: string } & object)[]} plugins
 * @param {{ at: string, round: number }} q
 */
export function offersAt(plugins, q) {
  const out = [];
  for (const p of plugins || []) {
    if (!p) continue;
    if (Array.isArray(p.offers)) {
      const owner = typeof p.pluginId === 'string' ? p.pluginId : p.id;
      for (const o of p.offers) if (offerAt(o, q)) out.push({ pluginId: owner, offer: o });
    } else if (typeof p.pluginId === 'string' && offerAt(p, q)) {
      out.push({ pluginId: p.pluginId, offer: p });
    }
  }
  return out;
}

/** The same `{ code, path, message }` shape `problem()` builds, for a caller that throws instead of collecting. */
export function offerProblem(code, path, message) {
  return problem(code, path, message);
}
