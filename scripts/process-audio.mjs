#!/usr/bin/env node
/**
 * Trata os sons baixados do Pixabay (art/audio-src/) e gera os arquivos do jogo (public/audio/).
 *
 *   npm run audio            processa tudo o que estiver em art/audio-src
 *   npm run audio -- engine  processa só os sons citados
 *
 * - Efeitos curtos: corta silêncio no começo/fim, fade de 30 ms no final, normaliza o volume.
 * - Loops: recorta um trecho estável e faz cross-fade do fim com o começo (emenda inaudível).
 * - Música: normaliza e, se pedido, faz o mesmo cross-fade do loop.
 * Requer ffmpeg/ffprobe no PATH.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'art', 'audio-src');
const OUT = path.join(ROOT, 'public', 'audio');

// target = loudness integrada (LUFS) depois do tratamento; o mix fino fica em src/audio.js (MIX)
const SOUNDS = [
  // ── efeitos curtos
  { name: 'tick', src: 'tick-105066.mp3', kind: 'shot', target: -15 },
  { name: 'click', src: 'click-229861.mp3', kind: 'shot', target: -18 },
  { name: 'bet', src: 'bet-229314.mp3', kind: 'shot', target: -16 },
  { name: 'cashout', src: 'cashout-129698.mp3', kind: 'shot', target: -15 },
  { name: 'bigwin', src: 'bigwin-47995.mp3', kind: 'shot', target: -15, stereo: true },
  { name: 'takeoff', src: 'takeoff-153264.mp3', kind: 'shot', target: -15, maxLength: 1.8 },
  { name: 'fall', src: 'fall-176647.mp3', kind: 'shot', target: -16 },
  { name: 'explosion', src: 'explosion-352744.mp3', kind: 'shot', target: -13 },
  { name: 'owl', src: 'owl-139676.mp3', kind: 'shot', target: -17 },
  // ── loops (trecho [start, end] estável, medido com astats)
  { name: 'engine', src: 'engine-67757.mp3', kind: 'loop', start: 0.5, end: 15.5, xfade: 0.4, target: -18 },
  { name: 'projector', src: 'projector-26188.mp3', kind: 'loop', start: 1, end: 31, xfade: 0.6, target: -24 },
  { name: 'crickets', src: 'crickets-7015.mp3', kind: 'loop', start: 1, end: 31, xfade: 1, target: -22, stereo: true },
  // ── música (adicione os arquivos em art/audio-src com estes nomes)
  { name: 'musicDay', src: 'music-day-164255.mp3', kind: 'music', target: -20, stereo: true },
  { name: 'musicDay2', src: 'music-day-114929.mp3', kind: 'music', target: -20, stereo: true },
  { name: 'musicNight', src: 'music-night-111372.mp3', kind: 'music', target: -21, stereo: true },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
mkdirSync(OUT, { recursive: true });

const run = (args) => execFileSync('ffmpeg', ['-hide_banner', '-nostats', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const probe = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
function loudness(file) {
  const r = execFileSync('sh', ['-c', `ffmpeg -hide_banner -nostats -i "${file}" -af ebur128=peak=true -f null - 2>&1`]).toString();
  const summary = r.slice(r.lastIndexOf('Summary:'));
  const I = Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]);
  const peak = Number(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]);
  return { I, peak };
}

const manifest = {};
const tmp = path.join(OUT, '.tmp.wav');
let done = 0;

for (const s of SOUNDS) {
  if (only.length && !only.includes(s.name)) continue;
  const src = path.join(SRC, s.src);
  if (!existsSync(src)) { console.log(`• ${s.name}: faltando art/audio-src/${s.src} (pulando)`); continue; }

  const ch = s.stereo ? 2 : 1;
  // 1) recorte/emenda em WAV temporário
  if (s.kind === 'loop') {
    const { start: a, end: b, xfade: x } = s;
    const graph = [
      `[0]atrim=start=${a}:end=${a + x},asetpts=N/SR/TB,afade=t=in:d=${x}:curve=qsin[head]`,
      `[0]atrim=start=${b}:end=${b + x},asetpts=N/SR/TB,afade=t=out:d=${x}:curve=qsin[tail]`,
      `[head][tail]amix=inputs=2:normalize=0[xf]`,
      `[0]atrim=start=${a + x}:end=${b},asetpts=N/SR/TB[body]`,
      `[xf][body]concat=n=2:v=0:a=1[out]`,
    ].join(';');
    run(['-i', src, '-filter_complex', graph, '-map', '[out]', '-ac', String(ch), '-ar', '44100', tmp]);
  } else {
    // corta silêncio no começo e no fim (o fim via reverse) e suaviza o final
    const trim = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.005,areverse,silenceremove=start_periods=1:start_threshold=-55dB:start_silence=0.01,areverse';
    const cut = s.maxLength ? `,atrim=end=${s.maxLength}` : '';
    run(['-i', src, '-af', `${trim}${cut},asetpts=N/SR/TB`, '-ac', String(ch), '-ar', '44100', tmp]);
    const d = probe(tmp);
    const fade = Math.min(0.03, d / 4);
    run(['-i', tmp, '-af', `afade=t=out:st=${Math.max(0, d - fade)}:d=${fade}`, '-ar', '44100', `${tmp}.wav`]);
    run(['-i', `${tmp}.wav`, tmp]);
  }

  // 2) volume: loudness integrada (ou pico, para sons curtos demais para medir)
  const { I, peak } = loudness(tmp);
  const gain = Number.isFinite(I) && I > -60 ? s.target - I : -3 - peak;
  const bitrate = s.kind === 'music' ? '96k' : ch === 2 ? '112k' : '96k';   // música lo-fi de propósito: 96k basta e pesa menos no celular
  const outFile = `${s.name}.mp3`;
  run(['-i', tmp, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.79:level=false`, '-c:a', 'libmp3lame', '-b:a', bitrate, path.join(OUT, outFile)]);

  const after = loudness(path.join(OUT, outFile));
  const duration = probe(path.join(OUT, outFile));
  manifest[s.name] = { file: outFile, kind: s.kind, loop: s.kind !== 'shot', duration: +duration.toFixed(3) };
  console.log(`ok → public/audio/${outFile}  ${duration.toFixed(2)} s  ${after.I.toFixed(1)} LUFS  pico ${after.peak.toFixed(1)} dBFS  ${(statSync(path.join(OUT, outFile)).size / 1024).toFixed(0)} KB`);
  done++;
}

for (const f of [tmp, `${tmp}.wav`]) rmSync(f, { force: true });

// mantém no manifest o que não foi reprocessado desta vez
const manifestPath = path.join(OUT, 'manifest.json');
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
writeFileSync(manifestPath, `${JSON.stringify({ ...previous, ...manifest }, null, 2)}\n`);
console.log(`\n${done} som(ns) processado(s). Manifest: public/audio/manifest.json`);
