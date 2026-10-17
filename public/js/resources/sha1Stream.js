// 取自 xinhai-ai/Stronghold-Protocol（GPL-3.0-or-later，同本仓库）。
// Small incremental SHA-1 for the <=16 MB transport ZIP response. WebCrypto's
// digest API only accepts a complete buffer; streaming avoids retaining a
// second copy of every package while its stored entries are being unpacked.
export class Sha1Stream {
  constructor() {
    this.state = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    this.block = new Uint8Array(64);
    this.view = new DataView(this.block.buffer);
    this.words = new Uint32Array(80);
    this.blockLength = 0;
    this.bytes = 0;
    this.finished = false;
  }

  update(input) {
    if (this.finished || !(input instanceof Uint8Array)) throw new Error('SHA-1 stream is closed or input is invalid');
    this.bytes += input.byteLength;
    let offset = 0;
    while (offset < input.byteLength) {
      const take = Math.min(64 - this.blockLength, input.byteLength - offset);
      this.block.set(input.subarray(offset, offset + take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 64) {
        this.process(this.block);
        this.blockLength = 0;
      }
    }
    return this;
  }

  process(block) {
    const words = this.words;
    const view = block.buffer === this.block.buffer
      ? this.view : new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, false);
    for (let i = 16; i < 80; i++) {
      const x = words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16];
      words[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = this.state;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const rotate = (a << 5) | (a >>> 27);
      const next = (rotate + f + e + k + words[i]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = next;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
  }

  digest() {
    if (this.finished) throw new Error('SHA-1 stream is closed');
    const bitLength = this.bytes * 8;
    this.block[this.blockLength++] = 0x80;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.process(this.block);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(60, bitLength >>> 0, false);
    this.process(this.block);
    this.finished = true;
    return [...this.state].map((word) => word.toString(16).padStart(8, '0')).join('');
  }
}
