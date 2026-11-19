// Pure TypeScript PNG generator (no Node zlib dependency, runs identically in Browser & Node)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(buf: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStore(raw: Uint8Array): Uint8Array {
  // Valid RFC1950 zlib stream using uncompressed DEFLATE blocks (max 65535 bytes/block)
  const maxBlock = 65535;
  const numBlocks = Math.max(1, Math.ceil(raw.length / maxBlock));
  const out = new Uint8Array(2 + numBlocks * 5 + raw.length + 4);
  let offset = 0;
  out[offset++] = 0x78;
  out[offset++] = 0x01;

  for (let i = 0; i < numBlocks; i++) {
    const start = i * maxBlock;
    const end = Math.min(raw.length, start + maxBlock);
    const len = end - start;
    const nlen = (~len) & 0xffff;
    const isFinal = i === numBlocks - 1 ? 1 : 0;

    out[offset++] = isFinal;
    out[offset++] = len & 0xff;
    out[offset++] = (len >>> 8) & 0xff;
    out[offset++] = nlen & 0xff;
    out[offset++] = (nlen >>> 8) & 0xff;
    out.set(raw.subarray(start, end), offset);
    offset += len;
  }

  const adler = adler32(raw);
  out[offset++] = (adler >>> 24) & 0xff;
  out[offset++] = (adler >>> 16) & 0xff;
  out[offset++] = (adler >>> 8) & 0xff;
  out[offset++] = adler & 0xff;
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return chunk;
}

export function generatePngIconBytes(size: number): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  const cornerR = size * 0.22;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = Math.max(0, cornerR - Math.min(x, size - 1 - x));
      const dy = Math.max(0, cornerR - Math.min(y, size - 1 - y));
      const inRoundedRect = dx * dx + dy * dy <= cornerR * cornerR;

      if (!inRoundedRect) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      const nx = x / size;
      const ny = y / size;
      const isTopBar = ny >= 0.24 && ny <= 0.36 && nx >= 0.24 && nx <= 0.76;
      const isStem = nx >= 0.44 && nx <= 0.56 && ny >= 0.24 && ny <= 0.76;

      if (isTopBar || isStem) {
        raw[px] = 255;
        raw[px + 1] = 255;
        raw[px + 2] = 255;
        raw[px + 3] = 255;
      } else {
        const t = y / size;
        raw[px] = Math.round(11 + t * 4);
        raw[px + 1] = Math.round(107 - t * 14);
        raw[px + 2] = Math.round(203 - t * 20);
        raw[px + 3] = 255;
      }
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, size, false);
  ihdrView.setUint32(4, size, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const c1 = pngChunk('IHDR', ihdr);
  const c2 = pngChunk('IDAT', zlibStore(raw));
  const c3 = pngChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let pos = 0;
  out.set(sig, pos); pos += sig.length;
  out.set(c1, pos); pos += c1.length;
  out.set(c2, pos); pos += c2.length;
  out.set(c3, pos);
  return out;
}
