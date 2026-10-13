// Minimal PNG/JPEG header reader, to size images without decoding them.

export function imageSize(b: Uint8Array): { width: number; height: number } {
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u16 = (o: number) => (b[o] << 8) | b[o + 1];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: u32(16), height: u32(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o < b.length) {
      if (b[o] !== 0xff) break;
      const marker = b[o + 1];
      const len = u16(o + 2);
      // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16(o + 7), height: u16(o + 5) };
      }
      o += 2 + len;
    }
  }
  throw new Error('Unsupported image format (use PNG or JPEG)');
}
