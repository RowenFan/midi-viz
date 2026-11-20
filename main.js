// MIDI 驱动的钢琴可视化：琴键 → 上升光柱 + 频谱极光；顶部大谱表滚动，音符过播放线时点亮、谱线起涟漪。
// 所有画面只由时间 t 决定（粒子除外，按帧推进），以后可逐帧渲染成视频。
// 地址参数：from=开始秒数（默认 108）  noaudio=1 不出声直接播  render=1 逐帧渲染模式（暴露 window.renderAt）
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const Q = new URLSearchParams(location.search);
const FROM = parseFloat(Q.get('from') ?? '108');
const NOAUDIO = Q.has('noaudio');
const RENDER = Q.has('render');
const LIVE = Q.has('live');   // 实时模式：接电钢琴 MIDI（没琴时可用电脑键盘 A–K 测试）
const OVERLAY = Q.has('overlay'); // 叠加模式：纯黑底、不画虚拟琴，特效按标定贴到实拍画面里的真琴上（OBS 里用「滤色」叠加）
if (OVERLAY) document.body.classList.add('overlay');

const SONG = LIVE ? { duration: 0, notes: [], pedal: [] } : window.SONG;
const NOTES = SONG.notes;
if (LIVE) document.body.classList.add('live');

// ---------- 设置（面板里改，自动存到本机） ----------
const DEFAULTS = {
  title: LIVE ? '' : '月光 Clair de Lune', sub: LIVE ? '' : '克洛德·德彪西 · 《贝加莫组曲》第三首', handle: '',
  font: 'sans', palette: OVERLAY ? 'rainbow' : 'moon', colorMode: OVERLAY ? 'gradient' : 'harmony', chord: true, staff: !OVERLAY, spectrum: true, aurora: !OVERLAY, keysig: true, arcs: false, flares: true, labels: true, info: true, caption: '', rise: 2.4, glow: 1,
  style: 'blocks', smoke: true, pulse: true, keyline: true,
};
const SKEY = 'midiviz.settings.' + (OVERLAY ? 'overlay' : LIVE ? 'live' : 'song');
const S = { ...DEFAULTS };
try { Object.assign(S, JSON.parse(localStorage.getItem(SKEY) || '{}')); } catch (e) { /* 无痕窗口等情况读不到，用默认值 */ }
const $ = (id) => document.getElementById(id);
const panel = $('panel');
function applyText() {
  $('tTitle').textContent = S.title; $('tSub').textContent = S.sub; $('tHandle').textContent = S.handle;
  $('caption').textContent = S.caption; $('info').hidden = $('stats').hidden = !S.info;
  document.body.classList.toggle('serif', S.font === 'serif');
}
for (const el of panel.elements) {
  if (!(el.name in S)) continue;
  if (el.type === 'checkbox') el.checked = !!S[el.name]; else el.value = S[el.name];
}
panel.addEventListener('input', (e) => {
  const el = e.target; if (!(el.name in S)) return;
  S[el.name] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? +el.value : el.value;
  try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (err) { /* 存不了就只在本次生效 */ }
  applyText();
});
panel.addEventListener('submit', (e) => e.preventDefault());
applyText();
$('credit').hidden = LIVE;
const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target.tagName);
$('gear').addEventListener('click', () => { panel.hidden = !panel.hidden; });
addEventListener('keydown', (e) => { if (!typing(e) && (e.key === 'p' || e.key === 'P')) panel.hidden = !panel.hidden; });
// 鼠标停 3 秒：隐藏齿轮、状态和光标（面板开着时不隐藏）
let idleTimer = 0;
const wake = () => { document.body.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (panel.hidden) document.body.classList.add('idle'); }, 3000); };
addEventListener('mousemove', wake); wake();

// ---------- 踏板：算出每个音实际发声到什么时候 ----------
function pedalEnd(t) {
  for (const [a, b] of SONG.pedal) if (t >= a && t < b) return b;
  return t;
}
for (const n of NOTES) {
  n.off = n.t + n.d;
  n.ring = Math.max(n.off, pedalEnd(n.off)); // 发声结束（含踏板延音）
  n.vv = Math.min(1, n.v / 0.45);            // 力度归一：这份 MIDI 力度整体偏小
}

// ---------- 音高 → 键位 x / 谱表 y ----------
const isBlack = (p) => [1, 3, 6, 8, 10].includes(p % 12);
let LO = LIVE ? +(Q.get('lo') ?? 21) : Math.min(...NOTES.map(n => n.p)) - 2;
let HI = LIVE ? +(Q.get('hi') ?? 108) : Math.max(...NOTES.map(n => n.p)) + 2;
while (isBlack(LO)) LO--; while (isBlack(HI)) HI++;
const WIDTH = 8.6;
const whiteIdx = {}; let nW = 0;
for (let p = LO; p <= HI; p++) if (!isBlack(p)) whiteIdx[p] = nW++;
const WW = WIDTH / nW;
const keyX = (p) => isBlack(p) ? -WIDTH / 2 + (whiteIdx[p - 1] + 1) * WW : -WIDTH / 2 + (whiteIdx[p] + 0.5) * WW;

// 降号拼写（降 D 大调）：黑键记作上方字母的降音
const STEP = [0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6];
const diat = (p) => Math.floor(p / 12) * 7 + STEP[p % 12];
const D_MIDC = diat(60);
const STAFF_Y = 3.85, HALF = 0.115;         // 中央 C 的高度、谱表半格
const staffY = (p) => STAFF_Y + (diat(p) - D_MIDC) * HALF;

// ---------- 和声配色：五度圈上的音级重心 → 色相 ----------
const FIFTH = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]; // 音级在五度圈上的位置
const HUE_FPS = 20;
const hueTrack = (() => {
  const len = Math.ceil(SONG.duration * HUE_FPS) + 1, out = new Float32Array(len);
  const home = 2 * Math.PI * FIFTH[1] / 12;   // Db
  let cx = Math.cos(home), cy = Math.sin(home), j0 = 0;
  for (let i = 0; i < len; i++) {
    const t = i / HUE_FPS; let x = 0, y = 0;
    while (j0 < NOTES.length && NOTES[j0].ring < t - 3) j0++;
    for (let j = j0; j < NOTES.length && NOTES[j].t <= t; j++) {
      const n = NOTES[j]; if (n.ring < t - 0.2) continue;
      const w = n.vv * Math.exp(-(t - n.t) / 1.5) * (n.h === 'L' ? 1.6 : 1);
      const a = 2 * Math.PI * FIFTH[n.p % 12] / 12;
      x += w * Math.cos(a); y += w * Math.sin(a);
    }
    cx += (x - cx) * 0.06; cy += (y - cy) * 0.06;   // 平滑，避免颜色乱跳
    let d = Math.atan2(cy, cx) - home; d = Math.atan2(Math.sin(d), Math.cos(d));
    out[i] = (0.68 + d / (2 * Math.PI) * 0.9 + 1) % 1;  // 主调 = 月光蓝紫
  }
  return out;
})();
// 实时模式没法预先算，按同样的方法逐帧平滑
const live = { cx: Math.cos(2 * Math.PI * FIFTH[1] / 12), cy: Math.sin(2 * Math.PI * FIFTH[1] / 12) };
function hueLive(t, dt) {
  const home = 2 * Math.PI * FIFTH[1] / 12; let x = 0, y = 0;
  for (const n of NOTES) {
    if (n.ring < t - 0.2) continue;
    const w = n.vv * Math.exp(-(t - n.t) / 1.5) * (n.h === 'L' ? 1.6 : 1), a = 2 * Math.PI * FIFTH[n.p % 12] / 12;
    x += w * Math.cos(a); y += w * Math.sin(a);
  }
  const k = 1 - Math.exp(-dt * 1.2);
  live.cx += (x - live.cx) * k; live.cy += (y - live.cy) * k;
  let d = Math.atan2(live.cy, live.cx) - home; d = Math.atan2(Math.sin(d), Math.cos(d));
  return (0.68 + d / (2 * Math.PI) * 0.9 + 1) % 1;
}
const hueAt = (t) => hueTrack[Math.max(0, Math.min(hueTrack.length - 1, Math.round(t * HUE_FPS)))];
const tmpC = new THREE.Color();
const hsl = (h, s, l) => tmpC.setHSL(((h % 1) + 1) % 1, s, l).clone();

// ---------- 配色方案 + 上色方式 ----------
// 每套配色是一条从"低/冷"到"高/暖"的渐变；上色方式决定每个音取渐变上的哪个位置（0..1）
const PALETTES = {
  moon:    ['#4a63ff', '#7d78ff', '#b49aff', '#efc7ff'],   // 月光：深蓝 → 雾紫 → 淡粉紫（不到纯白，免得辉光一叠就发白）
  aurora:  ['#00d9a3', '#22b8ff', '#6f7dff', '#c08cff'],   // 极光：青绿 → 冰蓝 → 紫
  sunset:  ['#ff3d6e', '#ff7a59', '#ffb35c', '#ffe3a3'],   // 落日：玫红 → 橘 → 暖金
  neon:    ['#00e1ff', '#5b5bff', '#c03bff', '#ff3d9a'],   // 霓虹：电青 → 靛 → 品红
  glacier: ['#2f5bff', '#4aa3ff', '#8fe1ff', '#eafcff'],   // 冰川：深海蓝 → 冰白
  gold:    ['#a8641f', '#e09a3e', '#ffd27a', '#fff3d6'],   // 鎏金：古铜 → 金 → 香槟
  sakura:  ['#ff6f9a', '#ffa3bd', '#e3a6ff', '#b9b2ff'],   // 樱：樱红 → 粉 → 薰衣草
  jade:    ['#0f8f6f', '#2ccf9a', '#a7f0c8', '#f0fff4'],   // 青玉：墨绿 → 玉 → 月白
  rainbow: ['#ff3b5c', '#ff9a1f', '#ffe14d', '#3dff8a', '#22d3ff', '#6a5cff', '#e04dff'],   // 彩虹：按音高从红到紫
  magenta: ['#c21cff', '#ff2fd0', '#ff6ae0', '#ffb3f2'],   // 霓虹粉
  amber:   ['#ff5a00', '#ff9500', '#ffc53d', '#ffe9a8'],   // 琥珀
  ice:     ['#0066ff', '#00a8ff', '#3fe0ff', '#b8f6ff'],   // 冰蓝
  lime:    ['#00c46a', '#2bff88', '#a6ff4d', '#eaff9e'],   // 荧光绿
};
const PAL_C = Object.fromEntries(Object.entries(PALETTES).map(([k, v]) => [k, v.map(h => new THREE.Color(h))]));
function samplePal(s, out) {
  const st = PAL_C[S.palette] || PAL_C.moon, x = Math.min(1, Math.max(0, s)) * (st.length - 1), i = Math.min(st.length - 2, Math.floor(x));
  return out.copy(st[i]).lerp(st[i + 1], x - i);
}
const pitchS = (p) => (p - LO) / Math.max(1, HI - LO);
let gS = 0.5, harmS = 0.5;   // 整体颜色在渐变上的位置（平滑过的）
// 某个音在渐变上的位置
function noteS(p, vv, h, t) {
  switch (S.colorMode) {
    case 'gradient': return pitchS(p);                                                   // 音高渐变：低音冷、高音暖
    case 'segment': { const n = (PAL_C[S.palette] || PAL_C.moon).length;                  // 音区分段：几段纯色
      return Math.min(n - 1, Math.floor(pitchS(p) * n)) / (n - 1); }
    case 'velocity': return Math.pow(vv, 1.2);                                            // 力度：轻冷重暖
    case 'hands': return h === 'L' ? 0.12 : 0.88;                                          // 左右手两种颜色
    case 'flow': return 0.5 + 0.5 * Math.sin(2 * Math.PI * (t / 14 + pitchS(p) * 0.6));     // 流动：颜色沿琴键缓缓流过
    case 'single': return 0.55;
    default: return Math.min(1, Math.max(0, harmS + (h === 'R' ? 0.12 : -0.1)));           // 和声：随和声走
  }
}
const NC = new THREE.Color();
const noteCol = (n, t) => samplePal(noteS(n.p, n.vv, n.h, t), NC);

