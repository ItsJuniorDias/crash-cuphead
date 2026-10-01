#!/usr/bin/env node
/**
 * Gera a arte do jogo com o Nano Banana (Gemini 2.5 Flash Image) via OpenRouter
 * e entrega PNGs com fundo transparente, prontos para as camadas de parallax.
 *
 * O modelo não gera canal alfa: pedimos um fundo magenta chapado e removemos
 * aqui (chroma key + recorte). O original fica em art/raw/ para reprocessar
 * sem pagar de novo (--rekey).
 *
 *   npm run assets:all                     gera tudo: o avião primeiro e o resto com ele de referência
 *   npm run assets                         gera só o que ainda não existe
 *   npm run assets -- plane sun            gera apenas os assets citados
 *   npm run assets -- --force              regera tudo (sobrescreve)
 *   npm run assets -- --ref art/raw/plane.png   usa uma imagem como referência de estilo
 *   npm run assets -- --rekey              refaz a remoção de fundo a partir de art/raw/ (sem custo)
 *   npm run assets -- plane --rekey --flop espelha na horizontal (ex.: avião veio virado p/ esquerda)
 *   npm run assets -- plane --edit "..."   edita a imagem existente com o modelo (ex.: tirar a hélice)
 *   npm run assets -- --skip plane         gera tudo menos os assets citados
 *   npm run assets -- --dry-run            mostra os prompts sem chamar a API
 *
 * Hélice animada: o avião é gerado SEM hélice; 'propeller' é gerada à parte e o script
 * deriva os quadros propeller_0..3.png (pode trocá-los por quadros desenhados à mão).
 * A posição do nariz do avião é detectada e salva no manifest (plane.propeller = {u, v}).
 *
 * Ao final é gerada uma prévia em art/preview.png com todos os assets sobre fundo liso,
 * para conferir recortes e sobras de magenta.
 *
 * Requer OPENROUTER_API_KEY no ambiente ou no arquivo .env da raiz do projeto.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'assets');
const RAW_DIR = path.join(ROOT, 'art', 'raw');
const MANIFEST = path.join(OUT_DIR, 'manifest.json');
const ENDPOINT = process.env.OPENROUTER_IMAGES_URL || 'https://openrouter.ai/api/v1/images';   // override só para testes

loadDotEnv(path.join(ROOT, '.env'));
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_IMAGE_MODEL || 'google/gemini-2.5-flash-image';

// ───────────── direção de arte ─────────────

const STYLE = [
  'Hand-drawn 1930s rubber-hose cartoon style, like a vintage Fleischer-era animation cel:',
  'thick confident black ink outlines with a slight hand-made wobble, flat watercolor and gouache fills,',
  'muted vintage palette (cream, sepia, brick red, mustard yellow, olive green, dusty teal), subtle aged-paper grain.',
  'Original design, not a character or location from any existing game, film or franchise.',
  'No text, no letters, no numbers, no watermark, no signature, no frame or border.',
].join(' ');

const BACKGROUND = {
  object: 'Show ONE isolated element, centered and fully visible with a generous empty margin around it, on a perfectly flat, uniform pure magenta background (#FF00FF). No shadow, gradient, ground or scenery on the background. Do not use magenta, purple or hot pink anywhere on the subject.',
  strip: 'This is a side-scrolling parallax layer: the scenery spans the full width from the very left edge to the very right edge and is solid all the way down to the bottom edge of the image. Keep the far left and right ends simple (only continuous ground and grass at a steady height, no buildings or windmills touching the side edges). Everything above the scenery is a perfectly flat, uniform pure magenta (#FF00FF): no sky, no clouds, no sun, no airplanes, no birds, no people. Do not use magenta, purple or hot pink anywhere on the scenery.',
  opaque: '',
};

// A ordem importa: gere o avião primeiro e use-o como --ref para manter o estilo coeso.
// ref: false = não manda a referência (o modelo tende a copiar o avião para dentro de cenários).
// base: 'sky' = repinta a imagem crua desse asset (mesma composição, outra luz) — usado no ciclo dia → noite.
// halo: true = remove brilho pintado por fora do contorno de tinta (removeBackground, passo 4b).
const ASSETS = [
  { name: 'plane', bg: 'object', aspect: '4:3', prompt: 'A cheerful cartoon biplane seen exactly from the side, flying toward the RIGHT: the nose and propeller are on the RIGHT side of the image and the tail is on the LEFT side. Brick-red fuselage, cream wings with wooden struts, a round mustard-yellow nose spinner cap at the very front and NO propeller blades at all (the propeller is animated separately). A small goofy pilot with a leather cap, round goggles, pie-cut eyes and a huge grin, a yellow scarf fluttering backwards.' },
  { name: 'propeller', bg: 'object', aspect: '9:16', prompt: 'A single two-blade wooden airplane propeller seen exactly from the SIDE, standing perfectly vertical: two long narrow varnished-wood blades with rounded tips, one pointing straight up and one straight down, joined by a small round mustard-yellow hub in the middle. Only the propeller, no airplane.' },
  { name: 'sky', bg: 'opaque', aspect: '16:9', ref: false, prompt: 'A wide, empty vintage cartoon sky used as the farthest background layer: soft warm cream at the top fading to pale ochre near the bottom, a few faint painted wisps of cloud. No sun, no ground, no hills, no airplanes, no characters, nothing in the foreground.' },
  { name: 'skyDusk', bg: 'opaque', aspect: '16:9', ref: false, base: 'sky', prompt: 'the same sky at sunset: a warm orange and peach glow near the bottom fading to dusty violet and plum at the top, the clouds lit orange and gold from below. No sun.' },
  { name: 'skyNight', bg: 'opaque', aspect: '16:9', ref: false, base: 'sky', prompt: 'the same sky at night, a starry sky: deep navy blue at the top, a slightly lighter blue near the bottom, the clouds dim blue-grey lit by moonlight, many small hand-painted cream-colored stars scattered across the sky. No moon.' },
  { name: 'sun', bg: 'object', aspect: '1:1', prompt: 'A smiling cartoon sun face: a round mustard-yellow disc with pie-cut eyes, brick-red cheeks and a friendly grin, no rays.' },
  { name: 'cloud1', bg: 'object', aspect: '4:3', prompt: 'A single puffy cartoon cloud made of round bumps, cream colored with a thick black ink outline, no face.' },
  { name: 'cloud2', bg: 'object', aspect: '4:3', prompt: 'A single puffy cartoon cloud made of round bumps, cream colored with a thick black ink outline, with a sleepy happy face: pie-cut eyes, small smile, brick-red cheeks.' },
  { name: 'mountains', bg: 'strip', aspect: '21:9', ref: false, prompt: 'Distant rolling mountains and big soft hills in pale dusty teal-grey, low contrast, seen from the side, occupying the lower 60% of the image.' },
  { name: 'hills', bg: 'strip', aspect: '21:9', ref: false, prompt: 'Gentle rolling olive-green hills with small grass tufts and a winding dirt path, seen from the side, occupying the lower 45% of the image.' },
  { name: 'trees', bg: 'strip', aspect: '21:9', ref: false, prompt: 'A row of round lollipop-shaped cartoon trees, with one small red barn and one wooden windmill near the center, standing on a thin strip of green ground, seen from the side, occupying the lower 55% of the image.' },
  { name: 'ground', bg: 'strip', aspect: '21:9', ref: false, prompt: 'A close-up strip of grassy ground with a crooked cream wooden fence, a few daisies and pebbles, seen from the side, occupying the lower 30% of the image.' },
  { name: 'foreground', bg: 'strip', aspect: '21:9', ref: false, prompt: 'Very close foreground bushes and tall grass in dark olive green, big rounded shapes along the bottom edge only, occupying the lower 25% of the image.' },
  { name: 'kaboom', bg: 'object', aspect: '1:1', prompt: 'A cartoon explosion: a jagged mustard-yellow and orange starburst with black ink outline, round puffs of dark smoke and a few flying wooden debris pieces. Pure picture: no lettering or sound-effect words (like BOOM or POW) anywhere, the text is added later in the game.' },
  { name: 'coin', bg: 'object', aspect: '1:1', prompt: 'A shiny gold cartoon coin seen from the front with a simple embossed star in the middle, perfectly circular, exactly as wide as tall, no sparkles or glints around it.' },
  { name: 'smoke', bg: 'object', aspect: '1:1', prompt: 'A single round puff of dark grey-brown cartoon smoke.' },

  // ── ciclo dia → noite: o sol vira a lua e o céu fica estrelado. As variantes repintam a
  //    imagem do dia (base), então o jogo pode fazer cross-fade entre as duas sem nada procedural.
  { name: 'sunDusk', bg: 'object', aspect: '1:1', base: 'sun', prompt: 'the same smiling sun at sunset: deep orange and warm red-orange, a little sleepy, same face.' },
  { name: 'moon', bg: 'object', aspect: '1:1', prompt: 'A cartoon crescent moon, pale cream-yellow, with a sleepy friendly face on its inner curve: a closed eye, a small content smile and a brick-red cheek. Facing left like a letter C.' },
  { name: 'star', bg: 'object', aspect: '1:1', prompt: 'A single cartoon five-pointed star with slightly rounded tips, pale cream-yellow, no face.' },
  ...['mountains', 'hills', 'trees', 'ground', 'foreground'].map((n) => ({
    name: `${n}Night`, bg: 'strip', aspect: '21:9', ref: false, base: n,
    prompt: 'the same scenery at night, lit by moonlight: deep blue, slate and dark teal tones with soft pale-blue highlights along the top edges, windows and lamps may glow warm yellow.',
  })),
  ...['cloud1', 'cloud2'].map((n) => ({
    name: `${n}Night`, bg: 'object', aspect: '4:3', base: n, halo: true,   // o luar vem com brilho por fora do contorno
    prompt: 'the same cloud at night: dim blue-grey lit by moonlight, with a soft pale-blue rim, same face if it has one.',
  })),
];

// ───────────── CLI ─────────────

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: 'boolean' }, rekey: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    flop: { type: 'boolean' }, ref: { type: 'string' }, edit: { type: 'string' }, skip: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
  allowNegative: true,   // --no-flop desfaz o espelhamento
});

if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  console.log(` * Assets: ${ASSETS.map((a) => a.name).join(', ')}`);
  process.exit(0);
}

const skip = opts.skip ?? [];
const unknown = [...positionals, ...skip].filter((n) => !ASSETS.some((a) => a.name === n));
if (unknown.length) {
  console.error(`Assets desconhecidos: ${unknown.join(', ')}\nVálidos: ${ASSETS.map((a) => a.name).join(', ')}`);
  process.exit(1);
}
const selected = ASSETS.filter((a) => (!positionals.length || positionals.includes(a.name)) && !skip.includes(a.name));
if (opts.flop !== undefined && !positionals.length) {
  console.error('--flop/--no-flop precisa do nome do asset, ex.: npm run assets -- plane --rekey --flop');
  process.exit(1);
}
if (opts.edit && (positionals.length !== 1 || opts.rekey)) {
  console.error('--edit funciona com exatamente um asset, ex.: npm run assets -- plane --edit "remove the propeller"');
  process.exit(1);
}

if (!API_KEY && !opts['dry-run'] && !opts.rekey) {
  console.error('Defina OPENROUTER_API_KEY no arquivo .env (copie de .env.example) ou no ambiente.');
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
await mkdir(RAW_DIR, { recursive: true });
const manifest = existsSync(MANIFEST) ? JSON.parse(await readFile(MANIFEST, 'utf8')) : {};
if (opts.ref && !existsSync(path.resolve(opts.ref))) {
  console.error(`Imagem de referência não encontrada: ${opts.ref}`);
  process.exit(1);
}
const ref = opts.ref ? await toDataUrl(path.resolve(opts.ref)) : null;

// instrução usada para tirar a hélice desenhada de um avião antigo (a hélice agora é animada à parte)
const PLANE_NO_PROP = 'Remove the propeller blades and their motion blur completely, keeping only the round nose spinner cap at the front.';

let spent = 0, failures = 0;
for (const asset of selected) {
  const rawPath = path.join(RAW_DIR, `${asset.name}.png`);
  const outFile = `${asset.name}.png`;

  if (opts.rekey) {
    if (!existsSync(rawPath)) { console.log(`• ${asset.name}: sem original em art/raw, pulando`); continue; }
    if (opts['dry-run']) { console.log(`• ${asset.name}: reprocessaria art/raw/${asset.name}.png (dry-run)`); continue; }
    try {
      await finish(asset, await readFile(rawPath), outFile, manifest[asset.name]?.model ?? MODEL);
    } catch (err) {
      failures++;
      console.error(`• ${asset.name}: ${err.message}`);
    }
    continue;
  }
  if (opts.edit) {
    await runEdit(asset, opts.edit);
    continue;
  }
  if (!opts.force && manifest[asset.name] && existsSync(path.join(OUT_DIR, manifest[asset.name].file))) {
    // avião antigo, com a hélice desenhada (sem âncora no manifest): tira a hélice antes de seguir,
    // senão a hélice animada não aparece e o resto da arte usaria esse avião como referência
    if (asset.name === 'plane' && !manifest.plane.propeller && existsSync(rawPath)) {
      console.log('• plane: o avião atual tem a hélice desenhada; removendo para usar a hélice animada');
      await runEdit(asset, PLANE_NO_PROP);
      if (failures) break;
      continue;
    }
    console.log(`• ${asset.name}: já existe (use --force para regerar)`);
    continue;
  }
  // base: repinta a imagem crua de outro asset (ex.: o céu do dia → pôr do sol / noite)
  const basePath = asset.base && path.join(RAW_DIR, `${asset.base}.png`);
  if (basePath && !existsSync(basePath)) {
    console.error(`• ${asset.name}: precisa de art/raw/${asset.base}.png; gere '${asset.base}' antes`);
    failures++;
    continue;
  }
  const useRef = basePath ? await toDataUrl(basePath) : asset.ref === false ? null : ref;
  const prompt = basePath ? buildBasePrompt(asset) : buildPrompt(asset, !!useRef);
  if (opts['dry-run']) { console.log(`\n── ${asset.name} (${asset.aspect}, ${asset.bg}${useRef ? ', com referência' : ''})\n${prompt}`); continue; }

  process.stdout.write(`• ${asset.name}: gerando… `);
  try {
    const { buffer, cost } = await generate(prompt, asset.aspect, useRef);
    spent += cost ?? 0;
    const raw = await sharp(buffer).png().toBuffer();
    await writeFile(rawPath, raw);
    await finish(asset, raw, outFile, MODEL, cost);
    if (asset.name === 'plane') {
      console.log('  confira a orientação em art/preview.png; se o nariz estiver à esquerda: npm run assets -- plane --rekey --flop');
    }
  } catch (err) {
    failures++;
    console.log('falhou');
    console.error(`  ${err.message}`);
  }
}

if (!opts['dry-run']) {
  await writePreview();
  if (spent) console.log(`\nCusto total informado pelo OpenRouter: US$ ${spent.toFixed(4)}`);
  console.log(failures ? `\n${failures} asset(s) falharam.` : '\nPronto! Rode `npm run dev` para ver no jogo.');
}
process.exitCode = failures ? 1 : 0;

// ───────────── geração ─────────────

async function runEdit(asset, instruction) {
  const rawPath = path.join(RAW_DIR, `${asset.name}.png`);
  if (!existsSync(rawPath)) { console.error(`• ${asset.name}: não há original em art/raw para editar`); failures++; return; }
  const prompt = buildEditPrompt(asset, instruction);
  if (opts['dry-run']) { console.log(`\n── ${asset.name} (edição)\n${prompt}`); return; }
  process.stdout.write(`• ${asset.name}: editando… `);
  try {
    const previous = await readFile(rawPath);
    const { buffer, cost } = await generate(prompt, asset.aspect, await toDataUrl(rawPath));
    spent += cost ?? 0;
    const raw = await sharp(buffer).png().toBuffer();
    await writeFile(path.join(RAW_DIR, `${asset.name}.prev.png`), previous);   // backup da versão anterior
    await writeFile(rawPath, raw);
    await finish(asset, raw, `${asset.name}.png`, MODEL, cost);
  } catch (err) {
    failures++;
    console.log('falhou');
    console.error(`  ${err.message}`);
  }
}

function buildPrompt(asset, hasRef) {
  return [
    hasRef ? 'The attached image is ONLY a style sample: copy its line weight, ink and fill technique. Do NOT draw the airplane, pilot, scarf or any part of it, and ignore its pink background color (it is a keying color, not part of the palette). Draw only the subject described below.' : '',
    asset.prompt, STYLE, BACKGROUND[asset.bg],
  ].filter(Boolean).join('\n\n');
}

function buildBasePrompt(asset) {
  return [
    `Repaint the attached image as ${asset.prompt}`,
    'Keep exactly the same composition, framing, shapes, outlines and hand-painted 1930s cartoon style; only change the time of day, the lighting and the colors.',
    // a variante precisa de fundo magenta para a remoção de fundo funcionar igual à original
    asset.bg === 'opaque' ? '' : 'Keep the background a perfectly flat, uniform pure magenta (#FF00FF), exactly like the attached image: do not paint any sky, stars, glow or light into the background.',
    'No text, no letters, no watermark, no frame or border.',
  ].filter(Boolean).join('\n\n');
}

function buildEditPrompt(asset, instruction) {
  return [
    `Edit the attached image: ${instruction}`,
    'Keep everything else exactly the same: same art style, line work, colors, pose, size and framing.',
    BACKGROUND[asset.bg],
  ].filter(Boolean).join('\n\n');
}

async function generate(prompt, aspect, refDataUrl) {
  const body = { model: MODEL, prompt, aspect_ratio: aspect, n: 1 };
  if (refDataUrl) body.input_references = [{ type: 'image_url', image_url: { url: refDataUrl } }];

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'X-Title': 'Biplane Bonanza asset generator',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      const img = json.data?.[0];
      if (!img?.b64_json) throw new Error(`Resposta sem imagem: ${JSON.stringify(json).slice(0, 400)}`);
      return { buffer: Buffer.from(img.b64_json, 'base64'), cost: json.usage?.cost };
    }
    const text = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = 2 ** attempt * 1000;
      process.stdout.write(`(HTTP ${res.status}, tentando de novo em ${wait / 1000}s) `);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  }
}

async function finish(asset, raw, outFile, model, cost) {
  // --flop/--no-flop decide; sem a flag, o --rekey mantém o que já estava e uma imagem nova vem sem espelhar
  const flop = opts.flop ?? (opts.rekey || opts.edit ? manifest[asset.name]?.flop : false) ?? false;
  let image = asset.bg === 'opaque' ? await sharp(raw).png().toBuffer() : await removeBackground(raw, asset.bg, { halo: asset.halo });
  if (flop) image = await sharp(image).flop().png({ compressionLevel: 9 }).toBuffer();
  const meta = await sharp(image).metadata();
  await writeFile(path.join(OUT_DIR, outFile), image);
  const entry = {
    file: outFile, kind: asset.bg, width: meta.width, height: meta.height, flop,
    model, generatedAt: new Date().toISOString(),
  };
  // a âncora da hélice só vale para avião SEM hélice desenhada: gerado com o prompt atual ou editado.
  // No --rekey, mantém o que já existia (um avião antigo com hélice desenhada continua sem âncora).
  if (asset.name === 'plane' && (!opts.rekey || manifest.plane?.propeller)) entry.propeller = await noseAnchor(image);
  if (asset.name === 'propeller') entry.frames = await writePropellerFrames(image);
  manifest[asset.name] = entry;
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`ok → public/assets/${outFile} (${meta.width}×${meta.height}${flop ? ', espelhado' : ''})${cost != null ? ` US$ ${cost.toFixed(4)}` : ''}`);
  if (entry.frames) console.log(`  quadros da hélice: ${entry.frames.join(', ')}`);
}

// ───────────── hélice ─────────────

/**
 * Nariz do avião (virado para a direita): a coluna mais à direita que tem um bloco opaco
 * alto (>= 25% da altura). A ponta da asa costuma ir mais longe, mas é fina e fica de fora.
 * Devolve {u, v} normalizados; confira o "+" vermelho em art/preview.png.
 */
