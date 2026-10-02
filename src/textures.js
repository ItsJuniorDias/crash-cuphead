import * as THREE from 'three';
import { COLORS as C } from './config.js';
import { makeCanvas, starburst } from './draw.js';

const ASSET_DIR = `${import.meta.env.BASE_URL}assets/`;

// Todo asset pode vir do gerador (scripts/generate-assets.mjs → public/assets + manifest.json).
// Os que ainda não foram gerados usam uma versão procedural desenhada aqui.
const FALLBACKS = {
  sky: () => null, // sem imagem, o céu é um gradiente no shader
  skyDusk: () => null,
  skyNight: () => null,
  sun: sunCanvas,
  moon: moonCanvas,
  star: starCanvas,
  // variantes do pôr do sol e da noite: só existem se forem geradas (sem versão procedural)
  sunDusk: () => null,
  ...Object.fromEntries(['mountains', 'hills', 'trees', 'ground', 'foreground', 'cloud1', 'cloud2'].map((n) => [`${n}Night`, () => null])),
  cloud1: () => cloudCanvas(false),
  cloud2: () => cloudCanvas(true),
  mountains: () => stripCanvas({ color: '#a3a88c', base: 140, amp: 55, k: [2, 5] }),
  hills: () => stripCanvas({ color: C.hillFar, base: 130, amp: 30, k: [3, 7], front: tufts }),
  trees: () => stripCanvas({ color: '#93a46a', base: 210, amp: 8, k: [4, 9], behind: trees }),
  ground: () => stripCanvas({ color: C.hillNear, base: 120, amp: 12, k: [5, 11], front: fence }),
  foreground: bushesCanvas,
  plane: planeCanvas,
  kaboom: kaboomCanvas,
  coin: coinCanvas,
  smoke: smokeCanvas,
};