// 整体响度包络（给背景和镜头用）
const loudAt = (t) => {
  let s = 0;
  for (const n of NOTES) { if (n.t > t) break; if (n.ring + 1 < t) continue; s += n.vv * Math.exp(-(t - n.t) / 0.6); }
  return Math.min(1.5, s / 3);
};

// ---------- 渲染器 ----------
const stage = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: RENDER });
renderer.setPixelRatio(RENDER ? 1 : Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
stage.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#04050c');
const FOV = 40;
// 叠加模式用正交相机，单位 = 画面像素（y 朝上），方便和实拍画面一一对应
const camera = OVERLAY ? new THREE.OrthographicCamera(0, 1, 1, 0, -1000, 1000) : new THREE.PerspectiveCamera(FOV, 9 / 16, 0.1, 200);
if (OVERLAY) camera.position.set(0, 0, 100);
const CAM_Z = 8.3 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(512, 910), 0.9, 0.45, 0.4);
if (OVERLAY) { bloom.radius = 0.05; bloom.threshold = 0.6; }   // 叠加到实拍上：只让最亮的芯起辉光，别把整个画面染色
if (!Q.has('nobloom')) composer.addPass(bloom);
composer.addPass(new OutputPass());

let CW = 1, CH = 1;   // 画面的 CSS 尺寸
function resize() {
  let w, h;
  if (RENDER) { w = +(Q.get('w') ?? 1080); h = Math.round(w * 16 / 9); }
  else { const r = stage.getBoundingClientRect(); w = r.width; h = r.height; }
  renderer.setSize(w, h, false); composer.setSize(w, h);
  CW = w; CH = h;
  bgMat.uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  ptsMat.uniforms.uProj.value = h * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
  if (OVERLAY) {
    VW = w; VH = h;
    camera.right = w; camera.top = h; camera.updateProjectionMatrix();
    ptsMat.uniforms.uProj.value = 100 * renderer.getPixelRatio();   // 点的大小直接按像素算
    const kh = h / 16.6 * 0.55;                                       // 谱表缩小放在画面上方
    hud3d.scale.set(kh, kh, 1); hud3d.position.set(w * 0.5, h * 0.86 - STAFF_Y * kh, 0);
    drawCalib();
  }
}

scene.add(new THREE.AmbientLight(0x8090c0, 0.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4); keyLight.position.set(-3, 6, 8); scene.add(keyLight);

// ---------- 背景：星尘 + 底光 ----------
const bgMat = new THREE.ShaderMaterial({
  depthWrite: false,
  uniforms: { uCol: { value: new THREE.Color() }, uCol2: { value: new THREE.Color() }, uLoud: { value: 0 }, uT: { value: 0 }, uAur: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
  fragmentShader: `uniform vec3 uCol; uniform vec3 uCol2; uniform float uLoud; uniform float uT; uniform float uAur; uniform vec2 uRes;
    float n2(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
      return mix(mix(n2(i), n2(i+vec2(1,0)), f.x), mix(n2(i+vec2(0,1)), n2(i+vec2(1,1)), f.x), f.y); }
    float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 4; i++){ v += a*vnoise(p); p *= 2.03; a *= .5; } return v; }
    vec3 aurora(vec2 uv){
      // 竖向光帘：横向被噪声扭动，竖向有细丝，随时间缓慢流动
      float xw = uv.x*2.2 + fbm(vec2(uv.x*1.5, uT*.04))*1.6 + uT*.015;
      float curtain = pow(.5 + .5*sin(xw*6.2831), 2.5);
      float strands = .55 + .45*fbm(vec2(uv.x*14. + uT*.05, uv.y*1.2 - uT*.08));
      float band = smoothstep(.36, .52, uv.y) * (1. - smoothstep(.62, .9, uv.y + .08*sin(uv.x*5. + uT*.1)));
      vec3 c = mix(uCol, uCol2, smoothstep(.4, .8, uv.y));
      return c * curtain * strands * band;
    }
    void main(){
      vec2 vUv = gl_FragCoord.xy / uRes;                                  // 屏幕坐标，0..1
      vec2 p = (vUv - vec2(.5, .14)) * vec2(1.4, 2.6);
      float g = exp(-dot(p, p) * 3.0);                                    // 琴键上方的光晕
      vec2 q = (vUv - vec2(.5, .79)) * vec2(1.0, 4.5);
      float s = exp(-dot(q, q) * 2.5);                                    // 谱表后方的光带
      float wave = .5 + .5*sin(vUv.x*6.0 + uT*.3) * sin(vUv.y*4.0 - uT*.2);
      vec3 c = uCol * (g * (.05 + .16*uLoud) + s * (.025 + .04*wave));
      c += aurora(vUv) * uAur * (.05 + .14*uLoud);
      c += vec3(.006,.007,.018);
      c += (n2(vUv*900.0 + uT) - .5) * .012;                              // 颗粒，防色带
      gl_FragColor = vec4(c, 1.);
    }`,
});
const bg = new THREE.Mesh(new THREE.PlaneGeometry(60, 80), bgMat);
bg.position.z = -18; scene.add(bg);

// 粒子（星尘 + 火花共用一个点精灵材质）
const ptsMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uProj: { value: 1000 } },
  vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA; uniform float uProj;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.); vC = color; vA = alpha;
      gl_PointSize = size * uProj / -mv.z; gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `varying vec3 vC; varying float vA;
    void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, 0., d); a *= a;
      gl_FragColor = vec4(vC, a * vA); }`,
});
function makePoints(n) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n), 1));
  const pts = new THREE.Points(g, ptsMat); pts.frustumCulled = false; scene.add(pts); return pts;
}
// 伪随机（可复现）
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const STARS = 1400, stars = makePoints(STARS), starBase = [];
for (let i = 0; i < STARS; i++) starBase.push([(rnd() - .5) * 26, (rnd() - .5) * 40, -2 - rnd() * 14, rnd(), 0.03 + rnd() * 0.07]);

// ---------- 琴键 ----------
const KEY_Y = -6.2, KEY_LEN = 1.5, BLACK_LEN = 0.95;
const keyboard = new THREE.Group();
keyboard.position.set(0, KEY_Y, 0); keyboard.rotation.x = 0.62; scene.add(keyboard);
const keys = {};
for (let p = LO; p <= HI; p++) {
  const b = isBlack(p);
  const geo = new THREE.BoxGeometry(b ? WW * 0.58 : WW * 0.93, b ? 0.16 : 0.12, b ? BLACK_LEN : KEY_LEN);
  const mat = new THREE.MeshStandardMaterial({ color: b ? 0x0b0c12 : 0x9aa0b4, roughness: b ? 0.35 : 0.5, metalness: 0.1, emissive: 0x000000 });
  const m = new THREE.Mesh(geo, mat);
  m.position.set(keyX(p), b ? 0.1 : 0, (b ? BLACK_LEN : KEY_LEN) / 2);
  m.userData = { baseY: m.position.y, black: b };
  keyboard.add(m); keys[p] = m;
}
// 琴键后沿的发光线
const rail = new THREE.Mesh(new THREE.PlaneGeometry(WIDTH + 0.4, 0.035), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending }));
rail.position.set(0, KEY_Y + 0.09, 0.02); scene.add(rail);
// 叠加模式：真琴、真背景都来自摄像头，这里只留光
if (OVERLAY) for (const o of [bg, stars, keyboard, rail]) o.visible = false;

// ---------- 上升光柱 ----------
const FADE_TOP = 3.0;          // 光柱在这里消散成谱表下方的雾
const BAR_BASE = KEY_Y + 0.08;
const FADE_H = OVERLAY ? 7 : FADE_TOP - BAR_BASE;   // 光柱离开琴键多高后消失（世界单位）

// ---------- 映射层：普通模式 = 画面里的虚拟琴；叠加模式 = 实拍画面里的真琴 ----------
// 琴键面看成一个平面：u 沿琴键 0..1（最低音左沿 → 最高音右沿），v 从前沿 0 到后沿 1。
// 标定的四个角（画面归一化坐标，y 朝下）：左前、右前、右后、左后。
const KEY_DEPTH = WIDTH * 0.15 / 1.22;    // 键长约 15cm、88 键宽约 1.22m，换成同一单位
const V_BASE = 0.9;                       // 光柱从靠近后沿的位置升起
const CAL_KEY = 'midiviz.calib';
let CAL = [[.291, .773], [.839, .414], [.805, .384], [.235, .665]];
try { const c = JSON.parse(localStorage.getItem(CAL_KEY)); if (Array.isArray(c) && c.length === 4) CAL = c; } catch (e) { /* 没存过 */ }
let VW = 1, VH = 1, HG = null;
function solveH() {
  // 单位正方形 → 任意四边形的透视变换（Heckbert 闭式解）
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = CAL;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  HG = { a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0, d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0, g, h };
}
solveH();
const planeN = (u, v) => { const w = HG.g * u + HG.h * v + 1; return [(HG.a * u + HG.b * v + HG.c) / w, (HG.d * u + HG.e * v + HG.f) / w]; };
const planePx = (u, v) => { const [x, y] = planeN(u, v); return { x: x * VW, y: (1 - y) * VH }; };
const uOf = (x) => (x + WIDTH / 2) / WIDTH;
// 琴键坐标 x（世界单位）→ 光柱起点在画面上的位置，k = 该处每个世界单位等于多少像素
function basePt(x) {
  if (!OVERLAY) return { x, y: BAR_BASE, k: 1 };
  const u = uOf(x), a = planePx(u - 0.004, V_BASE), b = planePx(u + 0.004, V_BASE), c = planePx(u, V_BASE);
  return { x: c.x, y: c.y, k: Math.hypot(b.x - a.x, b.y - a.y) / (0.008 * WIDTH) };
}

const barMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uFade: { value: FADE_H }, uStyle: { value: 1 }, uPad: { value: 0.3 } },
  // aBase = (光柱底端的画面 y, 每世界单位多少像素)；aSize = 光柱本体的宽、高（世界单位，不含外圈辉光）
  vertexShader: `attribute vec2 aBase; attribute vec2 aSize; varying vec2 vUv; varying vec3 vC; varying float vH; varying vec2 vSize;
    void main(){ vUv = uv; vC = instanceColor; vSize = aSize; vec4 w = modelMatrix * instanceMatrix * vec4(position,1.);
      vH = (w.y - aBase.x) / aBase.y;                                    // 离开琴键的高度（世界单位）
      gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `varying vec2 vUv; varying vec3 vC; varying float vH; varying vec2 vSize; uniform float uFade; uniform float uStyle; uniform float uPad;
    float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
    void main(){
      float rise = 1. - smoothstep(uFade * .45, uFade, vH);             // 越往上越淡
      float birth = 1. + 1.4 * exp(-vH * 4.);                            // 刚出琴键最亮
      if (uStyle < .5) {                                                 // 细光丝（旧样式）
        float x = vUv.x - .5; float core = exp(-x*x*260.), halo = exp(-x*x*22.);
        float head = smoothstep(.0, .08, 1. - vUv.y), tail = smoothstep(0., .25, vUv.y);
        gl_FragColor = vec4(vC * (core * 1.25 + halo * .45) * head * mix(.35, 1., tail) * rise * birth, 1.); return;
      }
      vec2 full = vSize + 2. * uPad, p = (vUv - .5) * full;            // 以光柱中心为原点（世界单位）
      float r = uStyle > 1.5 ? min(vSize.x, vSize.y) * .22 : vSize.x * .5;   // 方块：小圆角；光柱：胶囊
      float d = sdBox(p, vSize * .5, r);
      float aa = vSize.x * .06;
      float fill = smoothstep(aa, -aa, d);
      float glow = exp(-max(d, 0.) / (uPad * .22)) * smoothstep(uPad, uPad * .4, d);   // 外圈辉光，到四边前衰减到 0
      float cx = p.x / (vSize.x * .5);
      float core = exp(-cx * cx * 2.2) * fill;                          // 中间一道发白的芯
      vec3 hot = mix(vC, vec3(1.), .55);
      vec3 c = vC * fill * .85 + hot * core * .9 + vC * glow * .55;
      gl_FragColor = vec4(c * rise * birth, 1.);
    }`,
});
const MAX_BARS = 600;
const bars = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), barMat, MAX_BARS);
bars.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 3), 3);
const barBase = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 2), 2);
bars.geometry.setAttribute('aBase', barBase);
const barSize = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BARS * 2), 2);
bars.geometry.setAttribute('aSize', barSize);
bars.frustumCulled = false; scene.add(bars);

// 叠加模式：真琴上被按下的键直接亮起来（按标定把键面四边形投到画面上）
const MAX_GLOW = 40;
const glowGeo = new THREE.BufferGeometry();
glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_GLOW * 4 * 3), 3));
glowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_GLOW * 4 * 3), 3));
{ const idx = []; for (let i = 0; i < MAX_GLOW; i++) { const a = i * 4; idx.push(a, a + 1, a + 2, a, a + 2, a + 3); } glowGeo.setIndex(idx); }
const keyGlow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
keyGlow.frustumCulled = false; keyGlow.visible = OVERLAY; scene.add(keyGlow);

// ---------- 频谱极光（与琴键对齐：每个音落在自己的键位，带泛音） ----------
const SPEC_N = 320;
const specGeo = new THREE.BufferGeometry();
const specPos = new Float32Array(SPEC_N * 2 * 3), specCol = new Float32Array(SPEC_N * 2 * 3), specIdx = [];
for (let i = 0; i < SPEC_N - 1; i++) { const a = i * 2; specIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
specGeo.setIndex(specIdx);
specGeo.setAttribute('position', new THREE.BufferAttribute(specPos, 3));
specGeo.setAttribute('color', new THREE.BufferAttribute(specCol, 3));
// 频谱填充：底部亮、往上渐隐，带一道道横向扫描线（像 LED 电平表）
const specH = new Float32Array(SPEC_N * 2);   // 每个顶点离底边的高度（画面单位），用来画扫描线
specGeo.setAttribute('aH', new THREE.BufferAttribute(specH, 1));
const spec = new THREE.Mesh(specGeo, new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, vertexColors: true,
  uniforms: { uStripe: { value: OVERLAY ? 7 : 0.07 } },
  vertexShader: `attribute float aH; varying float vH; varying vec3 vC; void main(){ vH = aH; vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
  fragmentShader: `varying float vH; varying vec3 vC; uniform float uStripe;
    void main(){ float s = fract(vH / uStripe); float led = smoothstep(.0, .12, s) * smoothstep(.72, .55, s);
      gl_FragColor = vec4(vC * (.35 + .65 * led), 1.); }`,
}));
spec.position.z = -0.06; spec.frustumCulled = false; scene.add(spec);

