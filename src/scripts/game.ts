/* ═══════════════════════════════════════════════════════════════════
    RIFA · CONTROLADOR DE PANTALLA
    Solo DOM. Toda la lógica vive en src/lib/rifa.ts.
    ═══════════════════════════════════════════════════════════════════ */

import {
  RifaGame,
  formatAmount,
  getTierColor,
  getTierEmoji,
  getTierLabel,
  isValidInvestment,
  parseInvestment,
  type Prize,
  type PrizeTier,
  type RifaView,
} from '../lib/rifa';

const SPIN_DURATION = 2100;
const REEL_LOCK_GAP = 320;
const MILK_COOLDOWN = 420;
const HOLD_RESET_MS = 1400;
const REEL_SYMBOLS = ['📌', '📄', '🎖️', '🔑', '🪙', '✨'];

/** Debe coincidir con los botones data-preset de InvestmentInput.astro. */
const PRESETS = [500, 1000, 5000, 10000, 15000, 25000, 50000, 100000];

function qa<T extends Element = HTMLElement>(sel: string): T[] {
  return Array.from(document.querySelectorAll<T>(sel));
}

interface El {
  stage: HTMLElement | null;
  investInput: HTMLInputElement | null;
  investPreview: HTMLElement | null;
  investPanel: HTMLElement | null;
  investCount: HTMLElement | null;
  stepper: HTMLElement | null;
  statusText: HTMLElement | null;
  toast: HTMLElement | null;
  historyList: HTMLElement | null;
  historyCount: HTMLElement | null;
  historyStock: HTMLElement | null;
  reveal: HTMLElement | null;
  cow: HTMLElement | null;
  peekText: HTMLElement | null;
  prizeView: HTMLElement | null;
  prizeViewCard: HTMLElement | null;
  prizeViewImage: HTMLImageElement | null;
  prizeViewName: HTMLElement | null;
  prizeViewTier: HTMLElement | null;
  prizeViewMeta: HTMLElement | null;
  prizeViewFallback: HTMLElement | null;
  prizeViewFigure: HTMLElement | null;
  revealCard: HTMLElement | null;
  revealImage: HTMLImageElement | null;
  revealTier: HTMLElement | null;
  revealEmoji: HTMLElement | null;
  revealName: HTMLElement | null;
  revealMeta: HTMLElement | null;
  revealMessage: HTMLElement | null;
  revealStock: HTMLElement | null;
  confetti: HTMLElement | null;
  slotIcon: HTMLElement | null;
  slotText: HTMLElement | null;
  oddsList: HTMLElement | null;
  statTotal: HTMLElement | null;
  statCount: HTMLElement | null;
  statBest: HTMLElement | null;
  statStock: HTMLElement | null;
  ordenBtn: HTMLButtonElement | null;
  resetHold: HTMLElement | null;
  resetRing: HTMLElement | null;
}

class RifaController {
  private game = new RifaGame();
  private view: RifaView | null = null;
  private el: El;
  private lockTimers: number[] = [];
  private reelTimer: number | null = null;
  /** Timeout del settle, registrado para poder cancelarlo en un reinicio. */
  private settleTimer: number | null = null;
  private reelIndex = 0;
  private holdStart = 0;
  private holdRaf: number | null = null;
  private displayedTotal = 0;
  private displayedCount = 0;
  private lastSpinAt = 0;
  /** Último premio revelado: lo que muestra Brissa al tocarla. */
  private lastPrize: Prize | null = null;
  private counters = new Map<HTMLElement, number>();
  private wasSpinning = false;

