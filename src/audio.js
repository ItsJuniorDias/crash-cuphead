// Som do jogo: samples do Pixabay (public/audio, gerados por scripts/process-audio.mjs) com
// versões sintetizadas de reserva para qualquer som que ainda não exista.
//
// Celular:
// - iOS/Android só liberam áudio dentro de um gesto (soltar o toque/clique/tecla). Destravamos no
//   primeiro gesto em QUALQUER lugar da página e retomamos sempre que o sistema suspender o áudio.
// - No iPhone, a chave de silêncio corta o Web Audio. Pedimos a sessão de "reprodução"
//   (navigator.audioSession, iOS 17+) ou, nos mais antigos, tocamos um <audio> mudo em loop.
//   No mudo do jogo a sessão é devolvida, para não interromper a música de outros apps.
// - Efeitos e loops são decodificados (curtos); as músicas tocam em streaming (<audio> ligado ao
//   Web Audio), que gasta poucos MB em vez de ~100 MB de áudio decodificado.
// - Com o áudio parado (suspenso/interrompido), sons de jogo são descartados, não acumulados:
//   senão tudo tocaria de uma vez quando ele voltasse.

const AUDIO_DIR = `${import.meta.env.BASE_URL}audio/`;
// pointerdown não conta como gesto para o Chrome do Android: só eventos de "soltar"
const GESTURES = ['pointerup', 'touchend', 'click', 'keydown'];

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
const MAX_BOOST = 1.4;      // compensação máxima quando o limitador deixou um som abaixo do alvo

