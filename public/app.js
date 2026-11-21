import { selectLut, output8, mapPixels } from './mapping.js';

const $ = (id) => document.getElementById(id);
let model = null;
let indices = [0, 0, 0];
const previous = { main: [0, 0, 0], touch: [0, 0, 0] };
let source;
let devices = { windows: [], intel: [] };
let token;
let busy = false;
let hardwareActive = false;
let loadSequence = 0;
let statusError = '';

function fail(error) {
  $('error').textContent = error.message ?? String(error);
  $('error').hidden = false;
}
function clearError() { $('error').hidden = true; }
async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function tintName(t) { return t === 0 ? 'sRGB' : `Tint ${t}`; }
function selection() { return selectLut(model, indices); }

async function load() {
  const loadId = ++loadSequence;
  clearError();
  $('confirm').checked = false;
  model = null;
  buttons();
  const kind = $('kind').value;
  try {
    const loaded = await api(`/api/lut?kind=${kind}`);
    if (loadId !== loadSequence) return;
    model = loaded;
    indices = previous[kind].map((v, i) => Math.min(v, model.dimensions[i] - 1));
    const [B, T, A] = model.dimensions;
    $('metadata').textContent = `${model.filename} · ${model.product} / ${model.display}`;
    $('counts').textContent = `${B} × ${T} × ${A} = ${model.luts.length} 组 Ambient`;
    const neutral = model.luts.every(({ rows }) =>
      rows[0].every((v, i) => v === rows[1][i] && v === rows[2][i]));
    const identicalTints = kind === 'main' && model.luts.every(({ rows }, index) => {
      const reference = model.luts[Math.floor(index / (T * A)) * T * A + index % A].rows;
      return rows.every((row, c) => row.every((v, i) => v === reference[c][i]));
    });
    $('dataInsight').textContent = identicalTints
      ? `当前 XML 的 ${T} 个 Tint 层在同一 BlackLevel / Ambient 下，RGB 表逐项完全相同${neutral ? '，且 R=G=B' : ''}。因此只改 Tint 不会改变本工具的 RGB 预览或显卡 LUT；仍会选到不同 Ambient，lcdBacklight / customLutData 可不同。原系统另外发送面板色温命令，本工具只展示、不发送它们。`
      : neutral ? '当前 XML 的 R/G/B 表相同，曲线重合并非绘图错误。选表后仍需检查该 Ambient 的亮度与面板命令。'
      : '当前 XML 包含不同的 R/G/B 表。通道独立查表可改变颜色平衡；曲线与像素读数均取自文件，不额外添加 Tint 效果。';
    $('blackLabel').hidden = kind === 'touch';
    $('tintLabel').hidden = kind === 'touch';
    $('matrixTitle').textContent = kind === 'touch' ? '一维坐标 → 一组触屏 Ambient' : '三维坐标 → 一组 Ambient';
    $('matrixHelp').textContent = kind === 'touch'
      ? '触屏只使用 AmbientLight 索引，选择自己的 RGB 表。点击格子切换 Low / Med / High；不串联主屏校正。'
      : 'AmbientLight 向右，BlackLevel 向上，Tint 向右上方深入。每个平面是一个 Tint 层，每个点是一整套 Ambient 数据；点击点同时选择三个坐标。立体投影只辅助理解选表，不做 knob 插值或相乘。';
    $('pipelineKnobs').textContent = kind === 'touch' ? 'AmbientLight knob' : '三个 knob';
    $('knobHelp').textContent = kind === 'touch'
      ? '触屏 XML 只有 AmbientLight（Low / Med / High）。不复用主屏的 BlackLevel 与 Tint，两个文件不串联。'
      : 'UI BlackLevel 1 起始；Tint sRGB 对应索引 0；AmbientLight 1 起始。下面的公式使用零基索引。';
    ['black', 'tint', 'ambient'].forEach((id, i) => { $(id).max = model.dimensions[i] - 1; });
    render();
  } catch (error) {
    if (loadId !== loadSequence) return;
    $('metadata').textContent = 'XML 读取失败；旧预览不再可用于硬件写入。';
    fail(error);
  }
}
function choose(next) {
  indices = next;
  previous[$('kind').value] = [...next];
  render();
}
function render() {
  if (!model) return;
  const { index, lut } = selection();
  const [b, t, a] = indices;
  ['black', 'tint', 'ambient'].forEach((id, i) => { $(id).value = indices[i]; });
  $('blackValue').textContent = `${b + 1} / index ${b}`;
  $('tintValue').textContent = `${tintName(t)} / index ${t}`;
  $('ambientValue').textContent = `${a + 1} / index ${a}`;
  $('backlight').textContent = lut.backlight === null ? '未提供' : `${lut.backlight} (${Math.round(lut.backlight * 100)}%)`;
  $('custom').textContent = `customLutData: ${lut.customLutData || '(empty)'}\ncustomInitData: ${model.customInitData || '(empty)'}\nfullScaleLumens: ${model.fullScaleLumens ?? '(not provided; UltVMQ default 250)'}`;
  const [, T, A] = model.dimensions;
  $('formula').textContent = model.kind === 'touch'
    ? `TouchScreenIndex = ${a} → AmbientValues / Ambient[${a}]（第 ${a + 1} 组）`
    : `[BlackLevel, Tint, Ambient] = [${b}, ${t}, ${a}]\nindex = ${a} + ${t} × ${A} + ${b} × (${A} × ${T}) = ${index}（第 ${index + 1} 组）`;
  matrix();
  curve();
  sample();
  pixel();
  preview();
  buttons();
}
function matrix() {
  const [B, T, A] = model.dimensions;
  const tabs = $('tintTabs');
  tabs.replaceChildren();
  tabs.hidden = model.kind === 'touch';
  for (let t = 0; t < T; t++) {
    const tab = node('button', tintName(t), t === indices[1] ? 'selected' : '');
    tab.title = `Tint 层 ${t}（零基索引）`;
    tab.addEventListener('click', () => choose([indices[0], t, indices[2]]));
    tabs.append(tab);
  }
  if (model.kind === 'main') {
    matrix3d();
    return;
  }
  const grid = node('div', undefined, 'matrix-grid');
  grid.style.gridTemplateColumns = `65px repeat(${A}, minmax(36px, 1fr))`;
  const axes = node('span', model.kind === 'touch' ? 'A →' : 'BL ↓ / A →', 'axis');
  axes.title = 'BlackLevel（行） / AmbientLight（列），UI 档位从 1 开始';
  grid.append(axes);
  for (let a = 0; a < A; a++) grid.append(node('span', `A${a + 1}`, 'axis'));
  for (let b = 0; b < B; b++) {
    grid.append(node('span', model.kind === 'touch' ? 'Touch' : `BL ${b + 1}`, 'axis'));
    for (let a = 0; a < A; a++) {
      const { index, lut } = selectLut(model, [b, indices[1], a]);
      const cell = node('button', ['Low', 'Med', 'High'][a] ?? `A${a + 1}`, b === indices[0] && a === indices[2] ? 'cell selected' : 'cell');
      const spark = node('span', undefined, 'spark');
      const color = lut.rows.map((row) => output8(row[128]));
      spark.style.backgroundColor = `rgb(${color.join(',')})`;
      cell.append(spark);
      cell.title = `indices [${b},${indices[1]},${a}] · R[128]=${lut.rows[0][128]} · lcdBacklight ${lut.backlight ?? 'none'}`;
      cell.setAttribute('aria-label', model.kind === 'touch'
        ? `Touch screen Ambient ${a + 1}, index ${index}`
        : `BlackLevel ${b + 1}, ${tintName(indices[1])}, Ambient ${a + 1}, index ${index}`);
      cell.addEventListener('click', () => choose([b, indices[1], a]));
      grid.append(cell);
    }
  }
  $('matrix').replaceChildren(grid);
}
function matrix3d() {
  const [B, T, A] = model.dimensions;
  const [selectedB, selectedT, selectedA] = indices;
  const svgNode = (tag, attributes, text) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const project = (b, t, a) => ({
    x: 62 + a / Math.max(1, A - 1) * 324 + t / Math.max(1, T - 1) * 124,
    y: 262 - b / Math.max(1, B - 1) * 150 - t / Math.max(1, T - 1) * 72
  });
  const svg = svgNode('svg', { viewBox: '0 0 640 300', class: 'matrix-3d', role: 'group', 'aria-label': 'BlackLevel、Tint、AmbientLight 三维选表' });
  const line = (parent, from, to, className) => parent.append(svgNode('line', {
    x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: className
  }));
  for (let t = T - 1; t >= 0; t--) {
    const plane = svgNode('g', { class: t === selectedT ? 'lut-plane active' : 'lut-plane' });
    const corners = [[0, t, 0], [0, t, A - 1], [B - 1, t, A - 1], [B - 1, t, 0]]
      .map((coordinate) => project(...coordinate));
    plane.append(svgNode('polygon', { points: corners.map(({ x, y }) => `${x},${y}`).join(' ') }));
    for (let b = 0; b < B; b++) line(plane, project(b, t, 0), project(b, t, A - 1), 'plane-grid');
    for (let a = 0; a < A; a++) line(plane, project(0, t, a), project(B - 1, t, a), 'plane-grid');
    const edge = project(0, t, A - 1);
    plane.append(svgNode('text', { x: edge.x + 14, y: edge.y + 4, class: 'layer-label' }, tintName(t)));
    svg.append(plane);
  }
  for (const b of [0, B - 1]) {
    for (const a of [0, A - 1]) line(svg, project(b, 0, a), project(b, T - 1, a), 'depth-edge');
  }
  line(svg, project(0, 0, 0), { x: 411, y: 262 }, 'axis-ambient');
  line(svg, project(0, 0, 0), { x: 62, y: 94 }, 'axis-black');
  const tintEnd = project(0, T - 1, A - 1);
  line(svg, project(0, 0, A - 1), { x: tintEnd.x + 24, y: tintEnd.y - 14 }, 'axis-tint');
  svg.append(
    svgNode('text', { x: 220, y: 293, class: 'axis-label axis-ambient' }, 'AmbientLight →'),
    svgNode('text', { x: 14, y: 85, class: 'axis-label axis-black' }, 'BlackLevel ↑'),
    svgNode('text', { x: tintEnd.x + 28, y: tintEnd.y - 20, class: 'axis-label axis-tint' }, 'Tint ↗')
  );
  for (let a = 0; a < A; a++) {
    const p = project(0, 0, a);
    svg.append(svgNode('text', { x: p.x, y: p.y + 16, class: 'axis-tick', 'text-anchor': 'middle' }, a + 1));
  }
  for (let b = 0; b < B; b++) {
    const p = project(b, 0, 0);
    svg.append(svgNode('text', { x: p.x - 12, y: p.y + 4, class: 'axis-tick', 'text-anchor': 'end' }, b + 1));
  }
  const selected = project(selectedB, selectedT, selectedA);
  const depthBase = project(0, selectedT, 0);
  const columnBase = project(0, selectedT, selectedA);
  line(svg, project(0, 0, 0), depthBase, 'coordinate-guide');
  line(svg, depthBase, columnBase, 'coordinate-guide');
  line(svg, columnBase, selected, 'coordinate-guide');
  // Render the active layer last so its points remain easy to select.
  const layers = Array.from({ length: T }, (_, t) => t).filter((t) => t !== selectedT);
  layers.push(selectedT);
  for (const t of layers) {
    for (let b = 0; b < B; b++) {
      for (let a = 0; a < A; a++) {
        const { index, lut } = selectLut(model, [b, t, a]);
        const current = b === selectedB && t === selectedT && a === selectedA;
        const p = project(b, t, a);
        const point = svgNode('circle', {
          cx: p.x, cy: p.y, r: current ? 6 : 4,
          class: `lut-point${t === selectedT ? ' active' : ''}${current ? ' selected' : ''}`,
          tabindex: '0', role: 'button', 'aria-pressed': String(current),
          'aria-label': `BlackLevel ${b + 1}, ${tintName(t)}, Ambient ${a + 1}, index ${index}`,
          'data-coordinates': `${b},${t},${a}`
        });
        point.append(svgNode('title', {}, `BlackLevel ${b + 1} · ${tintName(t)} · AmbientLight ${a + 1}\nR[128]=${lut.rows[0][128]} · lcdBacklight ${lut.backlight ?? 'none'}`));
        const activate = () => {
          choose([b, t, a]);
          $('matrix').querySelector(`[data-coordinates="${b},${t},${a}"]`).focus({ preventScroll: true });
        };
        point.addEventListener('click', activate);
        point.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          }
        });
        svg.append(point);
      }
    }
  }
  $('matrix').replaceChildren(svg);
}
function curve() {
  if (!model) return;
  const canvas = $('curve');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const { rows, backlight } = selection().lut;
  const left = 70, top = 15, right = W - 65, bottom = H - 38;
  const x = (i) => left + i / 255 * (right - left);
  const y = (v) => bottom - v / 65535 * (bottom - top);
  const backlightY = (value) => bottom - value * (bottom - top);
  const percent = backlight === null ? null : Number((backlight * 100).toFixed(2));
  $('curveBacklight').textContent = backlight === null
    ? 'lcdBacklight：XML 未提供'
    : `lcdBacklight ${backlight} · ${percent}%`;
  canvas.setAttribute('aria-label', backlight === null
    ? 'RGB Gamma transfer curves; XML has no lcdBacklight'
    : `RGB Gamma transfer curves (left axis); lcdBacklight ${percent}% (independent right axis)`);
  ctx.clearRect(0, 0, W, H);
  ctx.font = '12px Segoe UI';
  ctx.textAlign = 'right';
  for (let step = 0; step <= 4; step++) {
    const value = Math.round(65535 * step / 4);
    ctx.strokeStyle = '#293747'; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke();
    ctx.fillStyle = '#9eaec3'; ctx.fillText(value, left - 10, y(value) + 4);
  }
  ctx.textAlign = 'center';
  for (const i of [0, 64, 128, 192, 255]) ctx.fillText(i, x(i), H - 12);
  rows.forEach((row, c) => {
    ctx.strokeStyle = ['#ff7484', '#75e4ac', '#81acff'][c];
    ctx.lineWidth = [3, 2, 1][c];
    ctx.beginPath();
    row.forEach((v, i) => {
      if (i === 0) ctx.moveTo(x(i), y(v * 2));
      else ctx.lineTo(x(i), y(v * 2));
    });
    ctx.stroke();
  });
  if (backlight !== null) {
    ctx.fillStyle = '#efbb72'; ctx.textAlign = 'left';
    for (const value of [0, .5, 1]) ctx.fillText(`${value * 100}%`, right + 10, backlightY(value) + 4);
    ctx.strokeStyle = '#efbb72'; ctx.lineWidth = 1.5; ctx.setLineDash([8, 4]);
    ctx.beginPath(); ctx.moveTo(left, backlightY(backlight)); ctx.lineTo(right, backlightY(backlight)); ctx.stroke();
  }
  const i = Number($('sample').value);
  ctx.lineWidth = 1; ctx.strokeStyle = '#6be2d1'; ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(x(i), top); ctx.lineTo(x(i), bottom); ctx.stroke();
  ctx.setLineDash([]);
  rows.forEach((row, c) => {
    ctx.fillStyle = ['#ff7484', '#75e4ac', '#81acff'][c];
    ctx.beginPath();
    ctx.arc(x(i), y(row[i] * 2), [4, 2.8, 1.5][c], 0, Math.PI * 2);
    ctx.fill();
  });
}
function sample() {
  if (!model) return;
  const { rows } = selection().lut;
  const i = Number($('sample').value);
  $('sampleValue').textContent = i;
  $('sampleRows').replaceChildren(...rows.map((row, c) => {
    const card = node('div', undefined, 'sample-card');
    card.append(node('span', `${'RGB'[c]} · XML ${row[i]}`, ['red', 'green', 'blue'][c]));
    card.append(node('b', `${row[i] * 2}`));
    card.title = `输入索引 ${i} · XML ${row[i]} × 2 → 16-bit API ${row[i] * 2}`;
    card.append(node('small', `8-bit 预览 ≈ ${output8(row[i])} / 255`));
    return card;
  }));
  const fragment = document.createDocumentFragment();
  for (let n = 0; n < 256; n++) {
    const tr = node('tr', undefined, n === i ? 'current' : '');
    tr.append(node('td', n));
    rows.forEach((row) => tr.append(node('td', `${row[n]} / ${row[n] * 2}`)));
    fragment.append(tr);
  }
  $('rawRows').replaceChildren(fragment);
}
function pixel() {
  if (!model) return;
  const values = ['pixelR', 'pixelG', 'pixelB'].map((id) => Number($(id).value));
  if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    $('pixelResult').textContent = '每个输入必须是 0–255 的整数';
    return;
  }
  const rows = selection().lut.rows;
  const raw = values.map((v, c) => rows[c][v]);
  $('pixelResult').textContent = `RGB(${values.join(', ')}) → API16(${raw.map((v) => v * 2).join(', ')}) → 预览 RGB(${raw.map(output8).join(', ')})`;
}
function pattern() {
  const canvas = $('before'), ctx = canvas.getContext('2d');
  const data = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const patternY = y * 320 / canvas.height;
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      let rgb;
      if (patternY < 64) {
        const gray = Math.round(x / (canvas.width - 1) * 255);
        rgb = [gray, gray, gray];
      } else if (patternY < 112) {
        const gray = Math.floor(x / canvas.width * 16) * 17;
        rgb = [gray, gray, gray];
      } else if (patternY < 160) {
        const gray = Math.floor(x / canvas.width * 16) * 2;
        rgb = [gray, gray, gray];
      } else if (patternY < 224) {
        const colors = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255],[255,255,255],[128,128,128]];
        rgb = colors[Math.min(7, Math.floor(x / canvas.width * 8))];
      } else {
        const nx = x / canvas.width - .5, ny = (patternY - 224) / 96;
        const sector = Math.abs(nx) < ny * .65;
        const speckle = ((x * 1103515245 + y * 12345) >>> 8) % 75;
        const tissue = 32 + speckle + 55 * Math.sin(x / 60 + patternY / 18) ** 2;
        rgb = Array(3).fill(sector ? Math.round(tissue) : 0);
      }
      data.data.set([...rgb, 255], i);
    }
  }
  source = data;
  preview();
}
function preview() {
  if (!source) return;
  $('before').getContext('2d').putImageData(source, 0, 0);
  const pixels = model && !hardwareActive ? mapPixels(source.data, selection().lut.rows) : new Uint8ClampedArray(source.data);
  $('after').getContext('2d').putImageData(new ImageData(pixels, source.width, source.height), 0, 0);
  $('afterCaption').textContent = hardwareActive ? '硬件试用中 / 不再叠加软件 LUT' : '按 XML 查表 / 软件近似预览';
}
async function image(file) {
  if (!file) return;
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = $('before'), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const w = bitmap.width * scale, h = bitmap.height * scale;
    ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    source = ctx.getImageData(0, 0, canvas.width, canvas.height);
    preview();
  } finally { bitmap.close(); }
}
function options(select, entries, empty) {
  const previousId = select.value;
  select.replaceChildren();
  if (!entries.length) select.append(new Option(empty, ''));
  entries.forEach((entry) => select.append(new Option(entry.label, entry.id)));
  if (entries.some((entry) => entry.id === previousId)) select.value = previousId;
}
function displayOptions() {
  options($('display'), devices[$('backend').value === 'intel' ? 'intel' : 'windows'], '接口无可用设备');
  options($('brightnessDisplay'), devices.windows, '无 Windows 显示器');
  buttons();
}
function capability() {
  const intel = $('backend').value === 'intel';
  const gamma = (intel ? devices.intel : devices.windows).find(d => d.id === $('display').value);
  const brightness = devices.windows.find(d => d.id === $('brightnessDisplay').value);
  return {
    gammaError: intel
      ? (gamma ? null : devices.intelError ?? 'Intel CUI 未枚举到连接的显示器。')
      : (gamma ? gamma.gammaError ?? null : '未枚举到 Windows 显示器。'),
    gammaSupported: Boolean(gamma && (intel || gamma.gammaSupported === true)),
    brightnessError: brightness?.brightnessError ?? null,
    brightnessSupported: brightness?.brightnessSupported === true
  };
}
async function refreshDisplays() {
  busy = true; buttons();
  try {
    devices = await api('/api/displays');
    $('capabilities').textContent = `${devices.windows.length} 个桌面显示目标；其中 ${devices.windows.filter(d => d.gammaSupported).length} 个可读取 GDI Gamma，${devices.windows.filter(d => d.remote).length} 个远程虚拟目标；${devices.intel.length} 个 Intel UID。${devices.intelError ?? 'Intel CUI 接口已创建。'} 不支持时不自动换接口。`;
  } catch (error) {
    devices = { windows: [], intel: [] };
    $('capabilities').textContent = error.message;
  } finally { busy = false; displayOptions(); }
}
function buttons() {
  const caps = capability();
  $('gammaCapability').textContent = caps.gammaError ?? (caps.gammaSupported ? '原始 Gamma 可读取；实际写入支持仍需显式试用及读回验证。' : '请刷新设备能力；未确认支持，禁止写入。');
  $('brightnessCapability').textContent = caps.brightnessError ?? (caps.brightnessSupported ? '非远程目标；DDC/CI 支持将在试用时先读取验证，不保证面板支持。' : '此目标不可用于物理面板亮度试用。');
  const enabled = Boolean(model && token && $('confirm').checked && !busy && !statusError);
  $('applyGamma').disabled = !enabled || !caps.gammaSupported;
  $('applyBrightness').disabled = !enabled || !caps.brightnessSupported || selection().lut.backlight === null;
  $('restore').disabled = busy || !token;
}
function updateStatus(state) {
  const previouslyActive = hardwareActive;
  hardwareActive = Boolean(state.active || state.unknown);
  statusError = state.error ?? '';
  $('modeBadge').textContent = state.unknown
    ? '硬件状态未知 · 软件查表暂停'
    : hardwareActive ? '真实硬件试用 · 软件查表暂停' : '软件预览 · 未在试用硬件';
  const seconds = state.expires ? Math.max(0, Math.ceil((Date.parse(state.expires) - Date.now()) / 1000)) : 0;
  $('hardwareStatus').textContent = state.error
    ? `错误：${state.error}`
    : hardwareActive ? `原值已保存；${seconds} 秒后自动恢复。` : '无活动试用；未写入或已完成恢复。';
  if (previouslyActive !== hardwareActive) preview();
  buttons();
}
async function hardware(action) {
  clearError(); busy = true; buttons();
  try {
    const payload = action === 'restore' ? { action } : {
      action, kind: $('kind').value, indices, digest: model.digest,
      backend: $('backend').value,
      display: $(action === 'brightness' ? 'brightnessDisplay' : 'display').value,
      confirm: $('confirm').checked
    };
    updateStatus(await api('/api/hardware', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-LUT-Token': token },
      body: JSON.stringify(payload)
    }));
  } catch (error) {
    fail(error);
    try { updateStatus(await api('/api/status')); }
    catch (statusFailure) { fail(new Error(`${error.message}\n状态读取失败：${statusFailure.message}`)); }
  } finally { busy = false; buttons(); }
}
['black', 'tint', 'ambient'].forEach((id, axis) => $(id).addEventListener('input', () => {
  if (model) { const next = [...indices]; next[axis] = Number($(id).value); choose(next); }
}));
$('kind').addEventListener('change', load);
$('reload').addEventListener('click', load);
$('sample').addEventListener('input', () => { curve(); sample(); });
['pixelR', 'pixelG', 'pixelB'].forEach((id) => $(id).addEventListener('input', pixel));
$('pattern').addEventListener('click', pattern);
$('image').addEventListener('change', () => image($('image').files[0]).catch(fail));
$('backend').addEventListener('change', () => { $('confirm').checked = false; displayOptions(); });
['display', 'brightnessDisplay'].forEach((id) => $(id).addEventListener('change', () => { $('confirm').checked = false; buttons(); }));
$('confirm').addEventListener('change', buttons);
$('refreshDisplays').addEventListener('click', refreshDisplays);
$('applyGamma').addEventListener('click', () => hardware('gamma'));
$('applyBrightness').addEventListener('click', () => hardware('brightness'));
$('restore').addEventListener('click', () => hardware('restore'));

pattern();
await load();
try { token = (await api('/api/session')).token; }
catch (error) { fail(error); }
await refreshDisplays();
setInterval(async () => {
  try { updateStatus(await api('/api/status')); }
  catch (error) {
    statusError = error.message;
    // Unknown hardware state must not re-enable software correction or writes.
    hardwareActive = true;
    $('modeBadge').textContent = '硬件状态未知 · 软件查表暂停';
    preview();
    $('hardwareStatus').textContent = `无法读取硬件状态：${error.message}。请检查服务器/桥接器恢复记录。`;
    buttons();
  }
}, 1000);
