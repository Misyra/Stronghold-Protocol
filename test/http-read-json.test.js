import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readJsonBody } from '../server/http/readJson.js';

function request(headers = {}) {
  const req = new EventEmitter();
  Object.assign(req, { headers, complete: false, destroyed: false, resumed: false });
  req.resume = () => { req.resumed = true; };
  return req;
}
function clean(req) {
  for (const event of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(req.listenerCount(event), 0, event);
}

test('JSON reader handles Unicode split across chunks and cleans up after success', async () => {
  const req = request(), bytes = Buffer.from('{"name":"博士😀"}');
  const pending = readJsonBody(req, { maxBytes: bytes.length });
  for (const byte of bytes) req.emit('data', Buffer.from([byte]));
  req.complete = true; req.emit('end');
  assert.deepEqual(await pending, { name: '博士😀' });
  assert.equal(req.resumed, false); clean(req);
});

test('both declared and chunked sizes are bounded by bytes and leave a response possible', async () => {
  for (const declared of [false, true]) {
    const req = request(declared ? { 'content-length': '100' } : {});
    const pending = readJsonBody(req, { maxBytes: 4 });
    const rejected = assert.rejects(pending, { status: 413, code: 'PAYLOAD_TOO_LARGE' });
    if (!declared) { req.emit('data', Buffer.from('博')); req.emit('data', Buffer.from('士')); }
    await rejected;
    assert.equal(req.resumed, true); assert.equal(req.destroyed, false); clean(req);
  }
});

test('invalid JSON returns a stable error with the original parse error attached', async () => {
  const req = request(), pending = readJsonBody(req, { maxBytes: 32 });
  req.emit('data', Buffer.from('{oops')); req.complete = true; req.emit('end');
  await assert.rejects(pending, (error) => error.status === 400 && error.code === 'INVALID_JSON' && error.cause instanceof SyntaxError);
  clean(req);
});

test('unfinished request times out; subsequent data/end cannot change its outcome', async () => {
  const req = request();
  await assert.rejects(readJsonBody(req, { maxBytes: 32, timeoutMs: 10 }), { status: 408, code: 'REQUEST_TIMEOUT' });
  req.emit('data', Buffer.from('{}')); req.emit('end');
  assert.equal(req.resumed, true); clean(req);
});

test('abort, premature close and stream error settle and release listeners', async () => {
  for (const event of ['aborted', 'close', 'error']) {
    const req = request(), pending = readJsonBody(req, { maxBytes: 32 });
    req.emit(event, event === 'error' ? new Error('socket failed') : undefined);
    await assert.rejects(pending, { status: 400, code: 'REQUEST_ABORTED' });
    clean(req);
  }
});

test('an already aborted stream and invalid reader limits do not leave a timer or listener', async () => {
  const req = request(); req.aborted = true;
  await assert.rejects(readJsonBody(req, { maxBytes: 32 }), { code: 'REQUEST_ABORTED' });
  clean(req);
  for (const options of [{}, { maxBytes: 0 }, { maxBytes: 32, timeoutMs: 0 }]) assert.throws(() => readJsonBody(request(), options), RangeError);
});
