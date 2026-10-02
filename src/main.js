import './style.css';
import { Game } from './game.js';
import { World } from './scene.js';
import { loadTextures } from './textures.js';
import { Sfx } from './audio.js';
import { Hud, fmt } from './ui.js';

async function main() {
  // As texturas de texto são desenhadas em canvas, então as fontes precisam estar prontas.
  await Promise.all([document.fonts.load('48px Rye'), document.fonts.load('16px "Special Elite"')]).catch(() => {});
  const textures = await loadTextures();

  const game = new Game();
  const sfx = new Sfx();
  const world = new World(document.getElementById('stage'), textures);
  const hud = new Hud(game, sfx);
  document.getElementById('loading').remove();

  game.addEventListener('phase', ({ detail }) => {
    world.onPhase(detail.phase);
    if (detail.phase === 'flying') sfx.takeoff();
    if (detail.phase === 'crashed') sfx.crash();
  });
  game.addEventListener('countdown', () => sfx.tick());
  game.addEventListener('cashout', ({ detail }) => {
    world.coins();
    sfx.cashout(detail.multiplier);
    hud.toast(`+${fmt(detail.win)} @ ${detail.multiplier.toFixed(2)}×`);
  });

  game.start();
  if (import.meta.env.DEV) window.__bb = { game, world, textures, sfx };   // inspeção no console (só em dev)

  // ?audiodebug na URL: mostra o estado do áudio na tela (útil para testar no celular)
  if (new URLSearchParams(location.search).has('audiodebug')) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9;background:#000;color:#7f7;font:12px monospace;padding:4px 8px;border-radius:4px';
    document.body.append(el);
    setInterval(() => { el.textContent = `áudio: ${sfx.state}${sfx.muted ? ' (mudo)' : ''}`; }, 300);
  }

  let last = performance.now();
  world.renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    game.update(dt);
    world.update(game, dt, now / 1000);
    hud.update();
    sfx.update(game, world.tod);
  });
}

main().catch((err) => {
  console.error(err);
  const loading = document.getElementById('loading');
  if (loading) loading.textContent = 'Could not start the game (is WebGL available?).';
});
