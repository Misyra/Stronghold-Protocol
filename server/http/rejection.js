// Opt-in handoff to nginx: keep normal HTTP diagnostics for direct/local callers.
import { clientAddress, isLocalIp } from '../net.js';
import { splitUrl } from './common.js';

export const HTTP_DROP_PATH = '/_sp/http-drop';

/** nginx consumes X-Accel-Redirect before sending any response to the public client. */
export function markHttpRejection(req, res, reason) {
  if (req.headers?.['x-sp-drop-rejections'] !== '1' || !isLocalIp(clientAddress(req, false).ip)) return;
  // auth_request must receive 403 itself, not a dropped subrequest (which nginx treats as a 500).
  if (splitUrl(req.url || '')?.rawPath === '/_sp/ip-check') return;
  res.setHeader('X-SP-HTTP-Reject', reason);
  res.setHeader('X-Accel-Redirect', HTTP_DROP_PATH);
}