async function noseAnchor(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const minRun = Math.round(h * 0.25);
  for (let x = w - 1; x >= 0; x--) {
    let best = 0, bestStart = 0, run = 0;
    for (let y = 0; y < h; y++) {
      if (data[(y * w + x) * 4 + 3] > 128) {
        if (++run > best) { best = run; bestStart = y - run + 1; }
      } else run = 0;
    }
    if (best >= minRun) return { u: +(x / w).toFixed(4), v: +((bestStart + best / 2) / h).toFixed(4) };
  }
  return { u: 1, v: 0.5 };
}

/**
 * Quadros de uma hélice girando vista de lado (meia volta, já que as duas pás são iguais):
 * a pá encolhe com o cosseno do ângulo, inverte depois de passar de quina e deixa um rastro
 * curto do quadro anterior. O cubo é recolocado redondo por cima, em tamanho real.
 * Todos os quadros têm o mesmo tamanho e o cubo no centro, então a âncora não muda.
 */
async function writePropellerFrames(png) {
  const N = 8;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  // cubo = linha opaca mais larga perto do centro
  let hubW = 0;
  for (let y = Math.round(h * 0.4); y < Math.round(h * 0.6); y++) {
    let l = -1, r = -1;
    for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 128) { if (l < 0) l = x; r = x; }
    if (l >= 0) hubW = Math.max(hubW, r - l + 1);
  }
  const R = Math.max(6, Math.round(Math.min(hubW, h * 0.12) / 2) + 3);
  const cx = Math.round(w / 2), cy = Math.round(h / 2);
  const hb = { left: Math.max(0, cx - R), top: Math.max(0, cy - R) };
  hb.width = Math.min(w, cx + R) - hb.left;
  hb.height = Math.min(h, cy + R) - hb.top;
  const hub = await sharp(png).extract(hb).composite([{
    input: Buffer.from(`<svg width="${hb.width}" height="${hb.height}"><circle cx="${cx - hb.left}" cy="${cy - hb.top}" r="${R}" fill="#fff"/></svg>`),
    blend: 'dest-in',
  }]).png().toBuffer();

  const blade = async (s, alpha) => {
    const hh = Math.max(6, Math.round(h * Math.max(0.06, Math.abs(s))));
    let img = await sharp(png).resize(w, hh, { fit: 'fill' }).flip(s < 0).png().toBuffer();
    if (alpha < 1) {
      img = await sharp(img).composite([{ input: { create: { width: w, height: hh, channels: 4, background: { r: 0, g: 0, b: 0, alpha } } }, blend: 'dest-in' }]).png().toBuffer();
    }
    return { input: img, left: 0, top: Math.round((h - hh) / 2) };
  };

  const cosAt = (k) => Math.cos((((k % N) + N) % N) * Math.PI / N);
  const files = [];
  for (let k = 0; k < N; k++) {
    const layers = [await blade(cosAt(k - 1), 0.22), await blade(cosAt(k), 1), { input: hub, left: hb.left, top: hb.top }];
    const file = `propeller_${k}.png`;
    await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(layers).png({ compressionLevel: 9 }).toFile(path.join(OUT_DIR, file));
    files.push(file);
  }
  return files;
}