  constructor(root: ParentNode = document) {
    const find = <T extends Element = HTMLElement>(sel: string): T | null =>
      root.querySelector<T>(sel);
    const findAll = <T extends Element = HTMLElement>(sel: string): T[] =>
      Array.from(root.querySelectorAll<T>(sel));

    this.el = {
      stage: find('[data-stage]'),
      investInput: find('#invest-amount'),
      investPreview: find('[data-invest-preview]'),
      investPanel: find('[data-invest-panel]'),
      investCount: find('[data-investment-count]'),
      stepper: find('[data-stepper]'),
      statusText: find('[data-status-text]'),
      toast: find('[data-toast]'),
      historyList: find('[data-history-list]'),
      historyCount: find('[data-history-count]'),
      historyStock: find('[data-stock-left]'),
      reveal: find('[data-prize-reveal]'),
      revealCard: find('[data-prize-card]'),
      revealImage: find('[data-prize-image]'),
      revealTier: find('[data-prize-tier]'),
      revealEmoji: find('[data-prize-emoji]'),
      revealName: find('[data-prize-name]'),
      revealMeta: find('[data-prize-meta]'),
      revealMessage: find('[data-prize-message]'),
      revealStock: find('[data-prize-stock]'),
      confetti: find('[data-confetti]'),
      slotIcon: find('[data-slot-icon]'),
      slotText: find('[data-slot-text]'),
      oddsList: find('[data-odds-list]'),
      statTotal: find('[data-stat-total-value]'),
      statCount: find('[data-stat-count-value]'),
      statBest: find('[data-stat-best-value]'),
      statStock: find('[data-stat-stock-value]'),
      ordenBtn: find('[data-action="ordenar"]'),
      resetHold: find('[data-reset-hold]'),
      resetRing: find('[data-hold-ring]'),
      cow: find('[data-action="brissa"]'),
      peekText: find('[data-peek-text]'),
      prizeView: find('[data-prize-view]'),
      prizeViewCard: find('[data-prize-view-card]'),
      prizeViewImage: find('[data-prize-view-image]'),
      prizeViewName: find('[data-prize-view-name]'),
      prizeViewTier: find('[data-prize-view-tier]'),
      prizeViewMeta: find('[data-prize-view-meta]'),
      prizeViewFallback: find('[data-prize-view-fallback]'),
      prizeViewFigure: find('.prize-view__figure'),
    };

    this.reels = findAll('[data-reel]');
    this.presetButtons = findAll('[data-preset]');

    this.bindEvents();
    this.game.subscribe((view) => this.render(view));
    this.seedReels();
    this.renderOdds(0);
  }

  private reels: HTMLElement[] = [];
  private presetButtons: HTMLButtonElement[] = [];

  /* ══ Eventos ══════════════════════════════════════════════════════ */

