/** Read one bounded JSON body. Routes retain their content-type and response policies. */
export function readJsonBody(req, { maxBytes, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('JSON body limits must be positive');
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [event, listener] of listeners) req.off(event, listener);
      chunks = [];
      if (error) {
        // Keep the socket usable long enough for the route to return its error response.
        req.resume();
        reject(error);
      } else resolve(value);
    };
    const fail = (status, code, cause) => finish(Object.assign(new Error(code, cause ? { cause } : undefined), { status, code }));
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) fail(413, 'PAYLOAD_TOO_LARGE');
      else chunks.push(bytes);
    };
    const onEnd = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (cause) { fail(400, 'INVALID_JSON', cause); }
    };
    const onError = (cause) => fail(400, 'REQUEST_ABORTED', cause);
    const onAborted = () => fail(400, 'REQUEST_ABORTED');
    const onClose = () => { if (!req.complete) onAborted(); };
    const listeners = [['data', onData], ['end', onEnd], ['error', onError], ['aborted', onAborted], ['close', onClose]];
    const timer = setTimeout(() => fail(408, 'REQUEST_TIMEOUT'), timeoutMs);
    for (const [event, listener] of listeners) req.on(event, listener);
    if (req.aborted || req.destroyed) onAborted();
    else if (Number(req.headers?.['content-length']) > maxBytes) fail(413, 'PAYLOAD_TOO_LARGE');
  });
}