// ───────────── remoção de fundo ─────────────

/**
 * Remove o fundo chapado pedido no prompt e devolve um PNG transparente recortado.
 *
 * 1. Cor do fundo = mediana da linha superior (o modelo raramente entrega #FF00FF exato;
 *    é comum vir um rosa-magenta como rgb(217,63,137)).
 * 2. Flood fill a partir das bordas com tolerância menor que a distância do vermelho-tijolo
 *    ao magenta, para não "vazar" para dentro do desenho.
 * 3. Vãos fechados (entre asas, rodas, fitas do cachecol): pixels quase idênticos ao fundo,
 *    com tolerância estreita. Só se o fundo for magenta; com outra cor (ex.: branco) isso
 *    apagaria partes do desenho.
 * 4. Bordas: pixels encostados no fundo ganham alfa parcial (antisserrilhado) e perdem o tom magenta.
 */
async function removeBackground(input, kind, { halo = false } = {}) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const N = w * h;
  const key = medianColor(data, w);
  const magentaish = key[0] - key[1] > 80 && key[2] - key[1] > 40;
  if (!magentaish) {
    const msg = `o fundo veio rgb(${key.join(',')}), não magenta`;
    // imagem nova com fundo errado não vira asset (um céu pintado taparia o jogo); no --rekey o usuário aceita conscientemente
    if (!opts.rekey) throw new Error(`${msg}. Original salvo em art/raw/; rode de novo para regerar (ou --rekey para aceitar assim mesmo).`);
    console.warn(`\n  aviso: ${msg}; removendo só o fundo ligado às bordas.`);
  }

  const dist = (i) => Math.hypot(data[i] - key[0], data[i + 1] - key[1], data[i + 2] - key[2]);
  const ramp = (d, lo, hi) => Math.min(1, Math.max(0, (d - lo) / (hi - lo)));
  const touched = new Uint8Array(N);
  const apply = (p, a) => {
    const i = p * 4;
    touched[p] = 1;
    if (a <= 0) { data[i + 3] = 0; return; }
    // "desmistura" a cor do fundo que vazou no pixel de borda
    for (let c = 0; c < 3; c++) data[i + c] = Math.min(255, Math.max(0, (data[i + c] - (1 - a) * key[c]) / a));
    data[i + 3] = Math.round(data[i + 3] * a);
  };

  // 2. fundo ligado às bordas
  const FLOOD = [40, 80];
  const seen = new Uint8Array(N), stack = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const p = stack.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    const a = ramp(dist(p * 4), ...FLOOD);
    if (a >= 1) continue;
    apply(p, a);
    const x = p % w;
    if (x > 0) stack.push(p - 1);
    if (x < w - 1) stack.push(p + 1);
    if (p >= w) stack.push(p - w);
    if (p < N - w) stack.push(p + w);
  }

  // 3. vãos fechados
  if (magentaish) {
    const HOLE = [30, 60];
    for (let p = 0; p < N; p++) {
      if (touched[p]) continue;
      const a = ramp(dist(p * 4), ...HOLE);
      if (a < 1) apply(p, a);
    }
  }

  // 4. bordas (raio de 2 px em volta do que ficou transparente)
  const EDGE = [40, 140];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, i = p * 4;
    if (data[i + 3] === 0) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && data[(yy * w + xx) * 4 + 3] === 0) { near = true; break; }
    }
    if (!near) continue;
    if (!touched[p]) { const a = ramp(dist(i), ...EDGE); if (a < 1) apply(p, a); }
    if (magentaish) {
      const m = Math.min(data[i], data[i + 2]) - data[i + 1];   // excesso de magenta
      if (m > 0) { data[i] -= m; data[i + 2] -= m; }
    }
  }

  // 4b. halo (opcional): brilho que o modelo pinta POR FORA do contorno de tinta (ex.: luar nas nuvens)
  //     e que, misturado ao magenta, vira uma borda acinzentada. Remove o que for mais claro que a tinta
  //     e estiver ligado ao fundo, numa faixa estreita: a tinta segura a expansão para dentro do desenho.
  if (halo) {
    const RADIUS = Math.max(6, Math.round(Math.max(w, h) * 0.03));
    const luma = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const depth = new Int16Array(N).fill(-1);
    let queue = [];
    for (let p = 0; p < N; p++) if (data[p * 4 + 3] === 0) { depth[p] = 0; queue.push(p); }
    let removed = 0;
    for (let d = 1; d <= RADIUS && queue.length; d++) {
      const next = [];
      for (const p of queue) {
        const x = p % w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < N - w ? p + w : -1]) {
          if (q < 0 || depth[q] !== -1) continue;
          const i = q * 4;
          if (data[i + 3] === 0) { depth[q] = 0; continue; }
          if (luma(i) < 75) { depth[q] = -2; continue; }   // tinta: para aqui
          depth[q] = d; data[i + 3] = 0; removed++;
          next.push(q);
        }
      }
      queue = next;
    }
    if (removed) console.log(`\n  halo: ${removed} px de brilho fora do contorno removidos`);
  }

  // 5. magenta forte que sobrou no meio do desenho (ex.: fundo "visto" através de um vidro).
  //    O prompt proíbe magenta/rosa na arte, então neutralizar é seguro; vermelho, pele e creme não são afetados.
  if (magentaish) {
    for (let i = 0; i < data.length; i += 4) {
      const m = Math.min(data[i], data[i + 2]) - data[i + 1];
      if (m > 30) { data[i] -= m; data[i + 2] -= m; }
    }
  }

  // 6. pixel 100% transparente fica com a cor da tinta: o WebGL filtra com alfa não pré-multiplicado
  //    e misturaria a cor que sobrou do fundo nas bordas (halo avermelhado).
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) { data[i] = 27; data[i + 1] = 20; data[i + 2] = 16; }
  }

  // 7. faixas: descarta o que flutua solto acima do cenário (nuvem, pássaro, avião copiado da referência).
  //    "Cenário" = tudo ligado à base do desenho (a linha opaca mais baixa, que pode não ser a borda da imagem).
  if (kind === 'strip') {
    let base = -1;
    for (let y = h - 1; y >= 0 && base < 0; y--) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 10) { base = y; break; }
    if (base < 0) throw new Error('a remoção de fundo apagou a imagem inteira');
    const keep = new Uint8Array(N), stack = [];
    for (let y = Math.max(0, base - Math.round(h * 0.03)); y <= base; y++) for (let x = 0; x < w; x++) stack.push(y * w + x);
    while (stack.length) {
      const p = stack.pop();
      if (keep[p] || data[p * 4 + 3] <= 10) continue;
      keep[p] = 1;
      const x = p % w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (p >= w) stack.push(p - w);
      if (p < N - w) stack.push(p + w);
    }
    let dropped = 0;
    for (let p = 0; p < N; p++) {
      if (!keep[p] && data[p * 4 + 3] > 10) { data[p * 4 + 3] = 0; data[p * 4] = 27; data[p * 4 + 1] = 20; data[p * 4 + 2] = 16; dropped++; }
    }
    if (dropped > N * 0.01) console.warn(`\n  aviso: ${Math.round((100 * dropped) / N)}% da imagem flutuava solta acima da faixa e foi removida.`);
  }

  // recorte: objetos em todos os lados; faixas em cima e embaixo (largura intacta para repetir)
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] > 10) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('a remoção de fundo apagou a imagem inteira');
  const pad = 4;
  let box;
  if (kind === 'strip') {
    const top = Math.max(0, minY - pad);
    box = { left: 0, top, width: w, height: maxY + 1 - top };   // sem margem embaixo: a faixa encosta no chão da tela
    let solid = 0;
    for (let x = 0; x < w; x++) if (data[(maxY * w + x) * 4 + 3] > 200) solid++;
    if (solid < 0.9 * w) console.warn(`\n  aviso: só ${Math.round((100 * solid) / w)}% da base da faixa é opaca; podem aparecer buracos no jogo. Considere regerar.`);
  } else {
    const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
    box = { left, top, width: Math.min(w, maxX + pad + 1) - left, height: Math.min(h, maxY + pad + 1) - top };
  }

  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract(box)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function medianColor(data, w) {
  const ch = [[], [], []];
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) ch[c].push(data[x * 4 + c]);
  return ch.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
}

