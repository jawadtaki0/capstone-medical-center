// Original geometric Cedar cross artwork, encoded as a Windows ICO without a
// dependency or remote image. BGRA pixels and a transparent rounded silhouette.
function bitmapImage(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const originalX = ((x + 0.5) * 32) / size - 0.5;
      const originalY = ((y + 0.5) * 32) / size - 0.5;
      const cornerX = Math.max(7 - originalX, originalX - 24, 0);
      const cornerY = Math.max(7 - originalY, originalY - 24, 0);
      const visible = cornerX * cornerX + cornerY * cornerY <= 49;
      const cross =
        (originalX >= 13.5 &&
          originalX < 17.5 &&
          originalY >= 6.5 &&
          originalY < 24.5) ||
        (originalY >= 13.5 &&
          originalY < 17.5 &&
          originalX >= 6.5 &&
          originalX < 24.5);
      const index = ((size - 1 - y) * size + x) * 4;
      pixels.set(
        cross ? [255, 255, 255, 255] : [158, 116, 0, visible ? 255 : 0],
        index,
      );
    }
  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (pixels[(y * size + x) * 4 + 3] === 0)
        mask[y * maskStride + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
  const bitmap = Buffer.alloc(40);
  bitmap.writeUInt32LE(40, 0);
  bitmap.writeInt32LE(size, 4);
  bitmap.writeInt32LE(size * 2, 8);
  bitmap.writeUInt16LE(1, 12);
  bitmap.writeUInt16LE(32, 14);
  bitmap.writeUInt32LE(pixels.length + mask.length, 20);
  return Buffer.concat([bitmap, pixels, mask]);
}

export function launcherIcon() {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map(bitmapImage);
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  }
  return Buffer.concat([header, ...images]);
}
