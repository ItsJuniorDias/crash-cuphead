// Efeitos sonoros sintetizados (WebAudio). Troque por samples de ragtime/big band depois.
export class Sfx {
  muted = false;
  #ctx = null;
  #engine = null;
  #engineGain = null;

  /** Navegadores só liberam áudio após um gesto do usuário. */
  unlock() {
    if (this.#ctx) { this.#ctx.resume?.(); return; }
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      osc.type = 'sawtooth';
      filter.type = 'lowpass'; filter.frequency.value = 500;
      gain.gain.value = 0;
      osc.connect(filter).connect(gain).connect(ctx.destination);
      osc.start();
      this.#ctx = ctx; this.#engine = osc; this.#engineGain = gain;
    } catch { /* sem áudio */ }
  }

  /** Ronco do motor acompanha o multiplicador. */
  update(game) {
    const ctx = this.#ctx;
    if (!ctx) return;
    const on = game.phase === 'flying' && !this.muted;
    this.#engineGain.gain.setTargetAtTime(on ? 0.035 : 0, ctx.currentTime, 0.08);
    this.#engine.frequency.setTargetAtTime(55 + 40 * Math.log(game.multiplier + 1) + Math.sin(performance.now() / 40) * 3, ctx.currentTime, 0.05);
  }

  tick() { this.#tone(880, 0.08, 'square', 0.04); }
  takeoff() { [392, 523, 659, 784].forEach((f, i) => this.#tone(f, 0.18, 'square', 0.05, i * 0.08)); }
  cash() { [1047, 1319, 1568, 2093].forEach((f, i) => this.#tone(f, 0.25, 'triangle', 0.08, i * 0.06)); }

  boom() {
    const ctx = this.#ctx;
    if (!ctx || this.muted) return;
    const len = ctx.sampleRate * 1.2, buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.5;
    const src = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    filter.type = 'lowpass'; filter.frequency.value = 900; gain.gain.value = 0.5;
    src.buffer = buf;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    this.#tone(110, 0.5, 'sawtooth', 0.08);
    this.#tone(70, 0.7, 'sawtooth', 0.08, 0.05);
  }

  #tone(freq, dur, type, vol, when = 0) {
    const ctx = this.#ctx;
    if (!ctx || this.muted) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain(), t0 = ctx.currentTime + when;
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur);
  }
}
