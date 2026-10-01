export const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Painel de apostas, histórico e lista de jogadores (DOM). */
export class Hud {
  #lastButton = '';
  #lastBalance = null;
  #toastTimer = 0;

  constructor(game, sfx) {
    this.game = game;
    this.sfx = sfx;
    const $ = (id) => document.getElementById(id);
    this.el = {
      balance: $('balance'), bet: $('bet'), auto: $('auto'), autoOn: $('autoOn'), main: $('main'),
      history: $('history'), players: $('players'), toast: $('toast'), mute: $('mute'), reset: $('reset'),
    };

    document.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => this.#quick(b.dataset.q)));
    this.el.main.addEventListener('click', () => this.primary());
    this.el.reset.addEventListener('click', () => game.resetBalance());
    this.el.mute.addEventListener('click', () => {
      sfx.unlock();
      sfx.muted = !sfx.muted;
      this.el.mute.textContent = sfx.muted ? '🔇 Muted' : '🔊 Sound';
    });
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' || ['INPUT', 'BUTTON'].includes(e.target.tagName)) return;
      e.preventDefault();
      this.primary();
    });
    game.addEventListener('change', () => this.renderLists());
    this.renderLists();
  }

  primary() {
    this.sfx.unlock();
    const g = this.game;
    switch (g.primaryAction) {
      case 'cashout': g.cashOut(); break;
      case 'cancel':
      case 'cancelQueued': g.cancelBet(); break;
      default: {
        const auto = this.el.autoOn.checked ? Math.max(1.01, +this.el.auto.value || 2) : null;
        const err = g.placeBet(+this.el.bet.value, auto);
        if (err) this.toast(err); else this.sfx.tick();
      }
    }
  }

  #quick(q) {
    let v = +this.el.bet.value || 0;
    v = q === 'half' ? v / 2 : q === 'double' ? v * 2 : v + +q;
    this.el.bet.value = Math.max(1, Math.min(Math.floor(v), Math.floor(this.game.balance) || 1));
  }

  toast(msg) {
    const t = this.el.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  /** Chamado a cada frame: botão principal e saldo. */
  update() {
    const g = this.game, action = g.primaryAction;
    let label, sub = '', cls = '';
    switch (action) {
      case 'bet': label = 'PLACE BET'; sub = `takeoff in ${Math.max(0, g.timer).toFixed(1)}s`; break;
      case 'cancel': label = 'CANCEL'; sub = `bet of ${fmt(g.bet.amount)}`; cls = 'cancel'; break;
      case 'cashout':
        label = `CASH OUT ${fmt(g.bet.amount * g.multiplier)}`;
        sub = g.bet.autoCashout ? `auto at ${g.bet.autoCashout.toFixed(2)}×` : 'or press space';
        cls = 'cash';
        break;
      case 'cancelQueued': label = 'CANCEL'; sub = 'bet for next round'; cls = 'cancel'; break;
      default: label = 'PLACE BET'; sub = 'for next round';
    }
    const key = label + sub + cls;
    if (key !== this.#lastButton) {
      this.#lastButton = key;
      this.el.main.className = cls;
      this.el.main.innerHTML = `${label}${sub ? `<small>${sub}</small>` : ''}`;
    }
    const locked = action === 'cancel' || action === 'cashout' || action === 'cancelQueued';
    this.el.bet.disabled = this.el.auto.disabled = this.el.autoOn.disabled = locked;
    if (g.balance !== this.#lastBalance) {
      this.#lastBalance = g.balance;
      this.el.balance.textContent = fmt(g.balance);
    }
  }

  renderLists() {
    const g = this.game;
    this.el.history.innerHTML = g.history.slice(0, 24)
      .map((v) => `<span class="chip ${v < 2 ? 'lo' : v < 10 ? 'mid' : 'hi'}">${v.toFixed(2)}×</span>`)
      .join('') || '<span class="chip">No rounds yet</span>';

    const rows = [];
    if (g.bet) rows.push(row('You', g.bet, true));
    for (const b of g.bots) rows.push(row(b.name, b, false));
    this.el.players.innerHTML = rows.join('');
  }
}

function row(name, b, me) {
  const cls = b.status === 'cashed' ? 'won' : b.status === 'lost' ? 'lost' : '';
  const right = b.cashedAt ? `${b.cashedAt.toFixed(2)}× → ${fmt(b.amount * b.cashedAt)}` : fmt(b.amount);
  return `<div class="pl ${cls} ${me ? 'me' : ''}"><span>${name}</span><span>${right}</span></div>`;
}
