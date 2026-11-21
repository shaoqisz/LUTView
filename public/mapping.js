export function selectLut(model, indices) {
  if (!Array.isArray(indices) || indices.length !== 3 ||
      indices.some((v, i) => !Number.isInteger(v) || v < 0 || v >= model.dimensions[i])) {
    throw new Error('Invalid BlackLevel/Tint/Ambient indices');
  }
  const [b, t, a] = indices;
  const [, T, A] = model.dimensions;
  const index = a + t * A + b * A * T;
  return { index, lut: model.luts[index] };
}

export function output8(raw15) {
  return Math.round(raw15 * 2 / 65535 * 255);
}

export function mapPixels(pixels, rows) {
  const result = new Uint8ClampedArray(pixels);
  for (let i = 0; i < result.length; i += 4) {
    for (let c = 0; c < 3; c++) result[i + c] = output8(rows[c][pixels[i + c]]);
  }
  return result;
}
