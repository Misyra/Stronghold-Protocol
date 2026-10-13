// Server-only nickname preflight; no matched terms, names or dictionary metadata in responses.
import { NAME_MAX_LEN, ERR } from '../../shared/constants.js';
import { sanitizeName } from '../net.js';
import { hasSensitiveNickname } from '../moderation/nickname.js';
import { sendJson } from './common.js';
import { readJsonBody } from './readJson.js';

export async function validateNickname(req, res, allow) {
  const reject = (status, code) => {
    if (!req.complete) { res.setHeader('Connection', 'close'); req.resume(); }
    sendJson(req, res, status, { ok: false, code });
  };
  if (allow && !allow(req)) { res.setHeader('Retry-After', '1'); reject(429, 'RATE_LIMITED'); return; }
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); reject(405, 'METHOD_NOT_ALLOWED'); return; }
  // JSON requires a CORS preflight; deliberately expose no CORS permission.
  if (req.headers['sec-fetch-site'] === 'cross-site') { reject(403, 'FORBIDDEN'); return; }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { reject(415, 'JSON_REQUIRED'); return; }
  if (Number(req.headers['content-length']) > 1024) { reject(413, 'BODY_TOO_LARGE'); return; }
  let value;
  try { value = await readJsonBody(req, { maxBytes: 1024 }); }
  catch (error) { if (!res.destroyed) reject(error.status, 'BAD_REQUEST'); return; }
  if (res.destroyed) return;
  const raw = value?.name;
  if (typeof raw !== 'string' || !raw.length || [...raw].length > NAME_MAX_LEN) { reject(400, 'INVALID_NAME'); return; }
  const name = sanitizeName(raw);
  if (!name) { reject(400, 'INVALID_NAME'); return; }
  if (hasSensitiveNickname(name)) { reject(422, ERR.NICKNAME_SENSITIVE); return; }
  sendJson(req, res, 200, { ok: true });
}