// ───────────── prévia ─────────────

/** Folha de contato com todos os assets sobre fundo liso: sobras de magenta saltam aos olhos. */
async function writePreview() {
  const names = ASSETS.map((a) => a.name).filter((n) => manifest[n] && existsSync(path.join(OUT_DIR, manifest[n].file)));
  if (!names.length) return;
  const CELL = 320, LABEL = 30, COLS = 4, rows = Math.ceil(names.length / COLS);
  const layers = [];
  for (const [i, n] of names.entries()) {
    const img = await sharp(path.join(OUT_DIR, manifest[n].file))
      .resize(CELL - 24, CELL - LABEL - 16, { fit: 'inside' }).png().toBuffer();
    const { width, height } = await sharp(img).metadata();
    const x = (i % COLS) * CELL, y = Math.floor(i / COLS) * CELL;
    const label = `${n}${manifest[n].flop ? ' (espelhado)' : ''}`;
    const left = x + Math.round((CELL - width) / 2), top = y + LABEL + Math.round((CELL - LABEL - height) / 2);
    layers.push(
      { input: Buffer.from(`<svg width="${CELL}" height="${LABEL}"><text x="12" y="21" font-family="monospace" font-size="17" fill="#1b1410">${label}</text></svg>`), left: x, top: y },
      { input: img, left, top },
    );
    const anchor = n === 'plane' && manifest[n].propeller;
    if (anchor) {   // "+" vermelho onde a hélice será presa
      const ax = left + Math.round(anchor.u * width), ay = top + Math.round(anchor.v * height);
      layers.push({ input: Buffer.from('<svg width="25" height="25"><path d="M12.5 0V25M0 12.5H25" stroke="#e00" stroke-width="4"/></svg>'), left: Math.max(0, ax - 12), top: Math.max(0, ay - 12) });
    }
  }
  await sharp({ create: { width: COLS * CELL, height: rows * CELL, channels: 4, background: '#7f9c8c' } })
    .composite(layers).png().toFile(path.join(ROOT, 'art', 'preview.png'));
  console.log('\nPrévia de todos os assets: art/preview.png');
}

// ───────────── util ─────────────

async function toDataUrl(file) {
  const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
  return `data:image/${ext};base64,${(await readFile(file)).toString('base64')}`;
}

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trimStart().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}
