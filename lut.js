import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { selectLut } from './public/mapping.js';

const bridgePath = fileURLToPath(new URL('./native/bin/Release/net9.0-windows/LUTBridge.exe', import.meta.url));
function decodeXml(xml) {
  const process = spawnSync(bridgePath, ['--parse-xml'], {
    input: xml, encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024
  });
  if (process.error) throw new Error(`XML parser unavailable: ${process.error.message}. Run npm run build:native.`);
  if (process.status !== 0) throw new Error(`Invalid XML: ${process.stderr.trim()}`);
  return JSON.parse(process.stdout);
}

function integer(value, label, min, max) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${label}: expected integer`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label}: out of range`);
  return n;
}

export function parseLut(xml, filename) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD/entities are not supported');
  const document = decodeXml(xml);
  const ts = Boolean(document.TSCorrectionLUT);
  const root = ts ? document.TSCorrectionLUT : document.CorrectionLut;
  if (!root) throw new Error('Expected CorrectionLut or TSCorrectionLUT root');
  const config = ts ? root.Description?.TSLUTConfiguration : root.Description?.AmbientLight;
  const dimensions = [
    ts ? 1 : integer(config?.ActiveBlackLevelIndexes, 'BlackLevel count', 1, 32),
    ts ? 1 : integer(config?.ActiveColorTempIndexes, 'Tint count', 1, 32),
    integer(config?.ActiveBrightnessIndexes, 'Ambient count', 1, 32)
  ];
  const [blackCount, tintCount, ambientCount] = dimensions;
  function ambient(node, coordinate) {
    if (!node || typeof node !== 'object') throw new Error(`Missing Ambient ${coordinate}`);
    const rows = ['rowR', 'rowG', 'rowB'].map((channel) => {
      if (typeof node[channel] !== 'string') throw new Error(`Missing ${channel} at ${coordinate}`);
      const row = node[channel].trim().split(/[\s,]+/);
      if (row.length !== 256) throw new Error(`${channel} ${coordinate}: expected 256 entries, got ${row.length}`);
      return row.map((v) => integer(v, `${channel} ${coordinate}`, 0, 32767));
    });
    if (node.lcdBacklight !== undefined &&
        (typeof node.lcdBacklight !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(node.lcdBacklight)))
      throw new Error(`Invalid lcdBacklight at ${coordinate}`);
    const backlight = node.lcdBacklight === undefined ? null : Number(node.lcdBacklight);
    if (backlight !== null && (!Number.isFinite(backlight) || backlight < 0 || backlight > 1))
      throw new Error(`Invalid lcdBacklight at ${coordinate}`);
    return { rows, backlight, customLutData: node.customLutData ?? '' };
  }
  const luts = [];
  if (ts) {
    if (root.AmbientValues?.Ambient?.length !== ambientCount) throw new Error('TS Ambient count mismatch');
    root.AmbientValues.Ambient.forEach((node, a) => luts.push(ambient(node, `[0,0,${a}]`)));
  } else {
    const blacks = root.AmbientValues?.BlackLevel;
    if (blacks?.length !== blackCount) throw new Error('BlackLevel count mismatch');
    blacks.forEach((black, b) => {
      if (black.ColorTemp?.length !== tintCount) throw new Error(`Tint count mismatch at BlackLevel ${b}`);
      black.ColorTemp.forEach((tint, t) => {
        if (tint.Ambient?.length !== ambientCount) throw new Error(`Ambient count mismatch at [${b},${t}]`);
        tint.Ambient.forEach((node, a) => luts.push(ambient(node, `[${b},${t},${a}]`)));
      });
    });
  }
  return {
    filename, kind: ts ? 'touch' : 'main', dimensions, luts,
    digest: createHash('sha256').update(xml).digest('hex'),
    product: root.Description?.Product ?? '',
    display: root.Description?.DisplayVersion ?? '',
    description: config?.AmbientLightDescription ?? '',
    fullScaleLumens: root.Description?.fullScaleLumens ?? null,
    customInitData: root.Description?.customInitData ?? ''
  };
}

export function nativeSelection(model, indices) {
  const { lut, index } = selectLut(model, indices);
  return { index, rows: lut.rows.map((row) => row.map((v) => v * 2)), backlight: lut.backlight };
}