export async function loadTextures() {
  const manifest = await fetch(`${ASSET_DIR}manifest.json`)
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  const loader = new THREE.TextureLoader();
  const tex = {};

  await Promise.all(Object.entries(FALLBACKS).map(async ([name, fallback]) => {
    let t = null;
    const entry = manifest[name];
    if (entry?.file) {
      try {
        t = await loader.loadAsync(`${ASSET_DIR}${entry.file}?v=${encodeURIComponent(entry.generatedAt ?? '')}`);
        t.userData.generated = true;
        // avião gerado sem hélice: o gerador salva onde fica o nariz ({u, v} na imagem)
        if (entry.propeller) t.userData.propeller = entry.propeller;
      } catch (err) {
        console.warn(`[assets] ${name}: failed to load, using procedural fallback`, err);
      }
    }
    if (!t) {
      const canvas = fallback();
      if (!canvas) return;
      t = new THREE.CanvasTexture(canvas);
      t.userData.generated = false;
      t.userData.propeller = canvas.propeller;
    }
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    tex[name] = t;
  }));

  tex.propFrames = await loadPropellerFrames(manifest.propeller, loader);
  tex.propBlur = canvasTexture(propellerBlurCanvas());
  tex.debris = canvasTexture(debrisCanvas());
  tex.dash = canvasTexture(dashCanvas());
  tex.dash.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** Quadros da hélice: PNGs do gerador (propeller_0..n) ou desenhados aqui. */
async function loadPropellerFrames(entry, loader) {
  if (entry?.frames?.length) {
    try {
      const v = encodeURIComponent(entry.generatedAt ?? '');
      const frames = await Promise.all(entry.frames.map((f) => loader.loadAsync(`${ASSET_DIR}${f}?v=${v}`)));
      for (const t of frames) t.colorSpace = THREE.SRGBColorSpace;
      return frames;
    } catch (err) {
      console.warn('[assets] propeller frames failed to load, using procedural fallback', err);
    }
  }
  return propellerCanvases().map(canvasTexture);
}

function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ───────────── fallbacks procedurais (mesmo traço dos assets gerados) ─────────────

function ink(ctx, width) {
  ctx.lineWidth = width; ctx.strokeStyle = C.ink; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
}

function planeCanvas() {
  const c = makeCanvas(300, 180), ctx = c.getContext('2d');
  const S = 2.2, OX = 140, OY = 98;
  ctx.translate(OX, OY); ctx.scale(S, S); ink(ctx, 3.5);
  const fs = (col) => { ctx.fillStyle = col; ctx.fill(); ctx.stroke(); };
  // cachecol
  ctx.beginPath(); ctx.moveTo(-8, -26); ctx.quadraticCurveTo(-30, -32, -55, -24);
  ctx.lineTo(-52, -17); ctx.quadraticCurveTo(-30, -22, -6, -20); ctx.closePath(); fs(C.gold);
  // cauda
  ctx.beginPath(); ctx.moveTo(-40, -6); ctx.lineTo(-62, -26); ctx.lineTo(-52, -26); ctx.lineTo(-34, -10); ctx.closePath(); fs(C.red);
  ctx.beginPath(); ctx.ellipse(-50, 0, 14, 4, 0, 0, Math.PI * 2); fs(C.cream);
  // trem de pouso
  ctx.beginPath(); ctx.moveTo(4, 10); ctx.lineTo(10, 26); ctx.moveTo(18, 10); ctx.lineTo(10, 26); ctx.stroke();
  ctx.beginPath(); ctx.arc(10, 27, 7, 0, Math.PI * 2); fs('#3a2a20');
  ctx.beginPath(); ctx.arc(10, 27, 2, 0, Math.PI * 2); ctx.fillStyle = C.cream; ctx.fill();
  // fuselagem
  ctx.beginPath(); ctx.ellipse(0, 0, 46, 17, 0, 0, Math.PI * 2); fs(C.red);
  ctx.beginPath(); ctx.ellipse(-4, 3, 30, 5, 0, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fill();
  ctx.beginPath(); ctx.moveTo(14, -15); ctx.lineTo(14, 15); ctx.moveTo(-24, -13); ctx.lineTo(-24, 13); ctx.stroke();
  // asas
  ctx.beginPath(); ctx.roundRect(-18, 6, 44, 9, 5); fs(C.cream);
  ctx.beginPath(); ctx.moveTo(-10, 6); ctx.lineTo(-14, -30); ctx.moveTo(18, 6); ctx.lineTo(22, -30); ctx.stroke();
  ctx.beginPath(); ctx.roundRect(-28, -38, 60, 10, 5); fs(C.cream);
  // piloto
  ctx.beginPath(); ctx.arc(-4, -22, 12, 0, Math.PI * 2); fs(C.cream);
  ctx.beginPath(); ctx.arc(-4, -26, 12, Math.PI * 1.02, Math.PI * 1.98); fs('#6b4a2e');
  for (const [ex, ey] of [[-6, -22], [2, -22]]) { // olhos "pie-cut"
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.ellipse(ex, ey, 2.8, 4.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.cream; ctx.beginPath(); ctx.moveTo(ex + 0.5, ey - 1); ctx.arc(ex + 0.5, ey - 1, 4, -1.2, -0.5); ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = C.red; ctx.beginPath(); ctx.arc(7, -18, 3, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(-1, -17, 5, 0.15 * Math.PI, 0.75 * Math.PI); ctx.stroke();
  ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(-8, -33, 4, 0, Math.PI * 2); ctx.arc(1, -33, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#9ec3c9'; ctx.fill(); ctx.stroke();
  // nariz (a hélice é um mesh animado no scene.js)
  ctx.lineWidth = 3.5; ctx.beginPath(); ctx.arc(46, 0, 8, 0, Math.PI * 2); fs(C.gold);
  c.propeller = { u: (OX + 54 * S) / c.width, v: OY / c.height };
  return c;
}

function cloudCanvas(face) {
  const c = makeCanvas(250, 170), ctx = c.getContext('2d');
  const blobs = [[0, 0, 26], [28, -10, 30], [58, 0, 24], [18, 10, 22], [44, 10, 22]];
  ctx.translate(70, 90); ctx.scale(2, 2);
  ctx.fillStyle = C.ink; for (const [x, y, r] of blobs) { ctx.beginPath(); ctx.arc(x, y, r + 3.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = C.cream; for (const [x, y, r] of blobs) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  if (face) {
    ctx.fillStyle = C.ink;
    ctx.beginPath(); ctx.ellipse(20, -4, 3, 5, 0, 0, Math.PI * 2); ctx.ellipse(36, -4, 3, 5, 0, 0, Math.PI * 2); ctx.fill();
    ink(ctx, 2.5); ctx.beginPath(); ctx.arc(28, 4, 7, 0.2 * Math.PI, 0.8 * Math.PI); ctx.stroke();
    ctx.fillStyle = 'rgba(200,49,43,.35)'; ctx.beginPath(); ctx.arc(12, 6, 5, 0, Math.PI * 2); ctx.arc(44, 6, 5, 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

/** Lua crescente com cara de sono (a "volta" do sol no ciclo dia → noite). */
function moonCanvas() {
  const S = 180, c = makeCanvas(S, S), ctx = c.getContext('2d');
  const outer = [90, 90, 70], inner = [124, 70, 58];
  const circle = ([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); };
  ctx.fillStyle = '#f1df9c'; circle(outer); ctx.fill();
  ctx.globalCompositeOperation = 'destination-out'; circle(inner); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ink(ctx, 7);
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.arc(inner[0], inner[1], inner[2], 0, Math.PI * 2, true); ctx.clip();
  circle(outer); ctx.stroke(); ctx.restore();
  ctx.save(); circle(outer); ctx.clip(); circle(inner); ctx.stroke(); ctx.restore();
  // rosto na curva de dentro: olho fechado, sorriso e bochecha
  ink(ctx, 5);
  ctx.beginPath(); ctx.arc(58, 78, 9, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.arc(66, 112, 12, 0.1 * Math.PI, 0.7 * Math.PI); ctx.stroke();
  ctx.fillStyle = 'rgba(200,49,43,.35)'; ctx.beginPath(); ctx.arc(46, 100, 8, 0, Math.PI * 2); ctx.fill();
  return c;
}

function starCanvas() {
  const S = 64, c = makeCanvas(S, S), ctx = c.getContext('2d');
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 11 : 27, a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = '#f6e7a8'; ctx.fill();
  ink(ctx, 4); ctx.stroke();
  return c;
}

function sunCanvas() {
  const c = makeCanvas(180, 180), ctx = c.getContext('2d');
  ink(ctx, 8); ctx.fillStyle = C.gold;
  ctx.beginPath(); ctx.arc(90, 90, 70, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = C.ink;
  ctx.beginPath(); ctx.ellipse(68, 80, 8, 14, 0, 0, Math.PI * 2); ctx.ellipse(112, 80, 8, 14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 7; ctx.beginPath(); ctx.arc(90, 100, 28, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.fillStyle = 'rgba(200,49,43,.4)'; ctx.beginPath(); ctx.arc(52, 108, 11, 0, Math.PI * 2); ctx.arc(128, 108, 11, 0, Math.PI * 2); ctx.fill();
  return c;
}

/** Faixa de 1024px que repete sem emenda (frequências inteiras sobre a largura). */
function stripCanvas({ color, base, amp, k, behind, front }) {
  const W = 1024, H = 256, c = makeCanvas(W, H), ctx = c.getContext('2d');
  const top = (x) => base - amp * (0.6 * Math.sin((x / W) * Math.PI * 2 * k[0]) + 0.4 * Math.sin((x / W) * Math.PI * 2 * k[1] + 1.7));
  behind?.(ctx, W, H, top);
  ctx.beginPath(); ctx.moveTo(0, H);
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, top(x));
  ctx.lineTo(W, H); ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
  ctx.beginPath();
  for (let x = 0; x <= W; x += 4) ctx.lineTo(x, top(x));
  ink(ctx, 7); ctx.stroke();
  front?.(ctx, W, H, top);
  return c;
}

function tufts(ctx, W, H, top) {
  ink(ctx, 3.5);
  for (let x = 32; x < W; x += 64) {
    const y = top(x) + 24 + ((x * 7) % 30);
    ctx.beginPath(); ctx.moveTo(x - 8, y + 6); ctx.lineTo(x, y - 5); ctx.lineTo(x + 8, y + 6); ctx.stroke();
  }
}

function trees(ctx, W, H, top) {
  ink(ctx, 5);
  for (let x = 64; x < W; x += 128) {
    const g = top(x), r = 30 + ((x * 13) % 14), h = 50 + ((x * 7) % 30);
    ctx.beginPath(); ctx.rect(x - 6, g - h, 12, h + 4); ctx.fillStyle = '#7a5434'; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, g - h - r + 8, r, 0, Math.PI * 2); ctx.fillStyle = '#6f8a4a'; ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x - r * 0.35, g - h - r, r * 0.3, Math.PI, Math.PI * 1.6);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.stroke(); ink(ctx, 5);
  }
}

function fence(ctx, W, H, top) {
  ink(ctx, 4);
  for (const dy of [-26, -12]) {
    ctx.beginPath();
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, top(x) + dy);
    ctx.lineWidth = 8; ctx.strokeStyle = C.ink; ctx.stroke();
    ctx.lineWidth = 3.5; ctx.strokeStyle = C.cream; ctx.stroke();
  }
  ink(ctx, 4);
  for (let x = 32; x < W; x += 64) {
    const y = top(x);
    ctx.beginPath(); ctx.moveTo(x - 6, y + 6); ctx.lineTo(x - 6, y - 34); ctx.lineTo(x, y - 40); ctx.lineTo(x + 6, y - 34); ctx.lineTo(x + 6, y + 6);
    ctx.fillStyle = C.cream; ctx.fill(); ctx.stroke();
  }
}

function bushesCanvas() {
  const W = 1024, H = 256, c = makeCanvas(W, H), ctx = c.getContext('2d');
  const blobs = [];
  for (let x = 0; x < W; x += 128) {
    const j = (x * 37) % 40;
    blobs.push([x + j, 210, 62], [x + 50 + j, 190, 56], [x + 95 + j, 215, 50]);
  }
  // desenha também deslocado ±W para a faixa emendar sem corte
  const all = blobs.flatMap(([x, y, r]) => [[x, y, r], [x - W, y, r], [x + W, y, r]]);
  ctx.fillStyle = C.ink; for (const [x, y, r] of all) { ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = '#4f6b3a'; for (const [x, y, r] of all) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,255,255,.12)'; for (const [x, y, r] of all) { ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.35, r * 0.35, 0, Math.PI * 2); ctx.fill(); }
  for (let x = 40; x < W; x += 96) { // florzinhas
    const y = 170 + ((x * 11) % 40);
    ctx.fillStyle = C.cream; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.gold; ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  return c;
}

/** Mesma sequência do gerador: 8 quadros de meia volta, rastro curto e cubo sempre redondo. */
function propellerCanvases() {
  const W = 48, H = 200, N = 8, blade = makeCanvas(W, H), b = blade.getContext('2d');
  ink(b, 4);
  b.fillStyle = '#9a6a3c';
  b.beginPath(); b.ellipse(W / 2, 52, 11, 48, 0, 0, Math.PI * 2); b.fill(); b.stroke();
  b.beginPath(); b.ellipse(W / 2, H - 52, 11, 48, 0, 0, Math.PI * 2); b.fill(); b.stroke();
  const cosAt = (k) => Math.cos(((((k % N) + N) % N) * Math.PI) / N);
  const drawBlade = (ctx, s, alpha) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(0, H / 2);
    ctx.scale(1, Math.sign(s || 1) * Math.max(0.06, Math.abs(s)));
    ctx.drawImage(blade, 0, -H / 2);
    ctx.restore();
  };
  return Array.from({ length: N }, (_, k) => {
    const c = makeCanvas(W, H), ctx = c.getContext('2d');
    drawBlade(ctx, cosAt(k - 1), 0.22);
    drawBlade(ctx, cosAt(k), 1);
    ink(ctx, 4); ctx.fillStyle = C.gold;
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    return c;
  });
}

/** Disco de borrão da hélice em alta rotação: oval translúcido com riscos de velocidade. */
function propellerBlurCanvas() {
  const W = 72, H = 256, c = makeCanvas(W, H), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(W / 2, H / 2, 4, W / 2, H / 2, H / 2);
  g.addColorStop(0, 'rgba(27,20,16,0.28)');
  g.addColorStop(0.8, 'rgba(27,20,16,0.16)');
  g.addColorStop(1, 'rgba(27,20,16,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(W / 2, H / 2, W / 2 - 2, H / 2 - 2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(27,20,16,0.55)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  for (const [r, a0, a1] of [[0.92, -1.25, -0.55], [0.75, 0.35, 1.05], [0.92, 2.0, 2.6]]) {   // riscos curvos
    ctx.beginPath();
    for (let t = a0; t <= a1; t += 0.05) {
      const x = W / 2 + Math.cos(t) * (W / 2 - 4) * r, y = H / 2 + Math.sin(t) * (H / 2 - 4) * r;
      t === a0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return c;
}

function kaboomCanvas() {
  const c = makeCanvas(512, 400), ctx = c.getContext('2d');
  starburst(ctx, 256, 200, 190, 115, 12, 0, C.gold, 8);
  starburst(ctx, 256, 200, 125, 75, 10, 0.3, C.orange, 7);
  return c;
}

function coinCanvas() {
  const c = makeCanvas(64, 64), ctx = c.getContext('2d');
  ink(ctx, 4); ctx.fillStyle = C.gold;
  ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(32, 32, 17, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.beginPath(); ctx.arc(32, 32, 21, 3.6, 4.6); ctx.stroke();
  return c;
}

function smokeCanvas() {
  const c = makeCanvas(128, 128), ctx = c.getContext('2d');
  ink(ctx, 6); ctx.fillStyle = C.smoke;
  ctx.beginPath(); ctx.arc(64, 64, 54, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.beginPath(); ctx.arc(48, 46, 18, 0, Math.PI * 2); ctx.fill();
  return c;
}

function debrisCanvas() {
  const c = makeCanvas(64, 24), ctx = c.getContext('2d');
  ink(ctx, 4); ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(3, 3, 58, 18, 6); ctx.fill(); ctx.stroke();
  return c;
}

function dashCanvas() {
  const c = makeCanvas(32, 4), ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 16, 4);   // só o padrão: a cor vem do material
  return c;
}
