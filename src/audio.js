// Som do jogo: samples do Pixabay (public/audio, gerados por scripts/process-audio.mjs) com
// versões sintetizadas de reserva para qualquer som que ainda não exista.
//
// Celular:
// - iOS/Android só liberam áudio dentro de um gesto (toque/clique/tecla). Destravamos no primeiro
//   gesto em QUALQUER lugar da página e retomamos sempre que o sistema suspender o áudio.
// - No iPhone, a chave de silêncio corta o Web Audio. Pedimos a sessão de "reprodução"
//   (navigator.audioSession, iOS 17+) e, nos mais antigos, tocamos um <audio> mudo em loop.
// - Os arquivos são baixados já no carregamento; a decodificação acontece quando o áudio destrava.

const AUDIO_DIR = `${import.meta.env.BASE_URL}audio/`;
const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];

/** Volume de cada som (os arquivos já vêm normalizados; aqui é só o mix). */
const MIX = {
  tick: 0.55, click: 0.3, bet: 0.6, cashout: 0.8, bigwin: 0.7, takeoff: 0.7, fall: 0.5, explosion: 0.9, owl: 0.55,
  engine: 0.3, projector: 0.16, crickets: 0.5, music: 0.42,
};
const BIG_WIN = 5;          // saque a partir deste multiplicador toca a fanfarra
const MUSIC_FADE = 1.5;     // segundos de cross-fade entre uma faixa e a próxima
// playlists: o dia alterna duas faixas (menos repetição); a noite repete uma
const PLAYLISTS = { day: ['musicDay', 'musicDay2'], night: ['musicNight'] };
const LOOP_FADE = 0.03;     // segundos de cross-fade aplicados na emenda dos loops, já decodificados

