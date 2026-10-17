// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）。
import { diffState, isStateKind } from '../../shared/stateDelta.js';

// One encoder per Match. Public state is shared; private streams are player-owned.
// Only the latest snapshot is retained. A socket missing its predecessor gets a full frame.
export class WorkerStateEncoder {
  constructor() { this.streams = new Map(); this.sequence = 0; }

  encode(kind, encoded, playerId = '') {
    if (!isStateKind(kind) || typeof encoded !== 'string') return undefined;
    const stream = kind === 'm.public' ? kind : `${kind}:${playerId}`;
    const previous = this.streams.get(stream);
    if (previous?.encoded === encoded) return previous.frame;
    const seq = ++this.sequence;
    const view = JSON.parse(encoded);
    const full = `{"t":"m.state","kind":${JSON.stringify(kind)},"seq":${seq},"full":${encoded}}`;
    const patch = previous && diffState(previous.view, view);
    const candidate = patch && JSON.stringify({ t: 'm.state', kind, seq, base: previous.frame.seq, patch });
    const frame = { stream, seq, base: previous?.frame.seq,
      delta: candidate && Buffer.byteLength(candidate) < Buffer.byteLength(full) ? candidate : null };
    this.streams.set(stream, { encoded, view, frame });
    return frame;
  }
}