// 发光带：一条有厚度的线，横截面中间白亮、两边是彩色辉光（频谱顶边、琴键后沿光带共用）
const ribbonMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, vertexColors: true,
  vertexShader: `attribute float aV; varying float vV; varying vec3 vC; void main(){ vV = aV; vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
  fragmentShader: `varying float vV; varying vec3 vC;
    void main(){ float core = exp(-vV*vV*40.), halo = exp(-vV*vV*5.) * (1. - vV*vV);
      gl_FragColor = vec4(mix(vC, vec3(1.), .45) * core * 1.2 + vC * halo * .6, 1.); }`,
});
function makeRibbon(n) {
  const g = new THREE.BufferGeometry(), idx = [], av = new Float32Array(n * 2);
  for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  for (let i = 0; i < n; i++) { av[i * 2] = -1; av[i * 2 + 1] = 1; }
  g.setIndex(idx);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
  g.setAttribute('aV', new THREE.BufferAttribute(av, 1));
  const m = new THREE.Mesh(g, ribbonMat); m.frustumCulled = false; scene.add(m); return m;
}
// 第 i 个点：中心 (x, y)，半宽 hw（竖直方向），颜色 c
function setRibbon(m, i, x, y, hw, c) {
  const P = m.geometry.attributes.position, C = m.geometry.attributes.color;
  P.setXYZ(i * 2, x, y - hw, 0); P.setXYZ(i * 2 + 1, x, y + hw, 0);
  C.setXYZ(i * 2, c.r, c.g, c.b); C.setXYZ(i * 2 + 1, c.r, c.g, c.b);
}
const specLine = makeRibbon(SPEC_N);
const HARM = [[0, 1], [12, .5], [19, .32], [24, .22], [28, .14], [31, .1]];
const specVal = new Float32Array(SPEC_N), specSm = new Float32Array(SPEC_N);
const specR = new Float32Array(SPEC_N), specG = new Float32Array(SPEC_N), specB = new Float32Array(SPEC_N);   // 每段频谱的颜色（按发声的音加权）
// 峰值点：每一段频谱的最高点停一下再慢慢落下（电平表那种）
const PEAK_N = 88, peaks = makePoints(PEAK_N), peakV = new Float32Array(PEAK_N), peakHold = new Float32Array(PEAK_N);

// 琴键后沿光带：常亮一条，弹到哪里哪里亮；重音从按下的键沿着光带向两边推出光波
const LINE_N = 240, keyLine = makeRibbon(LINE_N);
const waves = [];   // {u, t0, vv, col}
let pulse = 0;      // 律动：每次起音冲高、随后衰减

// ---------- 大谱表 ----------
const PLAY_X = LIVE ? 3.4 : -2.2, SCROLL = 1.35;   // 实时模式没有"未来的音"，播放线靠右，音符往左流走
const staffGroup = new THREE.Group(); scene.add(staffGroup);
const LINE_D = [37, 39, 41, 43, 45, 25, 27, 29, 31, 33].map(d => d); // E4 G4 B4 D5 F5 / G2 B2 D3 F3 A3（相对 diat）
const STAFF_LINES = [];
const SL_N = 220, X0 = -6, X1 = 6;
for (const d of LINE_D) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SL_N * 2 * 3), 3));
  const idx = []; for (let i = 0; i < SL_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.frustumCulled = false; m.userData = { y: STAFF_Y + (d - D_MIDC) * HALF, treble: d > D_MIDC };
  staffGroup.add(m); STAFF_LINES.push(m);
}
// 播放线
const playhead = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 3.6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending }));
playhead.position.set(PLAY_X, STAFF_Y, 0.01); scene.add(playhead);
const playGlow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 4.2), new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uCol: { value: new THREE.Color() } },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
  fragmentShader: `varying vec2 vUv; uniform vec3 uCol; void main(){ float x=vUv.x-.5, y=vUv.y-.5; float a=exp(-x*x*60.)*exp(-y*y*5.); gl_FragColor=vec4(uCol*a,1.); }`,
}));
playGlow.position.copy(playhead.position); scene.add(playGlow);

// 音符头（椭圆）+ 时值尾巴 + 加线
const headGeo = new THREE.CircleGeometry(0.5, 24); headGeo.scale(1.35, 0.95, 1); headGeo.rotateZ(0.35);
const MAX_HEADS = 500;
const heads = new THREE.InstancedMesh(headGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), MAX_HEADS);
heads.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 3), 3); heads.frustumCulled = false; scene.add(heads);
const tails = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), MAX_HEADS);
tails.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_HEADS * 3), 3); tails.frustumCulled = false; scene.add(tails);
const MAX_LEDGER = 900;
const ledgers = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }), MAX_LEDGER);
ledgers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LEDGER * 3), 3); ledgers.frustumCulled = false; scene.add(ledgers);
const HEAD_S = HALF * 2 * 0.95;
// 谱表相关的东西放进一个组：叠加模式下整体缩小、挪到画面上方
const hud3d = new THREE.Group(); scene.add(hud3d);
hud3d.add(staffGroup, playhead, playGlow, heads, tails, ledgers);
const hudPt = (x, y) => ({ x: hud3d.position.x + x * hud3d.scale.x, y: hud3d.position.y + y * hud3d.scale.y, k: hud3d.scale.x });

// ---------- 火花粒子（按帧推进） ----------
const SPARKS = 5000, sparks = makePoints(SPARKS);
const sp = Array.from({ length: SPARKS }, () => ({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0, k: 1, c: new THREE.Color(), smoke: false, ph: 0, a: 1 }));
let simT = 0;
// 烟：从光柱顶端冒出、打着旋往上飘、越飘越大越淡
function emitSmoke(x, y, n, col, k) {
  for (let i = 0; i < n; i++) {
    const s = sp[spHead]; spHead = (spHead + 1) % SPARKS;
    s.smoke = true; s.k = k; s.ph = rnd() * 100;
    s.x = x + (rnd() - .5) * 0.12 * k; s.y = y; s.z = 0;
    s.vx = (rnd() - .5) * 0.3 * k; s.vy = (0.5 + rnd() * 0.6) * k; s.vz = 0;
    s.max = s.life = 1.2 + rnd() * 1.4; s.s = (0.05 + rnd() * 0.06) * k; s.a = 0.45;
    s.c.copy(col).lerp(WHITE, 0.25);
  }
}
const WHITE = new THREE.Color(1, 1, 1);
let spHead = 0;
// k：世界单位 → 当前坐标的比例（叠加模式下是像素）
function emit(x, y, z, n, col, speed, size, spread, k = 1) {
  speed *= k; size *= k; spread *= k;
  for (let i = 0; i < n; i++) {
    const s = sp[spHead]; spHead = (spHead + 1) % SPARKS;
    const a = rnd() * Math.PI * 2, r = rnd();
    s.k = k; s.smoke = false; s.a = 1;
    s.x = x + (rnd() - .5) * spread; s.y = y; s.z = z + (rnd() - .5) * 0.2;
    s.vx = Math.cos(a) * r * speed * 0.6; s.vy = (0.4 + rnd()) * speed; s.vz = Math.sin(a) * r * speed * 0.4;
    s.max = s.life = 0.7 + rnd() * 1.3; s.s = size * (0.5 + rnd()); s.c.copy(col).multiplyScalar(0.8 + rnd() * 0.8);
  }
}
function stepSparks(dt) {
  const P = sparks.geometry.attributes;
  for (let i = 0; i < SPARKS; i++) {
    const s = sp[i];
    if (s.life > 0) {
      s.life -= dt;
      if (s.smoke) {
        // 两层正弦拼出的旋涡流场，看起来像烟丝在扭
        const q = s.y / s.k;
        s.vx += (Math.sin(q * 1.7 + s.ph + simT * 1.3) + 0.6 * Math.sin(q * 3.9 - simT * 2.1 + s.ph * 1.7)) * 1.6 * s.k * dt;
        s.vx *= 1 - 1.5 * dt; s.vy *= 1 - 0.25 * dt; s.s *= 1 + 0.55 * dt;
      } else { s.vy += 0.6 * s.k * dt; s.vx *= 1 - 1.2 * dt; s.vz *= 1 - 1.2 * dt; s.vy *= 1 - 0.6 * dt; }
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    }
    const k = Math.max(0, s.life / s.max);
    P.position.setXYZ(i, s.x, s.y, s.z); P.color.setXYZ(i, s.c.r, s.c.g, s.c.b);
    if (s.smoke) { P.size.setX(i, s.s); P.alpha.setX(i, s.a * k * Math.min(1, (s.max - s.life) * 6)); }
    else { P.size.setX(i, s.s * (0.4 + 0.6 * k)); P.alpha.setX(i, k * k); }
  }
  for (const k of ['position', 'color', 'size', 'alpha']) P[k].needsUpdate = true;
}

// ---------- 每帧 ----------
const M4 = new THREE.Matrix4(), Q0 = new THREE.Quaternion(), V3 = new THREE.Vector3(), S3 = new THREE.Vector3();
let lastT = null;

// ---------- 击键星芒：按下的瞬间，键位上闪一下十字星光 ----------
const flareMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `varying vec2 vUv; varying vec3 vC; void main(){ vUv = uv; vC = instanceColor;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position,1.); }`,
  fragmentShader: `varying vec2 vUv; varying vec3 vC;
    void main(){ vec2 p = (vUv - .5) * 2.;
      float core = exp(-dot(p,p) * 18.);
      float h = exp(-abs(p.y) * 60.) * exp(-abs(p.x) * 2.2);     // 横向长光
      float v = exp(-abs(p.x) * 60.) * exp(-abs(p.y) * 4.);      // 竖向短光
      float d = exp(-abs(p.x - p.y) * 40.) * exp(-length(p) * 5.) + exp(-abs(p.x + p.y) * 40.) * exp(-length(p) * 5.);
      gl_FragColor = vec4(vC * (core * 2. + h * .9 + v * .5 + d * .25), 1.); }`,
});
const MAX_FLARE = 48;
const flares = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), flareMat, MAX_FLARE);
flares.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLARE * 3), 3);
flares.frustumCulled = false; scene.add(flares);
const flareList = []; // {x, y, k, vv, col, t0}
function spawnFlare(B, vv, col, t) {
  if (!S.flares) return;
  flareList.push({ x: B.x, y: B.y, k: B.k, vv, col: col.clone(), t0: t });
  if (flareList.length > MAX_FLARE) flareList.shift();
}
function stepFlares(t) {
  let n = 0;
  for (const f of flareList) {
    const age = t - f.t0; if (age < 0 || age > 0.45) continue;
    const k = Math.pow(1 - age / 0.45, 2), sz = (0.5 + 1.1 * f.vv) * f.k * (0.7 + 0.5 * Math.sqrt(age / 0.45));
    M4.compose(V3.set(f.x, f.y, 0.2), Q0, S3.set(sz * 1.8, sz, 1));
    flares.setMatrixAt(n, M4); flares.setColorAt(n, tmpC.copy(f.col).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(k * (0.25 + 0.55 * f.vv))); n++;
  }
  flares.count = n; flares.instanceMatrix.needsUpdate = true; if (n) flares.instanceColor.needsUpdate = true;
}

// ---------- 和弦光弧：同时按下的几个音之间拉起一道道光弧 ----------
const ARC_N = 40, MAX_ARCS = 24;
const arcs = Array.from({ length: MAX_ARCS }, () => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_N * 2 * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ARC_N * 2 * 3), 3));
  const idx = []; for (let i = 0; i < ARC_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.frustumCulled = false; m.visible = false; m.userData = { pa: 0, pb: 0, t0: -9, col: new THREE.Color() }; scene.add(m); return m;
});
let arcHead = 0;
function chordArcs(n, t, col) {
  if (!S.arcs) return;
  // 找 80 毫秒内一起按下的、离它最近的低一个音，连一道弧
  let best = null;
  for (let i = NOTES.length - 1; i >= 0; i--) {
    const m = NOTES[i]; if (m.t < n.t - 0.08) break;
    if (m === n || m.t > n.t || m.p >= n.p) continue;
    if (!best || m.p > best.p) best = m;
  }
  if (!best) return;
  const a = arcs[arcHead]; arcHead = (arcHead + 1) % MAX_ARCS;
  Object.assign(a.userData, { pa: best.p, pb: n.p, t0: t }); a.userData.col.copy(col); a.visible = true;
}
function stepArcs(t) {
  for (const a of arcs) {
    const age = t - a.userData.t0;
    if (!a.visible || age < 0 || age > 1.2) { a.visible = false; continue; }
    const A = basePt(keyX(a.userData.pa)), B = basePt(keyX(a.userData.pb));
    const dist = Math.hypot(B.x - A.x, B.y - A.y), k = (A.k + B.k) / 2;
    const lift = Math.min(dist * 0.55, 2.2 * k) + 0.25 * k;               // 弧高：音程越大越高
    const grow = Math.min(1, age / 0.18), fade = Math.pow(1 - age / 1.2, 1.5);
    const P = a.geometry.attributes.position, C = a.geometry.attributes.color, w = 0.035 * k;
    for (let i = 0; i < ARC_N; i++) {
      const s = i / (ARC_N - 1) * grow;
      const x = A.x + (B.x - A.x) * s, y = A.y + (B.y - A.y) * s + Math.sin(Math.PI * s) * lift;
      // 法线方向近似取竖直，线宽随透视缩放
      P.setXYZ(i * 2, x, y - w, 0.15); P.setXYZ(i * 2 + 1, x, y + w, 0.15);
      const head = Math.exp(-Math.pow((s - grow) * 6, 2));               // 弧的前端更亮
      const c = tmpC.copy(a.userData.col).multiplyScalar(fade * (0.5 + 1.6 * head));
      C.setXYZ(i * 2, c.r, c.g, c.b); C.setXYZ(i * 2 + 1, c.r, c.g, c.b);
    }
    P.needsUpdate = C.needsUpdate = true;
  }
}

// ---------- 调性识别（Krumhansl 音级分布，按最近 20 秒左右加权） ----------
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const KEY_MAJ = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const KEY_MIN = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];
function corr(x, prof, r) {
  let mx = 0, mp = 0; for (let i = 0; i < 12; i++) { mx += x[i]; mp += prof[i]; } mx /= 12; mp /= 12;
  let num = 0, dx = 0, dp = 0;
  for (let i = 0; i < 12; i++) { const a = x[(i + r) % 12] - mx, b = prof[i] - mp; num += a * b; dx += a * a; dp += b * b; }
  return num / Math.sqrt(dx * dp || 1);
}
let keyNext = 0, keyText = '';
function stepKey(t) {
  if (t < keyNext && t > keyNext - 1) return; keyNext = t + 0.5;
  const h = new Float32Array(12); let tot = 0;
  // 按时值、力度、新近程度加权；低音更能说明调性，再多给一些权重
  for (const n of NOTES) {
    if (n.t > t) break;
    const w = n.vv * (0.3 + Math.min(2, Math.min(n.off, t) - n.t)) * Math.exp(-(t - n.t) / 20) * (n.p < 55 ? 1.5 : 1);
    h[n.p % 12] += w; tot += w;
  }
  if (tot < 16) { keyText = ''; return; }   // 弹得还不够多，不乱猜
  const cands = [];
  for (let r = 0; r < 12; r++) { cands.push([corr(h, KK_MAJ, r), KEY_MAJ[r] + ' 大调']); cands.push([corr(h, KK_MIN, r), KEY_MIN[r] + ' 小调']); }
  cands.sort((a, b) => b[0] - a[0]);
  // 证据够强、而且明显胜过第二名才显示，宁可不显示也不乱猜
  keyText = cands[0][0] > 0.7 && cands[0][0] - cands[1][0] > 0.08 ? cands[0][1] : '';
}

// ---------- 和弦识别 ----------
const PCN = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const PCN_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const TEMPL = [ // 后缀、组成音、先验加分（常见和弦略优先）
  ['', [0, 4, 7], .1], ['m', [0, 3, 7], .1], ['7', [0, 4, 7, 10], .02], ['maj7', [0, 4, 7, 11], .02], ['m7', [0, 3, 7, 10], .02],
  ['dim', [0, 3, 6], -.04], ['m7♭5', [0, 3, 6, 10], 0], ['dim7', [0, 3, 6, 9], -.03], ['aug', [0, 4, 8], -.08],
  ['sus4', [0, 5, 7], -.04], ['sus2', [0, 2, 7], -.06], ['6', [0, 4, 7, 9], -.04], ['m6', [0, 3, 7, 9], -.04],
  ['add9', [0, 2, 4, 7], -.02], ['9', [0, 2, 4, 7, 10], 0], ['maj9', [0, 2, 4, 7, 11], 0], ['m9', [0, 2, 3, 7, 10], 0],
];
function detectChord(t) {
  const w = new Float32Array(12); let bass = 999, total = 0;
  for (const n of NOTES) {
    if (n.t > t) break;
    if (n.ring < t - 0.05) continue;
    const ww = n.vv * Math.exp(-(t - n.t) / 1.8) * (t < n.off ? 1 : 0.6);
    if (ww < 0.04) continue;
    w[n.p % 12] += ww; total += ww; if (n.p < bass) bass = n.p;
  }
  if (w.filter(x => x > 0.06).length < 3) return null;
  let best = null, bs = -1e9;
  for (let r = 0; r < 12; r++) {
    if (w[r] < 0.04) continue;  // 根音必须在
    for (const [suf, iv, prior] of TEMPL) {
      let inS = 0, miss = 0;
      for (const i of iv) { const pc = (r + i) % 12; if (w[pc] > 0.04) inS += w[pc]; else miss++; }
      const sc = inS / total - 0.9 * (total - inS) / total - 0.22 * miss + prior + (bass % 12 === r ? 0.12 : 0) - 0.02 * iv.length;
      if (sc > bs) { bs = sc; best = { r, suf }; }
    }
  }
  if (!best || bs < 0.35) return null;
  // 低音的拼写跟根音所在的调走：D E F♯ G A B 这些升号调用升号，其余用降号
  const sharpy = [2, 4, 6, 7, 9, 11].includes(best.r);
  const bassName = (sharpy ? PCN_SHARP : PCN)[bass % 12];
  return PCN[best.r] + best.suf + (bass % 12 !== best.r ? '/' + bassName : '');
}
// 和弦按 lead sheet 写法排版：根音大写；小写 m 在基线上；延伸音、°、ø 上标；斜杠低音略小
const QUAL = { '': ['', ''], m: ['m', ''], '7': ['', '7'], maj7: ['', 'maj7'], m7: ['m', '7'], dim: ['', '°'], 'm7♭5': ['', 'ø7'],
  dim7: ['', '°7'], aug: ['', '+'], sus4: ['', 'sus4'], sus2: ['', 'sus2'], '6': ['', '6'], m6: ['m', '6'], add9: ['', 'add9'],
  '9': ['', '9'], maj9: ['', 'maj9'], m9: ['m', '9'] };
const fmtNote = (x) => x.replace(/([♭♯])/, '<span class="acc">$1</span>');
function fmtChord(c) {
  const m = c.match(/^([A-G][♭♯]?)([^/]*)(?:\/(.+))?$/); if (!m) return c;
  const [q, sup] = QUAL[m[2]] || ['', m[2]];
  return fmtNote(m[1]) + (q ? `<span class="q">${q}</span>` : '') + (sup ? `<sup>${sup}</sup>` : '')
    + (m[3] ? `<span class="bass"><i>/</i>${fmtNote(m[3])}</span>` : '');
}
const chordEl = $('chord'), keyEl = $('keyName'), chordBox = $('chordBox');
// ---------- 音名标签：跟着光柱顶端往上飘 ----------
const noteName = (p) => PCN[p % 12] + (Math.floor(p / 12) - 1);
const labelsEl = $('labels');
const LABEL_MAX = 10, LABEL_LIFE = 0.9;
const labelPool = Array.from({ length: LABEL_MAX }, () => { const s = document.createElement('span'); s.style.opacity = 0; labelsEl.appendChild(s); return s; });
const labelHtml = (p) => fmtNote(PCN[p % 12]) + `<sub>${Math.floor(p / 12) - 1}</sub>`;
const PV = new THREE.Vector3();
function toCss(x, y) { PV.set(x, y, 0).project(camera); return [(PV.x + 1) / 2 * CW, (1 - PV.y) / 2 * CH]; }
function stepLabels(t) {
  let used = 0; const shown = [];
  if (S.labels) {
    for (let i = NOTES.length - 1; i >= 0 && used < LABEL_MAX; i--) {
      const n = NOTES[i]; if (n.t > t) continue; const age = t - n.t; if (age > LABEL_LIFE) break;
      if (n.vv < 0.2) continue;                                                           // 很轻的装饰音不标
      const B = basePt(keyX(n.p)), k = age / LABEL_LIFE;
      const [x, y] = toCss(B.x, B.y + (0.45 + 0.12 * k) * B.k);                          // 停在琴键正上方，只微微上浮
      const [x2] = toCss(B.x + 0.3 * B.k, B.y);
      const px = Math.abs(x2 - x) / 0.3, fs = Math.max(13, Math.min(42, 0.5 * px));
      // 画面上离已有标签太近（透视远端琴键挤在一起）就不标，免得叠字
      if (shown.some(m => Math.hypot(m.x - x, m.y - y) < fs * 1.6)) continue;
      shown.push({ x, y });
      const el = labelPool[used++];
      if (el.dataset.p !== String(n.p)) { el.dataset.p = n.p; el.innerHTML = labelHtml(n.p); }
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.style.fontSize = fs + 'px';
      el.style.opacity = (1 - k * k) * (0.5 + 0.5 * n.vv);
    }
  }
  for (let i = used; i < LABEL_MAX; i++) labelPool[i].style.opacity = 0;
}

// ---------- 信息栏：BPM、力度表、本场统计 ----------
const stat = { count: 0, lo: 999, hi: -1, onsets: [], dyn: 0.5, bpmShown: 0, next: 0 };
function onNoteStat(n) {
  stat.count++; stat.lo = Math.min(stat.lo, n.p); stat.hi = Math.max(stat.hi, n.p);
  stat.dyn += (n.vv - stat.dyn) * 0.2;   // 最近几个音的平均力度
  const last = stat.onsets[stat.onsets.length - 1];
  if (last === undefined || n.t - last > 0.07) stat.onsets.push(n.t);   // 同时按下的和弦只算一次起音
  while (stat.onsets.length > 32) stat.onsets.shift();
}
function estimateBpm(t) {
  // 取最近 10 秒的起音，看哪个拍长（60–180 BPM）能把相邻起音间隔解释成整数拍或半拍
  const on = stat.onsets.filter(x => x > t - 10 && x <= t);
  if (on.length < 8) return 0;
  const ioi = []; for (let i = 1; i < on.length; i++) { const d = on[i] - on[i - 1]; if (d > 0.12 && d < 2.5) ioi.push(d); }
  if (ioi.length < 6) return 0;
  let best = 0, bs = 0;
  for (let bpm = 60; bpm <= 180; bpm += 1) {
    const P = 60 / bpm; let s = 0;
    for (const d of ioi) { const r = d / P, m = r < 0.75 ? Math.round(r * 2) / 2 : Math.round(r); const e = (r - m) / Math.max(m, 0.5); s += Math.exp(-e * e / 0.008); }
    s *= 1 + 0.15 * Math.exp(-Math.pow((bpm - 100) / 40, 2));        // 轻微偏向常见速度
    if (s > bs) { bs = s; best = bpm; }
  }
  return bs / ioi.length > 0.55 ? best : 0;
}
const bpmEl = $('bpm'), dynEl = $('dyn'), statsEl = $('stats');
// 力度记号：按最近几个音的平均力度，和乐谱一样写 pp p mp mf f ff
const DYN = [[0.22, 'pp'], [0.36, 'p'], [0.5, 'mp'], [0.64, 'mf'], [0.8, 'f'], [2, 'ff']];
function stepInfo(t) {
  if (!S.info) return;
  if (t >= stat.next || t < stat.next - 2) {
    stat.next = t + 0.5;
    const b = estimateBpm(t);
    if (b) stat.bpmShown = stat.bpmShown ? Math.round(stat.bpmShown * 0.6 + b * 0.4) : b;
    else if (stat.onsets.length && t - stat.onsets[stat.onsets.length - 1] > 4) stat.bpmShown = 0;
    bpmEl.textContent = stat.bpmShown ? `♩ = ${stat.bpmShown}` : '';
    const quiet = !stat.onsets.length || t - stat.onsets[stat.onsets.length - 1] > 3;
    dynEl.textContent = quiet ? '' : DYN.find(([v]) => stat.dyn < v)[1];
    statsEl.textContent = stat.count ? `已弹 ${stat.count} 个音　音域 ${noteName(stat.lo)} – ${noteName(stat.hi)}` : '';
  }
}

// 叠加模式：把和弦名"立"在琴的左后方——横向顺着琴键方向，竖直朝上，大小跟着透视变
const CHORD_U = 0.04, CHORD_LIFT = 0.3, CHORD_H = 0.42;  // 位置（沿琴键）、离琴面高度、字高（世界单位）
function placeChord() {
  const p0 = planePx(CHORD_U, 1), p1 = planePx(CHORD_U + 0.02, 1);
  let dx = p1.x - p0.x, dy = -(p1.y - p0.y); const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
  const k = Math.hypot(p1.x - p0.x, p1.y - p0.y) / (0.02 * WIDTH);   // 该处每世界单位多少像素
  const s = Math.min(4, Math.max(0.1, CHORD_H * k / 100));           // 100px 是 CSS 里的标准字号
  const ax = p0.x, ay = VH - p0.y - CHORD_LIFT * k;                    // 锚点（屏幕坐标，y 朝下）
  chordBox.style.left = ax + 'px'; chordBox.style.top = (ay - chordBox.offsetHeight) + 'px';
  chordBox.style.transform = `matrix(${dx * s},${dy * s},0,${s},0,0)`;
}
const chordState = { shown: null, cand: null, since: 0, lastSeen: 0 };
function stepChord(t) {
  if (!S.chord) { chordEl.classList.add('out'); chordState.shown = null; return; }
  const c = detectChord(t);
  if (c) chordState.lastSeen = t;
  if (c !== chordState.cand) { chordState.cand = c; chordState.since = t; }
  const stable = t - chordState.since > 0.12;
  if (c && stable && c !== chordState.shown) {
    chordState.shown = c;
    chordEl.classList.add('out');
    setTimeout(() => { if (chordState.shown === c) { chordEl.innerHTML = fmtChord(c); chordEl.classList.remove('out'); } }, 160);
  } else if (!c && chordState.shown && t - chordState.lastSeen > 1.6) {
    chordState.shown = null; chordEl.classList.add('out');
  }
}

function update(t, dt) {
  const RISE = S.rise;
  const autoHue = LIVE ? hueLive(t, dt) : hueAt(t);
  const loud = loudAt(t);
  harmS = 0.5 - 0.5 * Math.cos(2 * Math.PI * autoHue);   // 五度圈角度 → 渐变位置（来回走，转一圈不跳色）
  const sMain = S.colorMode === 'harmony' ? harmS : gS;
  const main = samplePal(sMain, new THREE.Color()), soft = samplePal(sMain - 0.2, new THREE.Color()).multiplyScalar(0.85);
  let accS = 0, accW = 0;   // 这一帧发声中的音的平均颜色位置，下一帧用来定整体色调
  document.documentElement.style.setProperty('--glow', '#' + main.getHexString());
  for (const o of [staffGroup, heads, tails, ledgers, playhead, playGlow]) o.visible = S.staff;
  spec.visible = specLine.visible = peaks.visible = S.spectrum;
  bgMat.uniforms.uAur.value = S.aurora ? 1 : 0;
  samplePal(sMain + 0.3, bgMat.uniforms.uCol2.value);

  // 新触发的音（只在顺序播放时喷粒子，跳转时不喷）
  if (lastT !== null && t > lastT && t - lastT < 0.5) {
    for (const n of NOTES) {
      if (n.t > t) break;
      if (n.t <= lastT) continue;
      const col = noteCol(n, t).clone();
      const B = basePt(keyX(n.p));
      emit(B.x, B.y, 0.05, Math.round(6 + n.vv * 26), col, 1.2 + n.vv * 2.2, 0.07, WW * 0.4, B.k);
      if (S.staff) { const H = OVERLAY ? hudPt(PLAY_X, staffY(n.p)) : { x: PLAY_X, y: staffY(n.p), k: 1 }; emit(H.x, H.y, 0.05, Math.round(4 + n.vv * 12), col, 0.9 + n.vv, 0.05, 0.05, H.k); }
      spawnFlare(B, n.vv, col, t);
      chordArcs(n, t, col);
      onNoteStat(n);
      pulse = Math.min(1.6, pulse + 0.25 + 0.5 * n.vv);
      if (n.vv > 0.35) { waves.push({ u: uOf(keyX(n.p)), t0: t, vv: n.vv, col }); if (waves.length > 24) waves.shift(); }
    }
  }
  if (lastT !== null && t < lastT) { waves.length = 0; pulse = 0; }
  pulse *= Math.exp(-Math.max(0, Math.min(0.1, dt)) * 4.5);
  simT = t;
  lastT = t;

  // 背景
  bgMat.uniforms.uCol.value.copy(main); bgMat.uniforms.uLoud.value = loud; bgMat.uniforms.uT.value = t;
  {
    const P = stars.geometry.attributes;
    for (let i = 0; i < STARS; i++) {
      const [x, y, z, ph, s] = starBase[i];
      const yy = ((y + t * 0.12 * (1 + ph) + 20) % 40) - 20;
      P.position.setXYZ(i, x + Math.sin(t * 0.1 + ph * 9) * 0.3, yy, z);
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * (0.8 + ph * 2) + ph * 40));
      const c = ph > 0.7 ? main : soft; P.color.setXYZ(i, c.r, c.g, c.b);
      P.size.setX(i, s); P.alpha.setX(i, tw * (0.25 + 0.35 * loud));
    }
    for (const k of ['position', 'color', 'size', 'alpha']) P[k].needsUpdate = true;
  }

  // 琴键 + 光柱 + 频谱
  for (const p in keys) { const k = keys[p]; k.position.y = k.userData.baseY; k.material.emissive.setRGB(0, 0, 0); }
  specVal.fill(0); specR.fill(0); specG.fill(0); specB.fill(0);
  const STYLE = S.style === 'thin' ? 0 : S.style === 'capsule' ? 1 : 2;
  barMat.uniforms.uStyle.value = STYLE; barMat.uniforms.uPad.value = WW * 0.9;
  const smokeOn = S.smoke && dt > 0 && dt < 0.2;
  let nb = 0, ng = 0;
  const visSpan = FADE_H / RISE;
  const GP = glowGeo.attributes.position, GC = glowGeo.attributes.color;
  for (const n of NOTES) {
    if (n.t > t) break;
    if (n.ring + 2 < t && n.off + visSpan < t) continue;
    const col = noteCol(n, t);
    if (t < n.ring) { const w = n.vv * Math.exp(-(t - n.t) / 2); accS += noteS(n.p, n.vv, n.h, t) * w; accW += w; }
    // 按下的键：下沉 + 发光
    if (t < n.off) {
      const e = 0.5 + 1.2 * n.vv * Math.exp(-(t - n.t) * 2);
      const k = keys[n.p];
      if (k) { k.position.y = k.userData.baseY - 0.05; k.material.emissive.copy(col).multiplyScalar(e); }
      if (OVERLAY && ng < MAX_GLOW) {
        // 真琴上这个键的键面：白键整条，黑键窄一些、只占后半段
        const b = isBlack(n.p), half = (b ? WW * 0.29 : WW * 0.46) / WIDTH, uc = uOf(keyX(n.p)), v0 = b ? 0.38 : 0;
        const q = [planePx(uc - half, v0), planePx(uc + half, v0), planePx(uc + half, 1), planePx(uc - half, 1)];
        const c = tmpC.copy(col).multiplyScalar(e * 0.8);
        for (let j = 0; j < 4; j++) { GP.setXYZ(ng * 4 + j, q[j].x, q[j].y, 0); GC.setXYZ(ng * 4 + j, c.r, c.g, c.b); }
        ng++;
      }
    }
    // 光柱：top/bot 是离开琴键的高度（世界单位），再按该键位置的比例换到画面上
    const top = (t - n.t) * RISE, bot = Math.max(0, t - n.off) * RISE;
    if (bot < FADE_H && nb < MAX_BARS) {
      const B = basePt(keyX(n.p));
      let h, w, cy, qw, qh;
      if (STYLE === 0) {
        h = Math.max(0.05, top - bot); w = (isBlack(n.p) ? WW * 0.55 : WW * 0.75) * 3 * (0.8 + 0.4 * n.vv);
        cy = bot + h / 2; qw = w; qh = h;
      } else {
        // 本体宽度 ≈ 键宽；最短也有一个"方块"那么高，刚按下时从琴键里长出来
        w = (isBlack(n.p) ? WW * 0.62 : WW * 0.8) * (0.85 + 0.3 * n.vv);
        h = Math.max(w * (STYLE === 2 ? 1.6 : 1.2), top - bot);
        cy = bot + h / 2; qw = w + 2 * WW * 0.9; qh = h + 2 * WW * 0.9;
      }
      M4.compose(V3.set(B.x, B.y + cy * B.k, isBlack(n.p) ? 0.02 : 0), Q0, S3.set(qw * B.k, qh * B.k, 1));
      bars.setMatrixAt(nb, M4); bars.setColorAt(nb, tmpC.copy(col).multiplyScalar(0.55 + 0.9 * n.vv + 0.25 * pulse));
      barBase.setXY(nb, B.y, B.k); barSize.setXY(nb, w, h); nb++;
      // 按住的音：光柱顶端一直往外冒烟
      if (smokeOn && t < n.off) {
        const rate = (6 + 18 * n.vv) * Math.exp(-(t - n.t) * 0.8);
        let cnt = rate * dt; cnt = Math.floor(cnt) + (rnd() < cnt % 1 ? 1 : 0);
        if (cnt) emitSmoke(B.x, B.y + top * B.k, cnt, col, B.k);
      }
    }
    // 频谱：发声中的音（含踏板延音）
    if (t < n.ring + 0.6) {
      let amp = n.vv * Math.exp(-(t - n.t) / 2.2);
      if (t > n.ring) amp *= Math.exp(-(t - n.ring) / 0.18);
      amp *= 1 + 1.5 * Math.exp(-(t - n.t) * 8);  // 起音冲击
      for (const [dp, g] of HARM) {
        const pp = n.p + dp; if (pp > HI + 6) continue;
        const cx = (keyX(Math.min(pp, HI)) + WIDTH / 2) / WIDTH * (SPEC_N - 1);
        for (let i = Math.max(0, Math.floor(cx - 6)); i <= Math.min(SPEC_N - 1, Math.ceil(cx + 6)); i++) {
          const d = (i - cx) / 2.2, a = amp * g * Math.exp(-d * d); specVal[i] += a;
          specR[i] += col.r * a; specG[i] += col.g * a; specB[i] += col.b * a;
        }
      }
    }
  }
  gS += ((accW > 0.05 ? accS / accW : gS) - gS) * (1 - Math.exp(-dt * 1.5));
  bars.count = nb; bars.instanceMatrix.needsUpdate = true; bars.instanceColor.needsUpdate = true; barBase.needsUpdate = barSize.needsUpdate = true;
  glowGeo.setDrawRange(0, ng * 6); GP.needsUpdate = GC.needsUpdate = true;

  {
    // 频谱：快起慢落；颜色取正在发声的音的颜色，没声音的地方用整体色调
    const P = spec.geometry.attributes, cdt = Math.max(0, Math.min(0.1, dt));
    const fall = Math.exp(-cdt * 3.2), pitchMode = S.colorMode === 'gradient' || S.colorMode === 'segment' || S.colorMode === 'flow';
    const SPEC_GAIN = OVERLAY ? 1.9 : 1.4, cc = new THREE.Color();
    for (let i = 0; i < SPEC_N; i++) {
      const target = Math.min(3.2, specVal[i] * SPEC_GAIN);
      specSm[i] = Math.max(target, specSm[i] * fall);
      const B = basePt(-WIDTH / 2 + (i / (SPEC_N - 1)) * WIDTH);
      const x = B.x, y0 = B.y + 0.02 * B.k;
      const v = specSm[i] + 0.02 * (1 + Math.sin(i * 0.35 + t * 2.4)) * (0.5 + pulse);
      const yy = y0 + v * B.k;
      P.position.setXYZ(i * 2, x, y0, 0); P.position.setXYZ(i * 2 + 1, x, yy, 0);
      specH[i * 2] = 0; specH[i * 2 + 1] = v * B.k;
      if (specVal[i] > 0.02) cc.setRGB(specR[i] / specVal[i], specG[i] / specVal[i], specB[i] / specVal[i]);
      else if (pitchMode) samplePal(noteS(LO + (HI - LO) * i / (SPEC_N - 1), 0.5, 'R', t), cc); else cc.copy(main);
      const lv = Math.min(1, v);
      const c0 = tmpC.copy(cc).multiplyScalar(0.12 + 0.55 * lv + 0.15 * pulse); P.color.setXYZ(i * 2, c0.r, c0.g, c0.b);
      const c1 = tmpC.copy(cc).multiplyScalar(0.06 * lv); P.color.setXYZ(i * 2 + 1, c1.r, c1.g, c1.b);
      // 顶边是一道发光带，越高越亮
      setRibbon(specLine, i, x, yy, (0.05 + 0.04 * lv) * B.k, tmpC.copy(cc).multiplyScalar(0.25 + 0.9 * lv));
      // 峰值：88 个，每段取最高
      const pk = Math.min(PEAK_N - 1, Math.floor(i * PEAK_N / SPEC_N));
      if (v > peakV[pk]) { peakV[pk] = v; peakHold[pk] = 0.35; }
    }
    P.position.needsUpdate = P.color.needsUpdate = true; spec.geometry.attributes.aH.needsUpdate = true;
    specLine.geometry.attributes.position.needsUpdate = specLine.geometry.attributes.color.needsUpdate = true;
    const PP = peaks.geometry.attributes;
    for (let j = 0; j < PEAK_N; j++) {
      peakHold[j] -= cdt; if (peakHold[j] <= 0) peakV[j] = Math.max(0, peakV[j] - cdt * 1.1);
      const B = basePt(-WIDTH / 2 + ((j + 0.5) / PEAK_N) * WIDTH), on = peakV[j] > 0.12 && S.spectrum;
      PP.position.setXYZ(j, B.x, B.y + (peakV[j] + 0.08) * B.k, 0.02);
      const c = tmpC.copy(main).lerp(WHITE, 0.6);
      PP.color.setXYZ(j, c.r, c.g, c.b); PP.size.setX(j, 0.07 * B.k); PP.alpha.setX(j, on ? Math.min(1, peakV[j]) * 0.9 : 0);
    }
    for (const k of ['position', 'color', 'size', 'alpha']) PP[k].needsUpdate = true;
  }
  // 琴键后沿光带：底色常亮 + 正在发声的地方亮起来 + 重音推出的光波
  keyLine.visible = S.keyline && OVERLAY;
  if (keyLine.visible) {
    while (waves.length && t - waves[0].t0 > 1.4) waves.shift();
    const lc = new THREE.Color();
    for (let i = 0; i < LINE_N; i++) {
      const u = i / (LINE_N - 1), x = -WIDTH / 2 + u * WIDTH;
      const B = basePt(x), si = Math.round(u * (SPEC_N - 1));
      lc.copy(main).multiplyScalar(0.55 + 0.45 * (S.pulse ? pulse : 0));
      const e = Math.min(1.5, specSm[si] * 0.9);
      if (specVal[si] > 0.02) lc.add(tmpC.setRGB(specR[si], specG[si], specB[si]).multiplyScalar(e / specVal[si]));
      if (S.pulse) for (const w of waves) {
        const age = t - w.t0, r = Math.abs(u - w.u), front = age * 0.55;
        const a = w.vv * Math.exp(-Math.pow((r - front) / 0.012, 2)) * Math.exp(-age * 2.2) * 1.8;
        if (a > 0.01) lc.add(tmpC.copy(w.col).multiplyScalar(a));
      }
      setRibbon(keyLine, i, B.x, B.y, (0.12 + 0.06 * (S.pulse ? pulse : 0)) * B.k, lc);
    }
    keyLine.geometry.attributes.position.needsUpdate = keyLine.geometry.attributes.color.needsUpdate = true;
  }
  rail.material.color.copy(main).multiplyScalar(0.6 + loud * 0.8);

  // 谱表：音符头、尾巴、加线
  let nh = 0, nl = 0;
  const tA = t - (PLAY_X - X0) / SCROLL, tB = t + (X1 - PLAY_X) / SCROLL;
  const hits = []; // 最近击中播放线的音：用来让谱线起涟漪
  for (const n of NOTES) {
    if (n.t > tB) break;
    if (n.off < tA) continue;
    const x = PLAY_X + (n.t - t) * SCROLL, y = staffY(n.p);
    const age = t - n.t;
    let col;
    if (age < 0) col = tmpC.copy(soft).lerp(new THREE.Color(1, 1, 1), 0.3).multiplyScalar(0.12 + 0.2 * Math.exp(age * 1.5));
    else { col = tmpC.copy(noteCol(n, t)).multiplyScalar(0.3 + 2.4 * n.vv * Math.exp(-age * 4)); hits.push([n, age]); }
    const fadeL = Math.min(1, (x - X0) / 2.5);
    col.multiplyScalar(Math.max(0, fadeL));
    if (nh < MAX_HEADS) {
      const pop = age >= 0 ? 1 + 0.6 * Math.exp(-age * 6) * n.vv : 1;
      M4.compose(V3.set(x, y, 0.02), Q0, S3.set(HEAD_S * pop, HEAD_S * pop, 1));
      heads.setMatrixAt(nh, M4); heads.setColorAt(nh, col);
      const len = Math.max(0.01, Math.min(n.off, t) - n.t) * SCROLL;
      M4.compose(V3.set(x + len / 2, y, 0.015), Q0, S3.set(len, HEAD_S * 0.32, 1));
      tails.setMatrixAt(nh, M4); tails.setColorAt(nh, col.clone().multiplyScalar(0.22)); nh++;
    }
    // 加线：谱表外的音
    const d = diat(n.p);
    const ledgerSet = [];
    if (d === D_MIDC) ledgerSet.push(D_MIDC);
    for (let L = 47; L <= d; L += 2) ledgerSet.push(L);
    for (let L = 23; L >= d; L -= 2) ledgerSet.push(L);
    for (const L of ledgerSet) if (nl < MAX_LEDGER) {
      M4.compose(V3.set(x, STAFF_Y + (L - D_MIDC) * HALF, 0.01), Q0, S3.set(HEAD_S * 2.1, 0.014, 1));
      ledgers.setMatrixAt(nl, M4); ledgers.setColorAt(nl, tmpC.setRGB(.14, .15, .2).multiplyScalar(Math.max(0, fadeL))); nl++;
    }
  }
  heads.count = tails.count = nh; ledgers.count = nl;
  for (const m of [heads, tails, ledgers]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }

  // 谱线：从播放线向两侧传开的涟漪
  for (const line of STAFF_LINES) {
    const P = line.geometry.attributes.position, y0 = line.userData.y, th = 0.011;
    for (let i = 0; i < SL_N; i++) {
      const x = X0 + (i / (SL_N - 1)) * (X1 - X0);
      let dy = 0;
      for (const [n, age] of hits) {
        if (age > 2.2) continue;
        const same = (diat(n.p) > D_MIDC) === line.userData.treble;
        const near = Math.exp(-Math.abs(staffY(n.p) - y0) * 1.2);
        const r = Math.abs(x - PLAY_X), front = age * 3.2;
        const env = Math.exp(-Math.pow((r - front) * 2.2, 2)) + Math.exp(-r * 1.5) * 0.6;
        dy += (same ? 1 : 0.35) * near * n.vv * 0.14 * Math.exp(-age * 1.6) * env * Math.sin(r * 9 - age * 14);
      }
      P.setXYZ(i * 2, x, y0 + dy - th, 0); P.setXYZ(i * 2 + 1, x, y0 + dy + th, 0);
    }
    P.needsUpdate = true;
    line.material.color.copy(soft).lerp(new THREE.Color(1, 1, 1), 0.4).multiplyScalar(0.16 + 0.12 * loud);
  }
  playhead.material.color.copy(main).lerp(new THREE.Color(1, 1, 1), 0.3).multiplyScalar(0.35 + loud * 0.3);
  playGlow.material.uniforms.uCol.value.copy(main).multiplyScalar(0.08 + loud * 0.18);

  stepSparks(dt);
  stepFlares(t);
  stepArcs(t);
  stepKey(t);
  stepChord(t);
  keyEl.textContent = S.keysig ? keyText : '';
  stepLabels(t);
  stepInfo(t);
  if (OVERLAY) placeChord();

  // 镜头固定不动
  if (!OVERLAY) { camera.position.set(0, 0, CAM_Z); camera.lookAt(0, 0, 0); }
  bloom.strength = (0.75 + loud * 0.35 + (S.pulse ? pulse * 0.25 : 0)) * S.glow * (OVERLAY ? 0.6 : 1);
}

// ---------- 标定（叠加模式，按 C 开关） ----------
// 四个点拖到真琴键面的四个角上；可以把一张摄像头截图拖进窗口当底图对照（只在标定时显示，不会进画面）
const calib = document.createElement('div');
calib.id = 'calib'; calib.hidden = true;
calib.innerHTML = `<img id="calImg" alt=""><svg id="calSvg"></svg>
  <div class="calTip">把四个点拖到琴键面的四个角：<b>左前</b>=最低音那头、靠你的前沿；<b>右前</b>=最高音那头前沿；<b>右后 / 左后</b>=琴键根部（和琴身交界处）。<br>
  可以把摄像头截图直接拖进这个窗口当底图。线条应该正好落在每个白键的缝上。<br>
  在圈<b>旁边</b>按住拖就行（点会跟着移动，不会被鼠标挡住）；也可以点一下选中，再用<b>方向键</b>微调（Shift 加速，Tab 换点）。按 <b>C</b> 完成。</div>`;
const CAL_NAMES = ['左前', '右前', '右后', '左后'];
const handles = CAL_NAMES.map((name, i) => {
  // 拖动点本身是一个中间透明的小圆圈，文字标签挪到圈外，不挡住要对准的角
  const h = document.createElement('div'); h.className = 'calH'; h.innerHTML = `<span class="calL">${name}</span><span class="grab"></span>`; calib.appendChild(h);
  h.addEventListener('pointerdown', (e) => {
    h.setPointerCapture(e.pointerId); selectCal(i);
    // 相对拖动：从圈旁边任意位置按住拖，点只按鼠标移动的距离走，不会跳到光标底下被挡住
    const r0 = stage.getBoundingClientRect(), sx = e.clientX, sy = e.clientY, [cx0, cy0] = CAL[i];
    const move = (ev) => {
      CAL[i] = [Math.min(1.2, Math.max(-0.2, cx0 + (ev.clientX - sx) / r0.width)), Math.min(1.2, Math.max(-0.2, cy0 + (ev.clientY - sy) / r0.height))];
      solveH(); drawCalib();
    };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); saveCal(); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up);
  });
  return h;
});
stage.appendChild(calib);
function saveCal() { try { localStorage.setItem(CAL_KEY, JSON.stringify(CAL)); } catch (err) { /* 存不了就本次有效 */ } }
// 选中一个点后用方向键微调：每次 1 像素，按住 Shift 每次 10 像素；Tab 换下一个点
let calSel = 0;
function selectCal(i) { calSel = i; handles.forEach((h, j) => h.classList.toggle('sel', j === i)); }
addEventListener('keydown', (e) => {
  if (!OVERLAY || calib.hidden || typing(e)) return;
  const step = e.shiftKey ? 10 : 1, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (e.key === 'Tab') { e.preventDefault(); selectCal((calSel + 1) % 4); return; }
  if (!d) return;
  e.preventDefault();
  CAL[calSel] = [CAL[calSel][0] + d[0] / VW, CAL[calSel][1] + d[1] / VH];
  solveH(); drawCalib(); saveCal();
});
selectCal(0);
const calImg = calib.querySelector('#calImg'), calSvg = calib.querySelector('#calSvg');
calImg.onerror = () => { calImg.hidden = true; };
calImg.onload = () => { calImg.hidden = false; };
calImg.src = 'calib.jpg';   // 项目目录里放一张 calib.jpg 会自动当底图
addEventListener('dragover', (e) => { if (OVERLAY) e.preventDefault(); });
addEventListener('drop', (e) => {
  if (!OVERLAY) return; e.preventDefault();
  const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) { calImg.src = URL.createObjectURL(f); calib.hidden = false; drawCalib(); }
});
addEventListener('keydown', (e) => { if (OVERLAY && !typing(e) && (e.key === 'c' || e.key === 'C')) { calib.hidden = !calib.hidden; drawCalib(); } });
function drawCalib() {
  if (!OVERLAY || calib.hidden) return;
  const W = VW, H = VH, P = (u, v) => { const [x, y] = planeN(u, v); return `${x * W},${y * H}`; };
  let s = `<polygon points="${P(0, 0)} ${P(1, 0)} ${P(1, 1)} ${P(0, 1)}" fill="rgba(120,160,255,.12)" stroke="#8fb0ff" stroke-width="2"/>`;
  // 白键缝：每个白键左沿一条线；C 键标出来方便对位
  for (let p = LO; p <= HI; p++) {
    if (isBlack(p)) continue;
    const u = uOf(keyX(p) - WW / 2);
    s += `<line x1="${P(u, 0).split(',')[0]}" y1="${P(u, 0).split(',')[1]}" x2="${P(u, 1).split(',')[0]}" y2="${P(u, 1).split(',')[1]}" stroke="${p % 12 === 0 ? '#ffd27a' : 'rgba(180,200,255,.55)'}" stroke-width="${p % 12 === 0 ? 2 : 1}"/>`;
    if (p % 12 === 0) { const [x, y] = P(uOf(keyX(p)), -0.25).split(','); s += `<text x="${x}" y="${y}" fill="#ffd27a" font-size="12" text-anchor="middle">C${p / 12 - 1}</text>`; }
  }
  const [bx, by] = P(0, V_BASE).split(','), [ex, ey] = P(1, V_BASE).split(',');
  s += `<line x1="${bx}" y1="${by}" x2="${ex}" y2="${ey}" stroke="#ff8ad8" stroke-width="1.5" stroke-dasharray="6 4"/>`;
  calSvg.setAttribute('viewBox', `0 0 ${W} ${H}`); calSvg.innerHTML = s;
  // 标签放在"从四边形中心指向这个角"的方向上、圈外 30px
  const cx = CAL.reduce((a, c) => a + c[0], 0) / 4 * W, cy = CAL.reduce((a, c) => a + c[1], 0) / 4 * H;
  CAL.forEach(([x, y], i) => {
    handles[i].style.left = x * 100 + '%'; handles[i].style.top = y * 100 + '%';
    let dx = x * W - cx, dy = y * H - cy; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const lab = handles[i].firstChild; lab.style.left = `calc(50% + ${dx * 36}px)`; lab.style.top = `calc(50% + ${dy * 36}px)`;
  });
}
{ let saved = false; try { saved = !!localStorage.getItem(CAL_KEY); } catch (e) { /* 读不到当没存过 */ }
  if (OVERLAY && !saved) calib.hidden = false; }   // 第一次用自动打开标定

resize();
addEventListener('resize', resize);

// ---------- 播放 ----------
const hud = document.getElementById('hud');
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

if (LIVE) {
  // ---------- 实时：电钢琴 MIDI ----------
  document.getElementById('play').hidden = true;
  const T0 = performance.now();
  const now = () => (performance.now() - T0) / 1000;
  const held = new Map();   // 音高 → 正在按着的音
  let pedalDown = false;
  function noteOn(p, vel) {
    noteOff(p);
    const t = now(), v = vel / 127;
    const n = { p, t, d: 0, v, vv: Math.min(1, Math.pow(v, 0.8) * 1.15), h: p < 60 ? 'L' : 'R', off: Infinity, ring: Infinity };
    NOTES.push(n); held.set(p, n);
  }
  function noteOff(p) {
    const n = held.get(p); if (!n) return;
    held.delete(p); const t = now(); n.off = t; n.d = t - n.t;
    if (!pedalDown) n.ring = t;
  }
  function pedal(down) {
    pedalDown = down;
    if (!down) { const t = now(); for (const n of NOTES) if (n.ring === Infinity && n.off !== Infinity) n.ring = t; }
  }
  function onMsg(ev) {
    const [s, a, b] = ev.data, cmd = s & 0xf0;
    if (cmd === 0x90 && b > 0) noteOn(a, b);
    else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) noteOff(a);
    else if (cmd === 0xb0 && a === 64) pedal(b >= 64);
  }
  let devices = '没检测到 MIDI 设备（可用电脑键盘 A–K 测试）';
  function bind(access) {
    const names = [];
    access.inputs.forEach((inp) => { inp.onmidimessage = onMsg; names.push(inp.name); });
    devices = names.length ? 'MIDI：' + names.join('、') : '没检测到 MIDI 设备（可用电脑键盘 A–K 测试）';
  }
  if (navigator.requestMIDIAccess) navigator.requestMIDIAccess().then((acc) => { acc.onstatechange = () => bind(acc); bind(acc); }).catch(() => { devices = '没有 MIDI 权限'; });
  else devices = '这个浏览器不支持 MIDI，请用 Chrome';

  // 电脑键盘测试：A S D F G H J K = C4 D4 E4 F4 G4 A4 B4 C5，W E T Y U = 黑键，空格 = 踏板
  const KB = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72 };
  addEventListener('keydown', (e) => { if (e.repeat || typing(e)) return; if (e.code === 'Space') { e.preventDefault(); pedal(true); } const p = KB[e.key]; if (p) noteOn(p, 100); });
  addEventListener('keyup', (e) => { if (typing(e)) return; if (e.code === 'Space') pedal(false); const p = KB[e.key]; if (p) noteOff(p); });

  let prevNow = performance.now();
  function loop(ms) {
    const dt = Math.min(0.05, (ms - prevNow) / 1000); prevNow = ms;
    const t = now();
    // 丢掉早已看不见的音，免得越弹越卡
    if (NOTES.length > 400) { const keep = NOTES.filter(n => !(n.ring < t - 12 && n.off < t - 12)); NOTES.length = 0; NOTES.push(...keep); }
    update(t, dt); composer.render();
    hud.textContent = devices;
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
} else if (RENDER) {
  // 逐帧渲染：外部按 1/fps 调用 renderAt(t)
  document.getElementById('play').hidden = true;
  let prev = null;
  window.renderAt = (t) => { const dt = prev === null ? 1 / 60 : Math.max(0, t - prev); prev = t; update(t, dt); composer.render(); return true; };
  window.ready = true;
} else {
  let clock = null; // () => 当前歌曲时间
  const btn = document.getElementById('play');
  let prevNow = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - prevNow) / 1000); prevNow = now;
    const t = clock ? clock() : FROM;
    update(t, dt); composer.render();
    hud.textContent = fmt(t);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  async function start() {
    btn.hidden = true;
    if (NOAUDIO) { const t0 = performance.now(); clock = () => FROM + (performance.now() - t0) / 1000; return; }
    btn.hidden = false; btn.textContent = '加载钢琴音色…';
    await Tone.start();
    const urls = {}; for (const n of ['A0','C1','D#1','F#1','A1','C2','D#2','F#2','A2','C3','D#3','F#3','A3','C4','D#4','F#4','A4','C5','D#5','F#5','A5','C6','D#6','F#6','A6','C7','D#7','F#7','A7','C8']) urls[n] = n.replace('#', 's') + '.mp3';
    const reverb = new Tone.Reverb({ decay: 3.2, wet: 0.22 }).toDestination();
    const piano = new Tone.Sampler({ urls, baseUrl: 'https://tonejs.github.io/audio/salamander/', release: 1.2 }).connect(reverb);
    await Tone.loaded(); await reverb.ready;
    btn.hidden = true;
    const t0 = Tone.now() + 0.3;
    for (const n of NOTES) {
      if (n.t < FROM) continue;
      piano.triggerAttackRelease(Tone.Frequency(n.p, 'midi').toFrequency(), Math.max(0.05, n.ring - n.t), t0 + n.t - FROM, Math.min(1, 0.15 + n.v * 1.5));
    }
    clock = () => FROM + (Tone.now() - t0);
  }
  if (NOAUDIO) start(); else btn.addEventListener('click', start, { once: true });
}
