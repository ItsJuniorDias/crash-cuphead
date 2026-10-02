// Efeitos sonoros sintetizados (WebAudio). Troque por samples de ragtime/big band depois.
//
// Celular:
// - iOS/Android só liberam áudio dentro de um gesto (toque/clique/tecla). Destravamos no primeiro
//   gesto em QUALQUER lugar da página e retomamos sempre que o sistema suspender o áudio.
// - No iPhone, a chave de silêncio corta o Web Audio. Pedimos a sessão de "reprodução"
//   (navigator.audioSession, iOS 17+) e, nos mais antigos, tocamos um <audio> mudo em loop,
//   o que faz o som do jogo sair mesmo no modo silencioso.
// - Alto-falante de celular quase não reproduz grave: motor e explosão têm harmônicos agudos.

const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'];

export class Sfx {
  #muted = false;
  #ctx = null;
  #master = null;
  #engine = null;
  #engine2 = null;
  #engineGain = null;
  #primed = false;
  #media = null;

  constructor() {
    const onGesture = () => this.unlock();
    for (const type of GESTURES) window.addEventListener(type, onGesture, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => this.#onVisibility());
  }

  get muted() { return this.#muted; }
  set muted(value) {
    this.#muted = value;
    if (this.#master) this.#master.gain.setTargetAtTime(value ? 0 : 1, this.#ctx.currentTime, 0.02);
  }

  /** Estado do áudio, para depuração (`?audiodebug` na URL mostra na tela). */
  get state() { return this.#ctx ? this.#ctx.state : 'sem contexto'; }

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
    } catch { /* sem áudio */ }
  }

  #create() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = this.#muted ? 0 : 1;
    master.connect(ctx.destination);

    // motor: fundamental grave + um harmônico quadrado (é o que se ouve no alto-falante do celular)
    const engine = ctx.createOscillator(), engine2 = ctx.createOscillator();
    const filter = ctx.createBiquadFilter(), gain = ctx.createGain(), gain2 = ctx.createGain();
    engine.type = 'sawtooth';
    engine2.type = 'square';
    filter.type = 'lowpass'; filter.frequency.value = 1400;
    gain2.gain.value = 0.35;
    gain.gain.value = 0;
    engine.connect(filter);
    engine2.connect(gain2).connect(filter);
    filter.connect(gain).connect(master);
    engine.start();
    engine2.start();

    this.#ctx = ctx; this.#master = master;
    this.#engine = engine; this.#engine2 = engine2; this.#engineGain = gain;
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

  /** Ronco do motor acompanha o multiplicador. */
  update(game) {
    const ctx = this.#ctx;
    if (!ctx) return;
    const on = game.phase === 'flying';
    const f = 55 + 40 * Math.log(game.multiplier + 1) + Math.sin(performance.now() / 40) * 3;
    this.#engineGain.gain.setTargetAtTime(on ? 0.06 : 0, ctx.currentTime, 0.08);
    this.#engine.frequency.setTargetAtTime(f, ctx.currentTime, 0.05);
    this.#engine2.frequency.setTargetAtTime(f * 3, ctx.currentTime, 0.05);
  }

  tick() { this.#tone(880, 0.08, 'square', 0.05); }
  takeoff() { [392, 523, 659, 784].forEach((f, i) => this.#tone(f, 0.18, 'square', 0.06, i * 0.08)); }
  cash() { [1047, 1319, 1568, 2093].forEach((f, i) => this.#tone(f, 0.25, 'triangle', 0.1, i * 0.06)); }

  boom() {
    const ctx = this.#ctx;
    if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * 1.2), buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.5;
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    filter.type = 'lowpass'; filter.frequency.value = 2600;   // deixa passar o "estalo" (audível no celular)
    gain.gain.value = 0.55;
    src.buffer = buf;
    src.connect(filter).connect(gain).connect(this.#master);
    src.start();
    this.#tone(110, 0.5, 'sawtooth', 0.09);
    this.#tone(330, 0.35, 'square', 0.05);   // harmônico do estrondo para alto-falante pequeno
    this.#tone(70, 0.7, 'sawtooth', 0.08, 0.05);
  }

  #tone(freq, dur, type, vol, when = 0) {
    const ctx = this.#ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain(), t0 = ctx.currentTime + when;
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(this.#master);
    osc.start(t0); osc.stop(t0 + dur);
  }
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