const smoothstep = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Sfx {
  #muted = false;
  #ctx = null;
  #master = null;
  #bus = {};                 // sfx / ambience / music
  #raw = new Map();          // nome → { bytes, kind } baixados antes de o áudio destravar
  #buffers = new Map();      // nome → AudioBuffer pronto
  #loops = {};               // nome → { src, gain } tocando
  #lanes = {};               // playlist → { gain, i, nextAt, timer }
  #synthEngine = null;
  #primed = false;
  #media = null;
  #owlDone = false;

  constructor() {
    const onGesture = () => this.unlock();
    for (const type of GESTURES) window.addEventListener(type, onGesture, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => this.#onVisibility());
    this.#prefetch();
  }

  get muted() { return this.#muted; }
  set muted(value) {
    this.#muted = value;
    if (this.#master) this.#master.gain.setTargetAtTime(value ? 0 : 1, this.#ctx.currentTime, 0.02);
  }

  /** Estado do áudio, para depuração (`?audiodebug` na URL mostra na tela). */
  get state() {
    if (!this.#ctx) return 'sem contexto';
    return `${this.#ctx.state} · ${this.#buffers.size}/${this.#raw.size} sons`;
  }

  /** Precisa rodar dentro de um gesto do usuário; pode ser chamado quantas vezes for. */
  unlock() {
    try {
      if (!this.#ctx) this.#create();
      const ctx = this.#ctx;
      if (!ctx) return;
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      if (!this.#primed) {
        // iOS: tocar um buffer vazio dentro do gesto destrava a saída de som
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination);
        src.start(0);
        this.#primed = true;
      }
      this.#playThroughSilentSwitch();
      this.#decodeAll();
    } catch { /* sem áudio */ }
  }

  // ───────────── eventos do jogo ─────────────

  tick() { this.#play('tick') || this.#tone(880, 0.08, 'square', 0.05); }
  click() { this.#play('click') || this.#tone(1400, 0.03, 'square', 0.03); }
  bet() { this.#play('bet') || this.#tone(988, 0.12, 'triangle', 0.08); }
  takeoff() { this.#play('takeoff') || [392, 523, 659, 784].forEach((f, i) => this.#tone(f, 0.18, 'square', 0.06, i * 0.08)); }

  cashout(multiplier) {
    this.#play('cashout') || [1047, 1319, 1568, 2093].forEach((f, i) => this.#tone(f, 0.25, 'triangle', 0.1, i * 0.06));
    if (multiplier >= BIG_WIN) this.#play('bigwin', { delay: 0.35 });
  }

  /** Queda: o estrondo e, logo depois, o apito dos pedaços caindo. */
  crash() {
    if (!this.#play('explosion')) this.#synthBoom();
    this.#play('fall', { delay: 0.25 });
  }

  /** A cada frame: motor acompanha o multiplicador; grilos, coruja e música acompanham a noite. */
  update(game, tod = 0) {
    const ctx = this.#ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const flying = game.phase === 'flying';
    const m = game.multiplier;

    const engine = this.#loops.engine;
    if (engine) {
      engine.gain.gain.setTargetAtTime(flying ? MIX.engine : 0, t, flying ? 0.15 : 0.08);
      engine.src.playbackRate.setTargetAtTime(Math.min(1.9, 0.85 + 0.25 * Math.log(m)), t, 0.1);
    } else if (this.#synthEngine) {
      const { osc, osc2, gain } = this.#synthEngine;
      const f = 55 + 40 * Math.log(m + 1) + Math.sin(performance.now() / 40) * 3;
      gain.gain.setTargetAtTime(flying ? 0.06 : 0, t, 0.08);
      osc.frequency.setTargetAtTime(f, t, 0.05);
      osc2.frequency.setTargetAtTime(f * 3, t, 0.05);
    }

    const night = smoothstep(tod, 0.55, 0.9);
    this.#loops.crickets?.gain.gain.setTargetAtTime(MIX.crickets * night, t, 0.5);
    this.#lanes.day?.gain.gain.setTargetAtTime(MIX.music * (1 - night), t, 0.6);
    this.#lanes.night?.gain.gain.setTargetAtTime(MIX.music * night, t, 0.6);
    if (night > 0.5 && !this.#owlDone) { this.#owlDone = true; this.#play('owl'); }   // a coruja anuncia a noite
    if (tod < 0.2) this.#owlDone = false;
  }

  // ───────────── infraestrutura ─────────────

  #create() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = this.#muted ? 0 : 1;
    master.connect(ctx.destination);
    for (const name of ['sfx', 'ambience', 'music']) {
      const g = ctx.createGain();
      g.connect(master);
      this.#bus[name] = g;
    }
    this.#ctx = ctx;
    this.#master = master;
  }

  async #prefetch() {
    const manifest = await fetch(`${AUDIO_DIR}manifest.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    const entries = Object.entries(manifest);
    // efeitos e ambiente primeiro; as músicas (maiores) depois
    for (const group of [entries.filter(([, e]) => e.kind !== 'music'), entries.filter(([, e]) => e.kind === 'music')]) {
      await Promise.all(group.map(async ([name, entry]) => {
        try {
          const res = await fetch(`${AUDIO_DIR}${entry.file}`);
          if (res.ok) this.#raw.set(name, { bytes: await res.arrayBuffer(), kind: entry.kind });
        } catch { /* esse som fica com a versão sintetizada (ou sem música) */ }
      }));
      if (this.#ctx) this.#decodeAll();
    }
  }

  #decodeAll() {
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const [name, { bytes, kind }] of this.#raw) {
      if (this.#buffers.has(name) || bytes.decoding) continue;
      bytes.decoding = true;
      new Promise((resolve, reject) => ctx.decodeAudioData(bytes.slice(0), resolve, reject))
        .then((buf) => {
          this.#buffers.set(name, kind === 'loop' ? seamlessLoop(ctx, buf, LOOP_FADE) : trimEdges(ctx, buf));
          if (kind === 'loop') this.#startLoop(name);
          if (kind === 'music') this.#startMusic();
        })
        .catch(() => { bytes.decoding = false; });
    }
    if (!this.#raw.has('engine') && !this.#synthEngine) this.#startSynthEngine();
  }

  #startLoop(name) {
    const ctx = this.#ctx, buffer = this.#buffers.get(name);
    if (!buffer || this.#loops[name]) return;
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    src.loop = true;
    // projetor sempre ligado (bem baixo); motor, grilos e música começam mudos e o update() abre
    gain.gain.value = name === 'projector' ? MIX.projector : 0;
    const bus = name === 'engine' ? 'sfx' : 'ambience';
    src.connect(gain).connect(this.#bus[bus]);
    // começa num ponto aleatório para os loops não soarem sempre iguais
    src.start(0, Math.random() * buffer.duration);
    this.#loops[name] = { src, gain };
    if (name === 'engine' && this.#synthEngine) { this.#synthEngine.gain.gain.value = 0; }
  }

  /** Liga as playlists de dia e de noite assim que houver alguma faixa decodificada. */
  #startMusic() {
    for (const lane of Object.keys(PLAYLISTS)) {
      if (this.#lanes[lane] || !PLAYLISTS[lane].some((n) => this.#buffers.has(n))) continue;
      const gain = this.#ctx.createGain();
      gain.gain.value = lane === 'day' ? MIX.music : 0;   // o update() faz a passagem dia → noite
      gain.connect(this.#bus.music);
      this.#lanes[lane] = { gain, i: 0, nextAt: 0, timer: 0 };
      this.#queueTrack(lane);
    }
  }

  /**
   * Agenda a próxima faixa da playlist no relógio do áudio, entrando MUSIC_FADE segundos antes do
   * fim da atual (cross-fade). Assim finais musicais nunca viram uma emenda dura de loop.
   */
  #queueTrack(lane) {
    const ctx = this.#ctx, L = this.#lanes[lane];
    const names = PLAYLISTS[lane].filter((n) => this.#buffers.has(n));
    if (!names.length) return;
    const buffer = this.#buffers.get(names[L.i++ % names.length]);
    const src = ctx.createBufferSource(), fade = ctx.createGain();
    const t0 = Math.max(ctx.currentTime + 0.05, L.nextAt), end = t0 + buffer.duration;
    src.buffer = buffer;
    fade.gain.setValueAtTime(0, t0);
    fade.gain.linearRampToValueAtTime(1, t0 + MUSIC_FADE);
    fade.gain.setValueAtTime(1, end - MUSIC_FADE);
    fade.gain.linearRampToValueAtTime(0, end);
    src.connect(fade).connect(L.gain);
    src.start(t0);
    src.stop(end + 0.05);
    L.nextAt = end - MUSIC_FADE;
    // agenda a seguinte ~3 s antes de precisar dela (com o áudio suspenso o relógio para, então reconfere)
    clearTimeout(L.timer);
    L.timer = setTimeout(() => this.#queueTrack(lane), Math.max(250, (L.nextAt - ctx.currentTime - 3) * 1000));
  }

  /** Toca um sample; devolve false se ele não existir (quem chamou usa a versão sintetizada). */
  #play(name, { delay = 0, rate = 1 } = {}) {
    const ctx = this.#ctx, buffer = this.#buffers.get(name);
    if (!ctx || !buffer) return false;
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    gain.gain.value = MIX[name] ?? 0.6;
    src.connect(gain).connect(this.#bus.sfx);
    src.start(ctx.currentTime + delay);
    return true;
  }

  #playThroughSilentSwitch() {
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* iOS < 17 */ }
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (!isIOS) return;
    if (!this.#media) {
      const el = document.createElement('audio');
      el.src = silentWavUrl();
      el.loop = true;
      el.setAttribute('playsinline', '');
      el.setAttribute('x-webkit-airplay', 'deny');
      this.#media = el;
    }
    if (this.#media.paused && !document.hidden) this.#media.play().catch(() => {});
  }

  #onVisibility() {
    if (document.hidden) {
      // em segundo plano: silencia e libera o sistema (e não deixa o <audio> mudo no "Tocando agora")
      this.#ctx?.suspend().catch(() => {});
      this.#media?.pause();
    } else if (this.#ctx) {
      this.#ctx.resume().catch(() => {});   // se o iOS recusar sem gesto, o próximo toque resolve
      if (this.#media) this.#media.play().catch(() => {});
    }
  }

  // ───────────── reservas sintetizadas ─────────────

  #startSynthEngine() {
    const ctx = this.#ctx;
    const osc = ctx.createOscillator(), osc2 = ctx.createOscillator();
    const filter = ctx.createBiquadFilter(), gain = ctx.createGain(), gain2 = ctx.createGain();
    osc.type = 'sawtooth';
    osc2.type = 'square';
    filter.type = 'lowpass'; filter.frequency.value = 1400;
    gain2.gain.value = 0.35;
    gain.gain.value = 0;
    osc.connect(filter);
    osc2.connect(gain2).connect(filter);
    filter.connect(gain).connect(this.#bus.sfx);
    osc.start();
    osc2.start();
    this.#synthEngine = { osc, osc2, gain };
  }

  #synthBoom() {
    const ctx = this.#ctx;
    if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * 1.2), buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.5;
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    filter.type = 'lowpass'; filter.frequency.value = 2600;
    gain.gain.value = 0.55;
    src.buffer = buf;
    src.connect(filter).connect(gain).connect(this.#bus.sfx);
    src.start();
    this.#tone(110, 0.5, 'sawtooth', 0.09);
    this.#tone(330, 0.35, 'square', 0.05);
    this.#tone(70, 0.7, 'sawtooth', 0.08, 0.05);
  }

  #tone(freq, dur, type, vol, when = 0) {
    const ctx = this.#ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain(), t0 = ctx.currentTime + when;
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(this.#bus.sfx);
    osc.start(t0); osc.stop(t0 + dur);
  }
}

// ───────────── tratamento dos buffers decodificados ─────────────

/** Tira o silêncio digital das bordas (atraso/preenchimento do codificador MP3, que varia por navegador). */
function trimEdges(ctx, buf, threshold = 1e-4) {
  let start = buf.length, end = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    let s = 0; while (s < d.length && Math.abs(d[s]) < threshold) s++;
    let e = d.length; while (e > s && Math.abs(d[e - 1]) < threshold) e--;
    start = Math.min(start, s); end = Math.max(end, e);
  }
  if (end - start < 2 || (start === 0 && end === buf.length)) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, end - start, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(start, end), c);
  return out;
}

/**
 * Loop sem emenda: depois de tirar as bordas, mistura o fim no começo (cross-fade de potência
 * constante). A última amostra passa a emendar exatamente na primeira, em qualquer navegador.
 */
function seamlessLoop(ctx, buf, fadeSeconds) {
  const b = trimEdges(ctx, buf);
  const k = Math.min(Math.floor(fadeSeconds * b.sampleRate), Math.floor(b.length / 4));
  if (k < 2) return b;
  const n = b.length - k;
  const out = ctx.createBuffer(b.numberOfChannels, n, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const src = b.getChannelData(c), dst = out.getChannelData(c);
    dst.set(src.subarray(0, n));
    for (let i = 0; i < k; i++) {
      const t = i / k;
      dst[i] = src[i] * Math.sin(t * Math.PI / 2) + src[n + i] * Math.cos(t * Math.PI / 2);
    }
  }
  return out;
}

/** WAV de 0,1 s de silêncio (8 bits, 8 kHz), gerado na hora: usado no truque da chave de silêncio do iOS. */
function silentWavUrl() {
  const rate = 8000, n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);   // 128 = zero em PCM de 8 bits
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
