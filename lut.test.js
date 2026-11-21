import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseLut, nativeSelection } from './lut.js';
import { selectLut, output8, mapPixels } from './public/mapping.js';

const mainXml = await readFile(new URL('./correctionLUT.xml', import.meta.url), 'utf8');
const tsXml = await readFile(new URL('./TSCorrectionLUT.xml', import.meta.url), 'utf8');
const main = parseLut(mainXml, 'correctionLUT.xml');
const touch = parseLut(tsXml, 'TSCorrectionLUT.xml');

test('real main XML maps every 3D coordinate to its exact flat Ambient', () => {
  assert.deepEqual(main.dimensions, [6, 5, 7]);
  assert.equal(main.luts.length, 210);
  let expected = 0;
  for (let b = 0; b < 6; b++)
    for (let t = 0; t < 5; t++)
      for (let a = 0; a < 7; a++)
        assert.equal(selectLut(main, [b, t, a]).index, expected++);
  assert.equal(main.luts[0].rows[0][0], 64);
  assert.equal(main.luts[0].backlight, .53);
  assert.equal(nativeSelection(main, [0, 0, 0]).rows[0][255], 65280);
  assert.equal(nativeSelection(main, [0, 0, 0]).rows[0][0], 128);
});
test('touchscreen uses only its own Ambient index and preserves reduced white output', () => {
  assert.deepEqual(touch.dimensions, [1, 1, 3]);
  assert.equal(touch.luts[0].backlight, null);
  const selected = nativeSelection(touch, [0, 0, 0]);
  assert.equal(selected.rows[0][255], 28626);
  assert.equal(selected.rows[2][255], 31808);
  assert.equal(output8(touch.luts[0].rows[0][255]), 111);
  assert.throws(() => selectLut(touch, [1, 0, 0]));
});
test('rejects wrong shapes, out-of-range indices and invalid XML values', () => {
  for (const indices of [[6,0,0], [0,5,0], [0,0,7], [-1,0,0], [0,.5,0], [0,0], null])
    assert.throws(() => selectLut(main, indices));
  assert.throws(() => parseLut(tsXml.replace('<rowR>0 ', '<rowR>32768 '), 'bad'), /out of range/);
  assert.throws(() => parseLut(tsXml.replace('<rowR>0 63 ', '<rowR>0 '), 'bad'), /256 entries/);
  assert.throws(() => parseLut(mainXml.replace('<lcdBacklight>0.53', '<lcdBacklight>NaN'), 'bad'), /lcdBacklight/);
  assert.throws(() => parseLut(mainXml.replace('<lcdBacklight>0.53</lcdBacklight>', '<lcdBacklight></lcdBacklight>'), 'bad'), /lcdBacklight/);
  assert.throws(() => parseLut(tsXml.replace('>3 </ActiveBrightnessIndexes>', '>2 </ActiveBrightnessIndexes>'), 'bad'), /count mismatch/);
  assert.throws(() => parseLut('<TSCorrectionLUT>', 'bad'), /Invalid XML/);
  assert.throws(() => parseLut('<!DOCTYPE foo><foo/>', 'bad'), /DTD/);
});
test('software preview performs independent per-channel lookup, preserves alpha and input', () => {
  const pixels = new Uint8ClampedArray([0, 128, 255, 91, 255, 0, 128, 255]);
  const rows = touch.luts[0].rows;
  const output = mapPixels(pixels, rows);
  assert.deepEqual([...output], [
    output8(rows[0][0]), output8(rows[1][128]), output8(rows[2][255]), 91,
    output8(rows[0][255]), output8(rows[1][0]), output8(rows[2][128]), 255
  ]);
  assert.deepEqual([...pixels], [0, 128, 255, 91, 255, 0, 128, 255]);
  assert.equal(output8(0), 0);
  assert.equal(output8(32767), 255);
});
