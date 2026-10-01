import { COLORS as C } from './config.js';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Texto "letreiro de cinema": contorno grosso de tinta + sombra deslocada. */
export function outlinedText(ctx, text, x, y, size, fill, { rot = 0, maxWidth = Infinity } = {}) {
  ctx.save();
  ctx.font = `${size}px Rye`;
  const w = ctx.measureText(text).width + size * 0.3;
  if (w > maxWidth) { size *= maxWidth / w; ctx.font = `${size}px Rye`; }
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.fillStyle = C.ink; ctx.fillText(text, size * 0.07, size * 0.09);
  ctx.lineWidth = size * 0.18; ctx.strokeStyle = C.ink; ctx.strokeText(text, 0, 0);
  ctx.fillStyle = fill; ctx.fillText(text, 0, 0);
  ctx.restore();
}

export function starburst(ctx, x, y, r1, r2, n, rot, fill, lineWidth = 6) {
  ctx.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1, a = rot + i * Math.PI / n;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = lineWidth; ctx.strokeStyle = C.ink; ctx.lineJoin = 'round'; ctx.stroke();
}
