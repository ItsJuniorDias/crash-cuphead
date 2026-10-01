import { CONFIG } from './config.js';

// IMPORTANTE (dinheiro real): esta lógica roda no navegador apenas no protótipo.
// Num produto de apostas, crash point, saldo e saques são decididos no servidor,
// com seeds pré-comprometidas (provably fair); o cliente só exibe o resultado.

export function secureRandom() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

export function crashPointFrom(r) {
  const x = Math.floor(((1 - CONFIG.houseEdge) / (1 - r)) * 100) / 100;
  return Math.min(CONFIG.maxCrash, Math.max(1, x));
}

export const multiplierAt = (seconds) => Math.exp(CONFIG.growth * seconds);

const BOT_NAMES = ['Biscuit Joe', 'Miss Teacup', 'Uncle Nickel', 'Lollipop', 'Mr. Tophat', 'Harmonica Hal',
  'Lady Luck', 'Cookie', 'Captain Whiskers', 'Granny Trombone', 'Cigar Charlie', 'Lulu Sequins'];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage indisponível */ }
  },
};

/**
 * Máquina de estados da rodada: waiting → flying → crashed → waiting…
 * Eventos: 'phase', 'change', 'countdown', 'cashout'.
 */
export class Game extends EventTarget {
  phase = 'waiting';
  timer = 0;
  elapsed = 0;
  multiplier = 1;
  crashPoint = 1;
  bet = null;      // { amount, autoCashout, status: 'active'|'cashed'|'lost', cashedAt, win }
  queued = null;   // aposta agendada para a próxima rodada
  bots = [];
  balance = store.get('bb_balance', CONFIG.startBalance);
  history = store.get('bb_history', []);

  start() { this.#enterWaiting(); }

  /** O que o botão principal faz agora. */
  get primaryAction() {
    if (this.phase === 'flying' && this.bet?.status === 'active') return 'cashout';
    if (this.phase === 'waiting') return this.bet ? 'cancel' : 'bet';
    return this.queued ? 'cancelQueued' : 'queue';
  }

  /** Retorna uma mensagem de erro, ou null em caso de sucesso. */
  placeBet(amount, autoCashout = null) {
    amount = Math.floor(amount);
    if (!(amount >= 1)) return 'Minimum bet: 1';
    if (amount > this.balance) return 'Not enough balance!';
    const action = this.primaryAction;
    if (action === 'bet') {
      this.balance -= amount;
      this.bet = { amount, autoCashout, status: 'active' };
    } else if (action === 'queue') {
      this.queued = { amount, autoCashout };
    }
    this.#changed();
    return null;
  }

  cancelBet() {
    if (this.phase === 'waiting' && this.bet) { this.balance += this.bet.amount; this.bet = null; }
    else this.queued = null;
    this.#changed();
  }

  cashOut() {
    const b = this.bet;
    if (this.phase !== 'flying' || b?.status !== 'active') return;
    b.status = 'cashed';
    b.cashedAt = this.multiplier;
    b.win = Math.floor(b.amount * this.multiplier * 100) / 100;
    this.balance += b.win;
    this.#changed();
    this.#emit('cashout', { win: b.win, multiplier: this.multiplier });
  }

  resetBalance() {
    this.balance = CONFIG.startBalance;
    this.#changed();
  }

  update(dt) {
    if (this.phase === 'waiting') {
      const before = Math.ceil(this.timer);
      this.timer -= dt;
      if (this.timer <= 0) return this.#enterFlying();
      if (Math.ceil(this.timer) !== before && this.timer < 3.5) this.#emit('countdown', { seconds: Math.ceil(this.timer) });
    } else if (this.phase === 'flying') {
      this.elapsed += dt;
      const m = multiplierAt(this.elapsed);
      // Saques que o frame "pulou" ainda contam se o alvo for <= crash point.
      const reached = Math.min(m, this.crashPoint);
      const b = this.bet;
      if (b?.status === 'active' && b.autoCashout && reached >= b.autoCashout) {
        this.multiplier = b.autoCashout;
        this.cashOut();
      }
      let botsChanged = false;
      for (const bot of this.bots) {
        if (bot.status === 'active' && reached >= bot.target) { bot.status = 'cashed'; bot.cashedAt = bot.target; botsChanged = true; }
      }
      if (botsChanged) this.#emit('change');
      if (m >= this.crashPoint) return this.#enterCrashed();
      this.multiplier = m;
    } else {
      this.timer -= dt;
      if (this.timer <= 0) this.#enterWaiting();
    }
  }

  #enterWaiting() {
    this.phase = 'waiting';
    this.timer = CONFIG.waitTime;
    this.elapsed = 0;
    this.multiplier = 1;
    this.bet = null;
    if (this.queued) {
      const q = this.queued;
      this.queued = null;
      if (q.amount <= this.balance) { this.balance -= q.amount; this.bet = { ...q, status: 'active' }; }
    }
    this.bots = [...BOT_NAMES].sort(() => secureRandom() - 0.5).slice(0, 5 + Math.floor(secureRandom() * 5)).map(name => ({
      name,
      amount: Math.round(5 + secureRandom() ** 2 * 500),
      target: +(1.05 - Math.log(1 - secureRandom()) * 1.8).toFixed(2),
      status: 'active',
    }));
    this.#emit('phase', { phase: 'waiting' });
    this.#changed();
  }

  #enterFlying() {
    this.phase = 'flying';
    this.elapsed = 0;
    this.multiplier = 1;
    this.crashPoint = crashPointFrom(secureRandom());
    this.#emit('phase', { phase: 'flying' });
  }

  #enterCrashed() {
    this.phase = 'crashed';
    this.timer = CONFIG.crashPause;
    this.multiplier = this.crashPoint;
    if (this.bet?.status === 'active') this.bet.status = 'lost';
    for (const bot of this.bots) if (bot.status === 'active') bot.status = 'lost';
    this.history.unshift(this.crashPoint);
    this.history.length = Math.min(this.history.length, 50);
    this.#emit('phase', { phase: 'crashed', crashPoint: this.crashPoint });
    this.#changed();
  }

  #changed() {
    store.set('bb_balance', this.balance);
    store.set('bb_history', this.history);
    this.#emit('change');
  }

  #emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}