const smoothstep = (x, a, b) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class Sfx {
  #muted = false;
  #ctx = null;
  #master = null;
  #bus = {};                 // sfx / ambience / music
  #manifest = {};
  #raw = new Map();          // nome → { bytes, kind, gain } até ser decodificado (depois os bytes são liberados)
  #buffers = new Map();      // nome → AudioBuffer pronto
  #gains = new Map();        // nome → compensação de volume vinda do manifest
  #loops = {};               // nome → { src, gain } tocando
  #lanes = {};               // playlist → { gain, players: [{ el, fade }], tracks, slot, i, token }
  #synthEngine = null;
  #primed = false;
  #resuming = false;
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
    if (value) {
      // devolve o áudio do aparelho: a música de outros apps volta a tocar
      this.#media?.pause();
      try { if (navigator.audioSession) navigator.audioSession.type = 'ambient'; } catch { /* iOS < 17 */ }
    } else if (this.#ctx) {
      this.#playThroughSilentSwitch();   // o des-mudo vem de um clique, então estamos num gesto
      this.#resume();
    }
  }

  /** Estado do áudio, para depuração (`?audiodebug` na URL mostra na tela). */
  get state() {
    if (!this.#ctx) return 'sem contexto';
    const total = Object.values(this.#manifest).filter((e) => e.kind !== 'music').length;
    const lanes = Object.keys(this.#lanes).length;
    return `${this.#ctx.state} · ${this.#buffers.size}/${total} sons · música ${lanes ? 'tocando' : '—'}`;
  }

  /** Precisa rodar dentro de um gesto do usuário; pode ser chamado quantas vezes for. */
  unlock() {
    try {
      if (!this.#ctx) this.#create();
      const ctx = this.#ctx;
      if (!ctx) return;
      this.#resume();
      if (!this.#primed) {
        // iOS: tocar um buffer vazio dentro do gesto destrava a saída de som
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination);
        src.start(0);
        this.#primed = true;
      }
      if (!this.#muted) this.#playThroughSilentSwitch();
      this.#startMusic();   // <audio> só pode começar dentro de um gesto
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
    // limitador de segurança no fim da cadeia: vários sons fortes juntos não estouram
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20;
    limiter.attack.value = 0.003; limiter.release.value = 0.25;
    const master = ctx.createGain();
    master.gain.value = this.#muted ? 0 : 1;
    master.connect(limiter).connect(ctx.destination);
    for (const name of ['sfx', 'ambience', 'music']) {
      const g = ctx.createGain();
      g.connect(master);
      this.#bus[name] = g;
    }
    this.#ctx = ctx;
    this.#master = master;
  }

  #resume() {
    const ctx = this.#ctx;
    if (!ctx || ctx.state === 'running') return;
    this.#resuming = true;
    ctx.resume().catch(() => {}).finally(() => { this.#resuming = false; });
  }

  /** Áudio tocando (ou destravando neste gesto). Fora disso, sons de jogo são descartados. */
  #live() {
    const ctx = this.#ctx;
    return !!ctx && (ctx.state === 'running' || this.#resuming);
  }

  async #prefetch() {
    this.#manifest = await fetch(`${AUDIO_DIR}manifest.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    for (const [name, e] of Object.entries(this.#manifest)) {
      // o limitador pode ter deixado o arquivo abaixo do alvo: compensa no volume (com teto)
      if (e.lufs > -60 && Number.isFinite(e.target)) this.#gains.set(name, Math.min(MAX_BOOST, 10 ** ((e.target - e.lufs) / 20)));
    }
    // efeitos e loops são baixados e decodificados; músicas vão em streaming (só a URL)
    await Promise.all(Object.entries(this.#manifest).filter(([, e]) => e.kind !== 'music').map(async ([name, entry]) => {
      try {
        const res = await fetch(`${AUDIO_DIR}${entry.file}`);
        if (res.ok) { this.#raw.set(name, { bytes: await res.arrayBuffer(), kind: entry.kind }); this.#decodeAll(); }
      } catch { /* esse som fica com a versão sintetizada */ }
    }));
    this.#decodeAll();
  }

  #decodeAll() {
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const [name, item] of this.#raw) {
      if (item.decoding) continue;
      item.decoding = true;
      // a cópia (slice) é porque decodeAudioData consome o ArrayBuffer e queremos poder tentar de novo
      new Promise((resolve, reject) => ctx.decodeAudioData(item.bytes.slice(0), resolve, reject))
        .then((buf) => {
          this.#buffers.set(name, item.kind === 'loop' ? seamlessLoop(ctx, buf, LOOP_FADE) : trimEdges(ctx, buf));
          this.#raw.delete(name);   // libera os bytes comprimidos
          if (item.kind === 'loop') this.#startLoop(name);
        })
        .catch(() => { item.decoding = false; });
    }
    // motor sintetizado só se não existir motor gravado (nem baixado, nem decodificado)
    const hasEngine = this.#raw.has('engine') || this.#buffers.has('engine') || this.#manifest.engine;
    if (!hasEngine && !this.#synthEngine) this.#startSynthEngine();
  }

  #startLoop(name) {
    const ctx = this.#ctx, buffer = this.#buffers.get(name);
    if (!buffer || this.#loops[name]) return;
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    src.loop = true;
    // projetor sempre ligado (bem baixo); motor e grilos começam mudos e o update() abre
    gain.gain.value = name === 'projector' ? MIX.projector * (this.#gains.get(name) ?? 1) : 0;
    src.connect(gain).connect(this.#bus[name === 'engine' ? 'sfx' : 'ambience']);
    // começa num ponto aleatório para os loops não soarem sempre iguais
    src.start(0, Math.random() * buffer.duration);
    this.#loops[name] = { src, gain };
    if (name === 'engine' && this.#synthEngine) this.#stopSynthEngine();
  }

  // ───────────── música em streaming ─────────────

  /**
   * Cada playlist tem dois <audio> que se revezam (um sai enquanto o outro entra, com cross-fade).
   * Os dois são "abençoados" com play() dentro do gesto: depois disso o iOS deixa trocar de faixa sozinho.
   */
  #startMusic() {
    const ctx = this.#ctx;
    for (const [lane, names] of Object.entries(PLAYLISTS)) {
      const tracks = names.filter((n) => this.#manifest[n]);
      if (this.#lanes[lane] || !tracks.length) continue;
      const gain = ctx.createGain();
      gain.gain.value = lane === 'day' ? MIX.music : 0;   // o update() faz a passagem dia → noite
      gain.connect(this.#bus.music);
      const players = [0, 1].map(() => {
        const el = new Audio();
        el.preload = 'auto';
        el.setAttribute('playsinline', '');
        const fade = ctx.createGain();
        fade.gain.value = 0;
        ctx.createMediaElementSource(el).connect(fade).connect(gain);
        return { el, fade };
      });
      const L = { gain, players, tracks, slot: 0, i: 0, token: null };
      this.#lanes[lane] = L;
      // abençoa o segundo player agora (gesto) e começa a primeira faixa no primeiro
      const spare = players[1].el;
      spare.src = `${AUDIO_DIR}${this.#manifest[tracks[tracks.length > 1 ? 1 : 0]].file}`;
      spare.play().then(() => spare.pause()).catch(() => {});
      this.#nextTrack(lane);
    }
  }

  #nextTrack(lane) {
    const ctx = this.#ctx, L = this.#lanes[lane];
    const incoming = L.players[L.slot], outgoing = L.players[1 - L.slot];
    L.slot = 1 - L.slot;
    const name = L.tracks[L.i++ % L.tracks.length];
    const { el, fade } = incoming;
    el.src = `${AUDIO_DIR}${this.#manifest[name].file}`;   // trocar o src já recomeça do início
    el.play().catch(() => {});   // se o sistema recusar, o próximo gesto/visibilidade tenta de novo
    const t = ctx.currentTime, level = this.#gains.get(name) ?? 1;
    fade.gain.cancelScheduledValues(t);
    fade.gain.setValueAtTime(0, t);
    fade.gain.linearRampToValueAtTime(level, t + MUSIC_FADE);
    // a faixa que sai desce no mesmo tempo e pausa
    outgoing.fade.gain.cancelScheduledValues(t);
    outgoing.fade.gain.setValueAtTime(outgoing.fade.gain.value, t);
    outgoing.fade.gain.linearRampToValueAtTime(0, t + MUSIC_FADE);
    const old = outgoing.el;
    // (depois da troca, o que toca é players[1 - slot]; só pausa se `old` não voltou a ser o atual)
    setTimeout(() => { if (L.players[1 - L.slot].el !== old) old.pause(); }, (MUSIC_FADE + 0.2) * 1000);
    // perto do fim, chama a próxima. Cada faixa tem a sua ficha: o player que está saindo para de
    // vigiar o próprio fim (senão dispararia uma segunda troca e cortaria a faixa nova).
    old.ontimeupdate = old.onended = null;
    const token = {};
    L.token = token;
    const next = () => { if (L.token === token) { L.token = null; this.#nextTrack(lane); } };
    el.ontimeupdate = () => { if (el.duration && el.duration - el.currentTime <= MUSIC_FADE) next(); };
    el.onended = next;
  }

  #pauseMusic(paused) {
    for (const L of Object.values(this.#lanes)) {
      const current = L.players[1 - L.slot].el;   // slot já aponta para o próximo
      if (paused) current.pause(); else current.play().catch(() => {});
    }
  }

  // ───────────── sons ─────────────

  /** Toca um sample; devolve false se ele não existir (quem chamou usa a versão sintetizada). */
  #play(name, { delay = 0, rate = 1 } = {}) {
    const ctx = this.#ctx, buffer = this.#buffers.get(name);
    if (!ctx || !buffer) return false;
    if (!this.#live()) return true;   // áudio parado: descarta (e não cai na versão sintetizada)
    const src = ctx.createBufferSource(), gain = ctx.createGain();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    gain.gain.value = (MIX[name] ?? 0.6) * (this.#gains.get(name) ?? 1);
    src.connect(gain).connect(this.#bus.sfx);
    src.start(ctx.currentTime + delay);
    return true;
  }

  #playThroughSilentSwitch() {
    try {
      if (navigator.audioSession) { navigator.audioSession.type = 'playback'; return; }   // iOS 17+: basta isso
    } catch { /* segue para o truque antigo */ }
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
      this.#pauseMusic(true);
    } else if (this.#ctx && !this.#muted) {
      this.#resume();   // se o iOS recusar sem gesto, o próximo toque resolve
      if (this.#media) this.#media.play().catch(() => {});
      this.#pauseMusic(false);
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

  /** O motor gravado chegou: o sintetizado sai em fade (sem estalo) e é desligado de vez. */
  #stopSynthEngine() {
    const { osc, osc2, gain } = this.#synthEngine, t = this.#ctx.currentTime;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(gain.gain.value, t);
    gain.gain.setTargetAtTime(0, t, 0.05);
    osc.stop(t + 0.3);
    osc2.stop(t + 0.3);
    osc.onended = () => gain.disconnect();
    this.#synthEngine = null;
  }

  #synthBoom() {
    const ctx = this.#ctx;
    if (!this.#live()) return;
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
    if (!this.#live()) return;
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

/** WAV de 0,1 s de silêncio (8 bits, 8 kHz), gerado na hora: usado no truque da chave de silêncio do iOS < 17. */
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
