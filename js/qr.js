// Tiny dependency-free QR encoder (byte mode, ECC level M, versions 1–10,
// fixed mask 0) — enough to turn a join link into a scannable code with no
// build step and no CDN, which is the fleet rule. Pure module: no DOM in
// qrMatrix(), so Node tests can decode its output with a real QR reader.
//
// Implements the standard algorithm (ISO/IEC 18004): Reed–Solomon over
// GF(256), block interleaving, function patterns, BCH-protected format and
// version info. A fixed mask is legal QR — decoders read the mask from the
// format info — it just skips the cosmetic penalty-scoring step.

/* ------------------------------------------------ tables (ECC level M) */

// [version] → total codewords, ecc codewords per block, blocks as [count, dataLen]
const VERSIONS = {
  1: [26, 10, [[1, 16]]],
  2: [44, 16, [[1, 28]]],
  3: [70, 26, [[1, 44]]],
  4: [100, 18, [[2, 32]]],
  5: [134, 24, [[2, 43]]],
  6: [172, 16, [[4, 27]]],
  7: [196, 18, [[4, 31]]],
  8: [242, 22, [[2, 38], [2, 39]]],
  9: [292, 22, [[3, 36], [2, 37]]],
  10: [346, 26, [[4, 43], [1, 44]]],
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

/* --------------------------------------------------------- GF(256) + RS */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gmul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly; // highest-order coefficient first is poly[last]? — see rsRemainder
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);
  for (const b of data) {
    const factor = b ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i++) {
      rem[i] ^= gmul(gen[gen.length - 2 - i], factor);
    }
  }
  return rem;
}

/* ------------------------------------------------------------- encoding */

function toBytes(text) {
  return new TextEncoder().encode(text);
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const [total, ec, blocks] = VERSIONS[v];
    const dataCw = total - ec * blocks.reduce((a, [n]) => a + n, 0);
    const countBits = v <= 9 ? 8 : 16;
    const needBits = 4 + countBits + byteLen * 8;
    if (needBits <= dataCw * 8) return v;
  }
  throw new Error('qr: text too long');
}

function buildCodewords(bytes, version) {
  const [total, ecLen, blocks] = VERSIONS[version];
  const dataCw = total - ecLen * blocks.reduce((a, [n]) => a + n, 0);
  const countBits = version <= 9 ? 8 : 16;

  const bits = [];
  const push = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);                 // byte mode
  push(bytes.length, countBits);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCw * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  }
  for (let pad = 0xec; data.length < dataCw; pad ^= 0xfd) data.push(pad); // ec 11 ec 11 …

  // Split into blocks, compute ECC, interleave.
  const dataBlocks = [];
  const eccBlocks = [];
  let at = 0;
  for (const [count, len] of blocks) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + len);
      at += len;
      dataBlocks.push(block);
      eccBlocks.push(rsRemainder(block, ecLen));
    }
  }
  const out = [];
  const maxLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < ecLen; i++) for (const b of eccBlocks) out.push(b[i]);
  return out;
}

/* ------------------------------------------------------------ the matrix */

function bchFormat() {
  // ECC level M (0b00) + mask 0 → 5 data bits, BCH(15,5), standard XOR mask.
  const fmt = 0b00000;
  let rem = fmt << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) rem ^= 0b10100110111 << (i - 10);
  }
  return ((fmt << 10) | rem) ^ 0b101010000010010;
}

function bchVersion(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
  return (version << 12) | rem;
}

export function qrMatrix(text) {
  const bytes = toBytes(text);
  const version = pickVersion(bytes.length);
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = !!v; fn[r][c] = true; };

  // finders + separators
  for (const [fr, fc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = fr + r;
        const cc = fc + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = r >= 0 && r <= 6 && c >= 0 && c <= 6
          && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, inRing);
      }
    }
  }
  // timing
  for (let i = 8; i < size - 8; i++) {
    if (!fn[6][i]) set(6, i, i % 2 === 0);
    if (!fn[i][6]) set(i, 6, i % 2 === 0);
  }
  // alignment — every grid position except the three finder corners
  const pos = ALIGN[version];
  const last = pos.length - 1;
  pos.forEach((cr, ri) => {
    pos.forEach((cc, ci) => {
      if ((ri === 0 && ci === 0) || (ri === 0 && ci === last) || (ri === last && ci === 0)) return;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          set(cr + r, cc + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
        }
      }
    });
  });
  // format info (both copies, per ISO 18004 figure 25) + the dark module
  const fmt = bchFormat();
  const fbit = (i) => (fmt >>> i) & 1;
  for (let i = 0; i <= 5; i++) set(i, 8, fbit(i));
  set(7, 8, fbit(6));
  set(8, 8, fbit(7));
  set(8, 7, fbit(8));
  for (let i = 9; i <= 14; i++) set(8, 14 - i, fbit(i));
  for (let i = 0; i <= 7; i++) set(8, size - 1 - i, fbit(i));
  for (let i = 8; i <= 14; i++) set(size - 15 + i, 8, fbit(i));
  set(size - 8, 8, true);
  // version info (v7+)
  if (version >= 7) {
    const vb = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const bit = (vb >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  // zigzag data placement, then mask 0 on data modules only
  const codewords = buildCodewords(bytes, version);
  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (fn[r][c]) continue;
        let bit = 0;
        if (bitIdx < codewords.length * 8) {
          bit = (codewords[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        m[r][c] = bit === 1;
        if ((r + c) % 2 === 0) m[r][c] = !m[r][c]; // mask 0
      }
    }
  }
  return m;
}

/** Render as a crisp SVG string (dark modules on a quiet-zone-padded field). */
export function qrSvg(text, { margin = 4 } = {}) {
  const m = qrMatrix(text);
  const size = m.length;
  const dim = size + margin * 2;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (m[r][c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" `
    + `shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/>`
    + `<path d="${path}" fill="#000"/></svg>`;
}
