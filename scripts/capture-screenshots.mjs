#!/usr/bin/env node
/**
 * Tira as capturas do README controlando um Chrome sem janela (protocolo DevTools).
 *
 *   npm run dev            (em outro terminal)
 *   npm run screenshots    → docs/screenshots/*.jpg
 *
 * O relógio do jogo é congelado e avançado quadro a quadro, então cada cena (apostando, voando,
 * pôr do sol, noite, queda) sai sempre igual, com o painel de apostas no estado certo.
 * Requer Google Chrome instalado (ou CHROME=/caminho/do/chrome) e Node 22+ (WebSocket nativo).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const URL_GAME = process.env.GAME_URL || 'http://localhost:5173/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(path.join(os.tmpdir(), 'bb-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--mute-audio',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map(), waiters = [];

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
          if (msg.method) for (const w of [...waiters]) if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.res(msg.params); }
        };
        return;
      }
    } catch { /* Chrome ainda subindo */ }
    await sleep(200);
  }
  throw new Error('não consegui falar com o Chrome');
}
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const once = (method) => new Promise((res) => waiters.push({ method, res }));
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function open({ width, height, scale, mobile }) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: URL_GAME });
  await loaded;
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`!!window.__bb && !document.getElementById('loading')`)) break;
    await sleep(200);
  }
  // congela o jogo e cria o "avançar N segundos" (lógica + render + painel)
  await evaluate(`(() => {
    const { game: g, world: w, hud } = window.__bb;
    w.renderer.setAnimationLoop(null);
    let t = 0;
    // A lógica anda a cada dt, mas o desenho só a cada ~0,25 s de jogo (e no último quadro): centenas
    // de renders seguidos numa tarefa fazem o Chrome sem janela perder o contexto WebGL (tela preta).
    window.__lost = 0;
    w.renderer.domElement.addEventListener('webglcontextlost', () => { window.__lost++; });
    window.__step = (seconds, dt = 1 / 30) => {
      let acc = 0;
      for (let s = 0; s < seconds; s += dt) {
        t += dt; acc += dt; g.update(dt);
        if (acc >= 0.25 || s + dt >= seconds) { w.update(g, acc, t); acc = 0; }
      }
      hud.update();
    };
    // redesenha sem avançar o jogo (um resize do canvas apaga o que estava desenhado)
    window.__render = () => w.update(g, 1e-4, t);
    window.__fast = (seconds) => { for (let s = 0; s < seconds; s += 0.1) g.update(0.1); };   // só lógica, sem desenhar
    // decola já com o ponto de queda travado (senão uma rodada sorteada em 1,00× cai no primeiro quadro)
    window.__takeoff = () => { g.timer = 0.001; g.update(0.01); g.crashPoint = 500; __step(0.1); };
    return true;
  })()`);
}

async function shot(name, { fullPage = true } = {}) {
  await sleep(350);   // transições de CSS (toast, botão) e eventuais resizes do canvas
  await evaluate('__render()');
  const { width, height } = await evaluate(`({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight })`);
  const r = await send('Page.captureScreenshot', {
    format: 'jpeg', quality: 86, captureBeyondViewport: fullPage, fromSurface: true,
    ...(fullPage ? { clip: { x: 0, y: 0, width, height, scale: 1 } } : {}),
  });
  writeFileSync(path.join(OUT, `${name}.jpg`), Buffer.from(r.data, 'base64'));
  console.log(`ok → docs/screenshots/${name}.jpg`);
}

// passos de cena, rodando dentro da página
const SCENE = {
  // algumas rodadas reais (sorteio de verdade) para o histórico e a arquibancada não ficarem vazios
  history: `(() => { const g = __bb.game; let rounds = 0;
    while (rounds < 14) { const before = g.history.length; __fast(1); if (g.history.length > before) rounds++; }
    while (g.phase !== 'waiting') __fast(0.2);
    return g.history.slice(0, 5); })()`,
  betPlaced: `(() => { const g = __bb.game; g.timer = 4.4; __step(1.4);
    document.getElementById('bet').value = 25; document.getElementById('main').click(); __step(0.3); return g.bet; })()`,
  flying: `(() => { const g = __bb.game; __takeoff();
    g.elapsed = Math.log(2.1) / 0.085; __step(2.2); __bb.hud.renderLists(); return g.multiplier.toFixed(2); })()`,
  cashDusk: `(() => { const g = __bb.game; g.elapsed = Math.log(3.2) / 0.085; __step(4.5);
    document.getElementById('main').click(); __step(0.4); return g.bet; })()`,
  night: `(() => { const g = __bb.game; g.elapsed = Math.log(11) / 0.085; __step(6); return g.multiplier.toFixed(2); })()`,
  crash: `(() => { const g = __bb.game; g.crashPoint = g.multiplier + 0.001; __step(0.05); __step(0.22, 1 / 60); return g.crashPoint; })()`,
  mobileFlying: `(() => { const g = __bb.game; while (g.phase !== 'waiting') __fast(0.2); g.timer = 3; __step(1.2);
    document.getElementById('main').click(); __takeoff();
    g.elapsed = Math.log(4) / 0.085; __step(4); __bb.hud.renderLists(); return g.multiplier.toFixed(2); })()`,
};

try {
  await connect();
  await send('Page.enable');
  await send('Runtime.enable');

  // desktop
  await open({ width: 1440, height: 980, scale: 1, mobile: false });
  console.log('histórico:', await evaluate(SCENE.history));
  await evaluate(SCENE.betPlaced); await shot('ui-bet');
  console.log('voo:', await evaluate(SCENE.flying)); await shot('ui-flying');
  await evaluate(SCENE.cashDusk); await shot('ui-cashout-dusk');
  console.log('noite:', await evaluate(SCENE.night)); await shot('ui-night');
  await evaluate(SCENE.crash); await shot('ui-crash');

  // celular
  await open({ width: 390, height: 844, scale: 2, mobile: true });
  await evaluate(SCENE.history);
  console.log('celular:', await evaluate(SCENE.mobileFlying)); await shot('ui-mobile');
  const lost = await evaluate('window.__lost');
  if (lost) console.warn(`aviso: o contexto WebGL foi perdido ${lost}x; confira as imagens`);
} finally {
  ws?.close();
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