  private bindEvents(): void {
    const input = this.el.investInput;
    input?.addEventListener('input', () => this.onInput());
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.onOrdenar();
      }
    });

    this.el.ordenBtn?.addEventListener('click', () => this.onOrdenar());

    for (const btn of this.presetButtons) {
      btn.addEventListener('click', () => {
        const value = Number(btn.dataset.preset ?? '0');
        if (!isValidInvestment(value)) return;
        this.setAmount(value);
        if (this.el.investInput) this.el.investInput.value = String(value);
        this.onOrdenar();
      });
    }

    this.bindHoldReset();
    this.bindCow();
    this.bindImageFallback();

    document.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  private bindHoldReset(): void {
    const hold = this.el.resetHold;
    if (!hold) return;

    const start = (e: PointerEvent) => {
      e.preventDefault();
      if (this.view?.isSpinning) return;
      this.holdStart = performance.now();
      hold.dataset.active = 'true';
      const tick = () => {
        const t = Math.min((performance.now() - this.holdStart) / HOLD_RESET_MS, 1);
        hold.style.setProperty('--hold', t.toFixed(3));
        if (t < 1) {
          this.holdRaf = requestAnimationFrame(tick);
        } else {
          this.finishReset();
        }
      };
      this.holdRaf = requestAnimationFrame(tick);
    };

    const cancel = () => {
      if (this.holdRaf !== null) cancelAnimationFrame(this.holdRaf);
      this.holdRaf = null;
      hold.dataset.active = 'false';
      hold.style.setProperty('--hold', '0');
    };

    hold.addEventListener('pointerdown', start);
    hold.addEventListener('pointerup', cancel);
    hold.addEventListener('pointerleave', cancel);
    hold.addEventListener('pointercancel', cancel);
  }

  /* ══ Brissa como visor de premios ═══════════════════════════════ */

  private prizeViewOpen = false;

  private bindCow(): void {
    this.el.cow?.addEventListener('click', () => this.togglePrizeView());
    for (const btn of qa('[data-action="prize-view-close"]')) {
      btn.addEventListener('click', () => this.closePrizeView());
    }
  }

  private togglePrizeView(): void {
    if (this.prizeViewOpen) {
      this.closePrizeView();
      return;
    }
    if (this.view?.isSpinning) return;

    const prize = this.lastPrize;
    if (!prize) {
      // Todavía no hay premio: Brissa reacciona en vez de abrir un visor vacío.
      this.bounceCow();
      this.toast('Ordeña a Brissa primero y verás tu premio aquí');
      return;
    }
    this.openPrizeView(prize);
  }

  /**
   * Si una imagen de premio no carga, se muestra el emoji del nivel.
   * Nunca debe quedar una carta en verde vacío: es lo que más confunde.
   */
  private bindImageFallback(): void {
    const mark = (view: boolean) => {
      const tier = this.lastPrize?.tier;
      if (view) {
        if (this.el.prizeViewFigure) this.el.prizeViewFigure.dataset.image = 'error';
        if (this.el.prizeViewFallback && tier) {
          this.el.prizeViewFallback.textContent = getTierEmoji(tier);
        }
      } else {
        if (this.el.revealImage) this.el.revealImage.style.visibility = 'hidden';
        if (this.el.revealEmoji && tier) {
          this.el.revealEmoji.textContent = getTierEmoji(tier);
          this.el.revealEmoji.style.display = 'grid';
        }
      }
    };

    this.el.prizeViewImage?.addEventListener('error', () => mark(true));
    this.el.revealImage?.addEventListener('error', () => mark(false));
  }

  private openPrizeView(prize: Prize): void {
    const view = this.el.prizeView;
    if (!view) return;

    if (this.el.prizeViewImage) {
      // Se limpia el estado de error de la apertura anterior.
      if (this.el.prizeViewFigure) this.el.prizeViewFigure.dataset.image = 'ok';
      this.el.prizeViewImage.style.visibility = '';
      this.el.prizeViewImage.src = prize.image;
      this.el.prizeViewImage.alt = prize.name;
    }
    if (this.el.prizeViewName) this.el.prizeViewName.textContent = prize.name;
    if (this.el.prizeViewTier) this.el.prizeViewTier.textContent = getTierLabel(prize.tier);
    if (this.el.prizeViewMeta) {
      this.el.prizeViewMeta.textContent = `Inversión ${formatAmount(this.game.getCurrentInvestment())} HM · Quedan ${prize.remaining} de ${prize.stock}`;
    }
    this.el.prizeViewCard?.style.setProperty('--prize-color', getTierColor(prize.tier));

    view.removeAttribute('hidden');
    this.prizeViewOpen = true;
    // Sin scroll de fondo: en móvil el gesto sobre el visor seiste a la página.
    document.body.style.overflow = 'hidden';
    this.el.prizeViewCard?.focus?.();
  }

  private closePrizeView(): void {
    if (!this.prizeViewOpen) {
      this.el.prizeView?.setAttribute('hidden', '');
      return;
    }
    this.el.prizeView?.setAttribute('hidden', '');
    this.prizeViewOpen = false;
    document.body.style.overflow = '';
    this.el.cow?.focus();
  }

  private bounceCow(): void {
    const cow = this.el.cow;
    if (!cow) return;
    cow.classList.remove('is-bouncing');
    // Forzar reflow para poder repetir la animación en clics seguidos.
    void cow.offsetWidth;
    cow.classList.add('is-bouncing');
    window.setTimeout(() => cow.classList.remove('is-bouncing'), 640);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const target = e.target as HTMLElement | null;
    const typing =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

    if (e.key === 'Escape') {
      if (this.prizeViewOpen) {
        this.closePrizeView();
        return;
      }
      this.setAmount(0);
      if (this.el.investInput) this.el.investInput.value = '';
      return;
    }

    if (typing) return;

    // Si el foco está en un control (la vaca, un preset, el botón ordeñar,
    // "cerrar"...), Enter y Espacio son suyos: hacen `click` por teclado.
    // Robárselos con preventDefault los deja sin poder activarse.
    // `e.target` no siempre es un Element: si no hay nada enfocado puede ser
    // el propio `document`, que no tiene getAttribute.
    const onControl =
      target instanceof HTMLElement &&
      (target.tagName === 'BUTTON' || target.getAttribute('role') === 'button');

    if (!onControl && e.key >= '1' && e.key <= '8') {
      const value = PRESETS[Number(e.key) - 1];
      if (value === undefined) return;
      this.setAmount(value);
      if (this.el.investInput) this.el.investInput.value = String(value);
      return;
    }

    if (!onControl && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.onOrdenar();
      return;
    }

    if (e.key.toLowerCase() === 'r') this.finishReset();
  }

  /* ══ Acciones ═════════════════════════════════════════════════════ */

  private setAmount(amount: number): void {
    this.game.setInvestmentAmount(amount);
  }

  private onInput(): void {
    const input = this.el.investInput;
    if (!input) return;
    const raw = input.value.trim();
    const parsed = parseInvestment(input.value);
    const invalid = raw !== '' && parsed === null;
    input.classList.toggle('is-invalid', invalid);
    this.setAmount(parsed ?? 0);
    // El botón está deshabilitado sin monto, así que un click no llegaría
    // nunca al mensaje: se avisa mientras se escribe.
    if (invalid) this.toast('Monto no válido · usa sólo números enteros');
  }

  private onOrdenar(): void {
    if (this.view?.isSpinning) return;
    if (Date.now() - this.lastSpinAt < MILK_COOLDOWN) return;

    const amount = this.game.getCurrentInvestment();
    if (!isValidInvestment(amount)) {
      this.toast('Ingresa un monto de inversión para ordeñar');
      this.el.investInput?.focus();
      this.pulse(this.el.investPanel);
      return;
    }

    const prize = this.game.resolveSpin();
    if (!prize) {
      this.toast('Ya no quedan premios en este nivel. Reinicia la rifa.');
      return;
    }

    this.game.commitSpin();
    this.startReelSpin();
    this.lastSpinAt = Date.now();

    // El settle va registrado: si el usuario reinicia a mitad de giro hay que
    // poder cancelar este timeout. Sin registro, `resetAll()` repone el stock y
    // un segundo después este callback vuelve a asentar el premio sobre la
    // rifa reiniciada (contador en 1 con total 0 HM).
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.game.settle(prize);
    }, SPIN_DURATION);
  }

  private finishReset(): void {
    if (this.holdRaf !== null) cancelAnimationFrame(this.holdRaf);
    this.holdRaf = null;
    this.clearTimers();
    if (this.el.resetHold) {
      this.el.resetHold.dataset.active = 'false';
      this.el.resetHold.style.setProperty('--hold', '0');
    }
    for (const id of this.counters.values()) cancelAnimationFrame(id);
    this.counters.clear();
    // Los contadores se ponen a cero ANTES del emit: si no, el render
    // dispara una animación que desciende desde el valor viejo y el
    // reinicio tarda 620 ms en verse.
    this.displayedTotal = 0;
    this.displayedCount = 0;
    this.lastPrize = null;
    this.closePrizeView();
    this.el.cow?.removeAttribute('data-has-prize');
    if (this.el.peekText) this.el.peekText.textContent = 'Toca a Brissa';
    this.game.resetAll();
    if (this.el.investInput) this.el.investInput.value = '';
    this.wasSpinning = false;
    this.seedReels();
    this.el.stage?.classList.remove('is-won');
    this.el.reveal?.setAttribute('hidden', '');
    this.el.reveal?.removeAttribute('data-visible');
    this.toast('Rifa reiniciada · stock completo', 'win');
  }

  private clearTimers(): void {
    for (const t of this.lockTimers) window.clearTimeout(t);
    this.lockTimers = [];
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.reelTimer !== null) {
      window.clearInterval(this.reelTimer);
      this.reelTimer = null;
    }
  }

  /* ══ Reels ═════════════════════════════════════════════════════════ */

  private seedReels(): void {
    this.reelIndex = 0;
    for (const reel of this.reels) {
      reel.classList.remove('is-spinning', 'has-winner', 'is-locked');
      reel.textContent = REEL_SYMBOLS[this.reelIndex++ % REEL_SYMBOLS.length] ?? '·';
    }
  }

  private startReelSpin(): void {
    this.el.stage?.classList.remove('is-won');
    for (const reel of this.reels) {
      reel.classList.remove('has-winner', 'is-locked');
      reel.classList.add('is-spinning');
    }
    if (this.el.slotIcon) this.el.slotIcon.textContent = '🍼';
    if (this.el.slotText) this.el.slotText.textContent = 'Ordeñando…';
    this.el.ordenBtn?.classList.add('is-spinning');

    this.reelTimer = window.setInterval(() => {
      for (const reel of this.reels) {
        reel.textContent = REEL_SYMBOLS[Math.floor(Math.random() * REEL_SYMBOLS.length)] ?? '·';
      }
    }, 70);
  }

  /** Bloquea los reels uno a uno y luego enciende la revelación. */
  private lockReels(prize: Prize): void {
    if (this.reelTimer !== null) {
      window.clearInterval(this.reelTimer);
      this.reelTimer = null;
    }
    if (this.el.slotIcon) this.el.slotIcon.textContent = getTierEmoji(prize.tier);
    if (this.el.slotText) this.el.slotText.textContent = getTierLabel(prize.tier).toUpperCase();

    this.reels.forEach((reel, i) => {
      const delay = 160 + i * REEL_LOCK_GAP;
      const id = window.setTimeout(() => {
        reel.classList.add('is-locked');
        reel.textContent = i === this.reels.length - 1 ? getTierEmoji(prize.tier) : '·';
      }, delay);
      this.lockTimers.push(id);
    });

    const last = 160 + (this.reels.length - 1) * REEL_LOCK_GAP + 240;
    this.lockTimers.push(window.setTimeout(() => this.revealPrize(prize), last));
  }

  /* ══ Revelación ═══════════════════════════════════════════════════ */

  private revealPrize(prize: Prize): void {
    const color = getTierColor(prize.tier);

    for (const reel of this.reels) {
      reel.classList.remove('is-spinning');
      reel.classList.add('has-winner');
      reel.style.setProperty('--prize-color', color);
    }
    this.lastPrize = prize;
    this.el.cow?.setAttribute('data-has-prize', 'true');
    if (this.el.peekText) this.el.peekText.textContent = 'Ver mi premio';
    this.el.ordenBtn?.classList.remove('is-spinning');
    this.el.stage?.classList.add('is-won');
    this.el.revealCard?.style.setProperty('--prize-color', color);

    if (this.el.revealImage) {
      this.el.revealImage.style.visibility = '';
      this.el.revealImage.src = prize.image;
      this.el.revealImage.alt = prize.name;
    }
    if (this.el.revealEmoji) this.el.revealEmoji.textContent = getTierEmoji(prize.tier);
    if (this.el.revealName) this.el.revealName.textContent = prize.name;
    if (this.el.revealTier) this.el.revealTier.textContent = getTierLabel(prize.tier);
    if (this.el.revealMeta) {
      this.el.revealMeta.textContent = `Inversión ${formatAmount(this.game.getCurrentInvestment())} HM`;
    }
    if (this.el.revealStock) {
      this.el.revealStock.textContent = `Quedan ${prize.remaining} de ${prize.stock}`;
    }
    if (this.el.revealMessage) {
      this.el.revealMessage.textContent = `¡Ganaste un ${getTierLabel(prize.tier)}!`;
    }
    if (this.el.reveal) {
      this.el.reveal.removeAttribute('hidden');
      this.el.reveal.dataset.visible = 'true';
    }

    this.burstConfetti(color);
    this.toast(`¡${getTierLabel(prize.tier)} ganado!`, 'win');
  }

  private burstConfetti(color: string): void {
    const host = this.el.confetti;
    if (!host) return;
    const colors = [color, '#fdf5da', '#7fca8d', '#eabf4e', '#c9b2f0'];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < 28; i++) {
      const bit = document.createElement('i');
      bit.className = 'confetti__bit';
      const c = colors[i % colors.length] ?? '#eabf4e';
      bit.style.setProperty('--x', `${(Math.random() - 0.5) * 260}px`);
      bit.style.setProperty('--drift', `${(Math.random() - 0.5) * 140}px`);
      bit.style.setProperty('--delay', `${Math.random() * 180}ms`);
      bit.style.setProperty('--dur', `${900 + Math.random() * 700}ms`);
      bit.style.background = c;
      frag.appendChild(bit);
    }
    host.appendChild(frag);
    window.setTimeout(() => {
      host.replaceChildren();
    }, 1800);
  }

  /* ══ Render ═══════════════════════════════════════════════════════ */

  private render(view: RifaView): void {
    const prev = this.view;
    this.view = view;

    for (const brissa of qa('[data-brissa]')) {
      brissa.dataset.state = view.brissaState;
    }
    this.el.stage?.setAttribute('data-phase', view.phase);

    this.paintStatus(view);
    this.paintTiers(view);
    this.paintStats(view);
    this.paintHistory();
    this.paintStock(view);
    this.renderOdds(view.investmentAmount);
    this.paintStepper(view);

    if (this.el.investPreview) {
      this.el.investPreview.textContent =
        view.investmentAmount > 0 ? `${formatAmount(view.investmentAmount)} HM` : '0 HM';
    }

    const btn = this.el.ordenBtn;
    if (btn) {
      const blocked = view.isSpinning || !isValidInvestment(view.investmentAmount);
      btn.disabled = blocked;
      btn.dataset.locked = String(blocked);
    }

    // Al pasar de "girando" a "revelado" arrancamos el bloqueo de reels.
    if (view.showPrize && view.prize && this.wasSpinning) {
      this.lockReels(view.prize);
    }
    this.wasSpinning = view.isSpinning;
    void prev;
  }

  private paintStatus(view: RifaView): void {
    const el = this.el.statusText;
    if (!el) return;
    if (view.isSpinning) el.textContent = 'ORDEÑANDO…';
    else if (view.showPrize) el.textContent = '¡PREMIO ENTREGADO!';
    else if (view.investmentAmount > 0) el.textContent = `LISTO · ${formatAmount(view.investmentAmount)} HM`;
    else el.textContent = 'EN VIVO · ESPERANDO INVERSIÓN';
  }

  private paintTiers(view: RifaView): void {
    for (const badge of qa<HTMLElement>('.tier-badge')) {
      const tier = badge.dataset.tier as PrizeTier | undefined;
      if (!tier) continue;
      const on = view.tierUnlocks[tier] ?? false;
      badge.classList.toggle('unlocked', on);
      badge.setAttribute('aria-disabled', String(!on));
    }
  }

  private paintStepper(view: RifaView): void {
    const stepper = this.el.stepper;
    if (!stepper) return;
    const active =
      view.investmentAmount > 25000 ? 3 : view.investmentAmount > 10000 ? 2 : view.investmentAmount > 0 ? 1 : 0;
    const dots = Array.from(stepper.children) as HTMLElement[];
    dots.forEach((dot, i) => dot.classList.toggle('is-active', i === active));
  }

  private paintStats(view: RifaView): void {
    this.animateNumber(this.el.statTotal, this.displayedTotal, view.totalInvested, (v) =>
      `${formatAmount(v)} HM`,
    );
    this.displayedTotal = view.totalInvested;

    this.animateNumber(this.el.statCount, this.displayedCount, view.investmentCount, (v) =>
      formatAmount(v),
    );
    this.displayedCount = view.investmentCount;

    if (this.el.statBest) {
      this.el.statBest.textContent = view.bestPrize
        ? `${getTierEmoji(view.bestPrize.tier)} ${getTierLabel(view.bestPrize.tier)}`
        : '—';
    }
  }

  private paintStock(view: RifaView): void {
    if (this.el.statStock) this.el.statStock.textContent = `${view.stockLeft}`;
    if (this.el.historyStock) this.el.historyStock.textContent = `${view.stockLeft}`;
  }

  private animateNumber(
    node: HTMLElement | null,
    from: number,
    to: number,
    fmt: (v: number) => string,
  ): void {
    if (!node) return;
    // Cancela cualquier animación previa: si no, un rAF suelto puede
    // escribir el valor viejo encima de un reinicio.
    if (this.counters.has(node)) {
      cancelAnimationFrame(this.counters.get(node) as number);
      this.counters.delete(node);
    }
    if (from === to) {
      node.textContent = fmt(to);
      return;
    }
    const start = performance.now();
    const dur = 620;
    const step = (now: number) => {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = fmt(from + (to - from) * eased);
      if (t < 1) {
        this.counters.set(node, requestAnimationFrame(step));
      } else {
        this.counters.delete(node);
        node.textContent = fmt(to);
      }
    };
    this.counters.set(node, requestAnimationFrame(step));
  }

  private paintHistory(): void {
    const list = this.el.historyList;
    const history = this.game.getHistory();
    if (this.el.historyCount) this.el.historyCount.textContent = `${history.length}`;
    if (!list) return;

    if (history.length === 0) {
      list.innerHTML = `
        <li class="feed__row is-empty">
          <span class="feed__emoji" aria-hidden="true">🍼</span>
          <span class="feed__text">Todavía no hay premios</span>
          <span class="feed__time">--:--</span>
        </li>`;
      return;
    }

    list.innerHTML = history
      .slice(0, 12)
      .map(
        (entry) => `
        <li class="feed__row" style="--prize-color:${getTierColor(entry.prize.tier)}">
          <span class="feed__emoji" aria-hidden="true">${getTierEmoji(entry.prize.tier)}</span>
          <span class="feed__text">
            <b>${getTierLabel(entry.prize.tier)}</b>
            <i>${formatAmount(entry.amount)} HM</i>
          </span>
          <span class="feed__time">${new Date(entry.timestamp).toLocaleTimeString('es-MX', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })}</span>
        </li>`,
      )
      .join('');
  }

  /** Barra de probabilidades en vivo: hace visible "más monto, mejor premio". */
  private renderOdds(investment: number): void {
    const host = this.el.oddsList;
    if (!host) return;

    if (!isValidInvestment(investment)) {
      host.innerHTML = '<p class="odds__hint">Ingresa un monto para ver tus probabilidades</p>';
      return;
    }

    const rows = this.game.getOdds();
    if (rows.length === 0) {
      host.innerHTML = '<p class="odds__hint">Sin premios disponibles</p>';
      return;
    }

    const byTier = new Map<PrizeTier, number>();
    for (const row of rows) byTier.set(row.prize.tier, (byTier.get(row.prize.tier) ?? 0) + row.chance);

    host.innerHTML = Array.from(byTier.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([tier, chance]) => {
        const pct = Math.round(chance * 1000) / 10;
        return `
        <div class="odds__row" style="--prize-color:${getTierColor(tier)}">
          <span class="odds__name">${getTierEmoji(tier)} ${getTierLabel(tier)}</span>
          <span class="odds__bar"><i style="width:${pct.toFixed(1)}%"></i></span>
          <span class="odds__pct">${pct}%</span>
        </div>`;
      })
      .join('');
  }

  /* ══ Utilidades de UI ═════════════════════════════════════════════ */

  private toast(message: string, kind: 'error' | 'win' = 'error'): void {
    const node = this.el.toast;
    if (!node) return;
    node.textContent = message;
    node.dataset.kind = kind;
    node.dataset.visible = 'true';
    window.clearTimeout(Number(node.dataset.timer ?? 0));
    node.dataset.timer = String(
      window.setTimeout(() => {
        node.dataset.visible = 'false';
      }, kind === 'win' ? 2600 : 3200),
    );
  }

  private pulse(node: HTMLElement | null): void {
    if (!node) return;
    node.classList.remove('is-shaking');
    void node.offsetWidth;
    node.classList.add('is-shaking');
    window.setTimeout(() => node.classList.remove('is-shaking'), 600);
  }
}

/* ══ Arranque ═══════════════════════════════════════════════════════ */

export function bootRifa(): void {
  const stage = document.querySelector('[data-stage]');
  if (!stage) return;
  new RifaController();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootRifa, { once: true });
  } else {
    bootRifa();
  }
}
