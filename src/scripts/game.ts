import {
  Fx,
  centerOf,
  playInvestmentSequence,
  type FxLayers,
  type Point,
  type SequencePhase,
} from '../lib/animations';
import { isSoundEnabled, playSound, toggleSound } from '../lib/audio';
import {
  CATEGORIES,
  COPY,
  GOAL,
  IDLE_AFTER_MS,
  PRESET_AMOUNTS,
  TIER_UP_MESSAGE,
  getCategory,
} from '../lib/config';
import { isDemoForced, getOrgPassword, isDev } from '../lib/brissa';
import {
  formatAmount,
  formatCompact,
  formatPercent,
  isValidAmount,
  parseAmount,
  recentHistory,
} from '../lib/investments';
import {
  connectRealtime,
  getState,
  hydrate,
  invest,
  isReady,
  retryHydrate,
  setAnimating,
  setIdle,
  subscribe,
  undoLastInvestment,
} from '../lib/gameState';
import type { WriteResult } from '../lib/repository';
import {
  INVESTMENT_CATEGORIES,
  type BrissaState,
  type GameView,
  type InvestmentCategory,
} from '../lib/types';

const STAGE_W = 1920;
const DEMO_SESSION_KEY = 'hatomaster_brissa_demo';

function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function qa<T extends Element = HTMLElement>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Mensaje de error específico según lo que el usuario escribió. */
function errorMessageFor(raw: string): string {
  if (/[-−–—]/.test(raw)) return 'No se permiten cantidades negativas.';
  if (/[eE]/.test(raw)) return 'Escribe el número completo, sin notación científica.';
  if (/[^\d.,\s'’$€£¥₡]/.test(raw)) return 'Escribe sólo números, sin letras ni símbolos.';
  if (/[.,]/.test(raw)) return 'Usa comas o puntos sólo para separar miles (1,000).';
  if (!/\d/.test(raw)) return 'Escribe un número mayor que cero.';
  if (Number(raw.replace(/[^\d]/g, '')) > Number.MAX_SAFE_INTEGER) return 'Ese monto es demasiado grande.';
  return 'El monto debe ser mayor que cero.';
}

/* ═══════════════════════════════════════════════════════════════════════
   CONTROLADOR DEL JUEGO
   ═══════════════════════════════════════════════════════════════════════ */
class HatoGame {
  private readonly stage: HTMLElement;
  private readonly fx = new Fx();
  private layers!: FxLayers;

  /* Referencias del DOM (se resuelven una vez) */
  private el = {
    goal: null as HTMLElement | null,
    goalMessage: null as HTMLElement | null,
    goalTotal: null as HTMLElement | null,
    goalTarget: null as HTMLElement | null,
    goalBar: null as HTMLElement | null,
    goalFill: null as HTMLElement | null,
    goalPercent: null as HTMLElement | null,
    goalRemaining: null as HTMLElement | null,
    goalOverflow: null as HTMLElement | null,
    feeder: null as HTMLElement | null,
    brissa: null as HTMLElement | null,
    investPanel: null as HTMLElement | null,
    stepAmount: null as HTMLElement | null,
    stepCategory: null as HTMLElement | null,
    selectedAmount: null as HTMLElement | null,
    continueBtn: null as HTMLButtonElement | null,
    customInput: null as HTMLInputElement | null,
    customField: null as HTMLElement | null,
    customHint: null as HTMLElement | null,
    confirmModal: null as HTMLElement | null,
    confirmAmount: null as HTMLElement | null,
    confirmCategory: null as HTMLElement | null,
    notification: null as HTMLElement | null,
    notifyTitle: null as HTMLElement | null,
    notifyEmoji: null as HTMLElement | null,
    notifySub: null as HTMLElement | null,
    celebration: null as HTMLElement | null,
    celebrateKicker: null as HTMLElement | null,
    celebrateTotal: null as HTMLElement | null,
    celebrateGoal: null as HTMLElement | null,
    celebrateSub: null as HTMLElement | null,
    confetti: null as HTMLCanvasElement | null,
    soundToggle: null as HTMLButtonElement | null,
    statusText: null as HTMLElement | null,
    investCount: null as HTMLElement | null,
    historyList: null as HTMLElement | null,
    breakdownTotal: null as HTMLElement | null,
    breakdownCount: null as HTMLElement | null,
    demoBar: null as HTMLElement | null,
    orgModal: null as HTMLElement | null,
    orgPanel: null as HTMLElement | null,
    orgPassword: null as HTMLInputElement | null,
    dbNotice: null as HTMLElement | null,
    dbNoticeText: null as HTMLElement | null,
  };

  /* Estado de la interfaz */
  private amount: number | null = null;
  private category: InvestmentCategory | null = null;
  private step: 'amount' | 'category' = 'amount';
  private busy = false;
  private brissaOverride: BrissaState | null = null;
  private view!: GameView;
  // Se incrementa en cada inversión: los tweens en vuelo comparan contra él
  // para no pisar el estado de la siguiente inversión.
  private runId = 0;
  private displayedTotal = 0;
  private displayedLevel = 0;
  private lastInteraction = 0;
  private idleOn = false;

  /* Demo */
  private demoOn = false;

  /* Limpieza */
  private disposers: Array<() => void> = [];
  private idleTimer: number | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(stage: HTMLElement) {
    this.stage = stage;
    this.cacheDom();
    this.layers = this.fx.mount(stage);
    this.bindEvents();
    this.setupSoundButton();
    this.setupDemo();
    this.unsubscribe = subscribe((view) => this.render(view));
    void this.boot();
    this.startIdleWatch();
  }

  /**
   * Carga inicial. La primera consulta decide si el stand puede invertir: hasta
   * que Supabase responde, el panel queda bloqueado (ver `paintDbStatus`).
   * Sólo se abre el canal de Realtime cuando la carga fue bien, para no dejar
   * una suscripción reintentando en segundo plano.
   */
  private async boot(): Promise<void> {
    await hydrate();
    if (!isReady()) return;
    const disconnect = connectRealtime();
    if (disconnect) this.disposers.push(disconnect);
  }

  /** Botón "Reintentar" del aviso de base de datos. */
  private async retryDb(): Promise<void> {
    await retryHydrate();
    if (!isReady()) return;
    const disconnect = connectRealtime();
    if (disconnect) this.disposers.push(disconnect);
  }

  /* ── Resolución de referencias ─────────────────────────────────────── */
  private cacheDom(): void {
    const s = this.stage;
    this.el = {
      goal: q(s, '[data-goal]'),
      goalMessage: q(s, '[data-goal-message]'),
      goalTotal: q(s, '[data-goal-total]'),
      goalTarget: q(s, '[data-goal-target]'),
      goalBar: q(s, '[data-goal-bar]'),
      goalFill: q(s, '[data-goal-fill]'),
      goalPercent: q(s, '[data-goal-percent]'),
      goalRemaining: q(s, '[data-goal-remaining]'),
      goalOverflow: q(s, '[data-goal-overflow]'),
      feeder: q(s, '[data-feeder]'),
      brissa: q(s, '[data-brissa]'),
      investPanel: q(s, '[data-invest-panel]'),
      stepAmount: q(s, '[data-step="amount"]'),
      stepCategory: q(s, '[data-step="category"]'),
      selectedAmount: q(s, '[data-selected-amount]'),
      continueBtn: q(s, '[data-action="to-category"]'),
      customInput: q(s, '[data-action="custom-amount"]'),
      customField: q(s, '[data-custom-field]'),
      customHint: q(s, '[data-custom-hint]'),
      confirmModal: q(s, '[data-modal="confirm"]'),
      confirmAmount: q(s, '[data-confirm-amount]'),
      confirmCategory: q(s, '[data-confirm-category]'),
      notification: q(s, '[data-notification]'),
      notifyTitle: q(s, '[data-notification-title]'),
      notifyEmoji: q(s, '[data-notification-emoji]'),
      notifySub: q(s, '[data-notification-sub]'),
      celebration: q(s, '[data-celebration]'),
      celebrateKicker: q(s, '[data-celebration-kicker]'),
      celebrateTotal: q(s, '[data-celebration-total]'),
      celebrateGoal: q(s, '[data-celebration-goal]'),
      celebrateSub: q(s, '[data-celebration-sub]'),
      confetti: q(s, '[data-confetti]'),
      soundToggle: q(s, '[data-sound-toggle]'),
      statusText: q(s, '[data-status-text]'),
      investCount: q(s, '[data-investment-count]'),
      historyList: q(s, '[data-history-list]'),
      breakdownTotal: q(s, '[data-breakdown-total]'),
      breakdownCount: q(s, '[data-breakdown-count]'),
      demoBar: q(s, '[data-demo-bar]'),
      dbNotice: q(s, '[data-db-notice]'),
      dbNoticeText: q(s, '[data-db-notice-text]'),
      orgModal: q(s, '[data-modal="org"]'),
      orgPanel: q(s, '[data-org-panel]'),
      orgPassword: q(s, '[data-org-password]'),
    };
  }

  /* ═════════════════════════════════════════════════════════════════════
     PRESENTACIÓN
     ═════════════════════════════════════════════════════════════════════ */
  private render(view: GameView): void {
    this.view = view;
    // Durante la animación manda el valor interpolado, no el del store.
    if (!this.busy) {
      this.displayedTotal = view.total;
      this.displayedLevel = view.level;
    }
    // Se pinta SIEMPRE el valor mostrado: si se pintara `view.total`, cualquier
    // render a mitad de secuencia adelantaría el contador y luego el tweener lo
    // devolvería a cero (parpadeo 500 → 0 → 500).
    this.paintProgress(this.displayedTotal, view.goal, view.milestone.tone, view.message);
    this.paintBrissa(this.brissaOverride ?? view.brissa);
    this.paintStats();
    this.paintStatus(view);
    this.paintDbStatus(view);
  }

  /**
   * Estado de la conexión. Mientras no haya base de datos el panel de inversión
   * queda inutilizable a propósito: si la escritura fallara, la inversión del
   * visitante se perdería sin dejar rastro, que es peor que pedir que espere.
   */
  private paintDbStatus(view: GameView): void {
    this.stage.dataset.db = view.db;

    const notice = this.el.dbNotice;
    if (notice) {
      const failed = view.db === 'error';
      notice.hidden = !failed;
      if (failed && this.el.dbNoticeText) {
        this.el.dbNoticeText.textContent =
          view.dbError ?? 'No se pudo conectar con la base de datos.';
      }
    }

    this.applyLock();
  }

  /**
   * Parte "barata" del render: también se ejecuta a 60 fps durante el conteo
   * del contador, así que sólo toca lo justo (textContent + estilos).
   */
  private paintProgress(total: number, goal: number, tone: string, message: string): void {
    const safeGoal = goal > 0 ? goal : GOAL;
    const realPercent = (total / safeGoal) * 100;
    const shownPercent = Math.min(100, Math.max(0, realPercent));
    const overflow = Math.max(0, total - safeGoal);

    if (this.el.goalTotal) this.el.goalTotal.textContent = formatAmount(total);
    if (this.el.goalTarget) this.el.goalTarget.textContent = formatAmount(safeGoal);
    if (this.el.goalFill) this.el.goalFill.style.width = `${shownPercent.toFixed(2)}%`;
    if (this.el.goalPercent) this.el.goalPercent.textContent = formatPercent(shownPercent);
    if (this.el.goalBar) this.el.goalBar.setAttribute('aria-valuenow', String(Math.round(shownPercent)));
    if (this.el.goal) this.el.goal.dataset.tone = tone;
    if (this.el.goalMessage) this.el.goalMessage.textContent = message;

    if (this.el.goalRemaining) {
      this.el.goalRemaining.textContent =
        overflow > 0
          ? `+${formatAmount(overflow)} HM sobre la meta`
          : `Faltan ${formatAmount(Math.max(0, safeGoal - total))}`;
    }
    if (this.el.goalOverflow) this.el.goalOverflow.hidden = overflow <= 0;

    if (this.el.feeder) {
      this.el.feeder.style.setProperty('--feeder-level', this.displayedLevel.toFixed(4));
    }
    if (this.el.celebrateTotal) this.el.celebrateTotal.textContent = formatAmount(total);
  }

  private paintBrissa(state: BrissaState): void {
    if (!this.el.brissa) return;
    if (this.el.brissa.dataset.state !== state) this.el.brissa.dataset.state = state;
  }

  private paintStats(): void {
    const state = getState();

    // ── Historial (feed compacto) ─────────────────────────────────────
    if (this.el.historyList) {
      const list = this.el.historyList;
      const rows = recentHistory(state.investmentHistory);
      const signature = `${state.investmentHistory.length}`;

      if (rows.length === 0) {
        if (list.dataset.sig !== 'empty') {
          list.dataset.sig = 'empty';
          list.innerHTML = emptyHistoryMarkup();
        }
      } else if (list.dataset.sig !== signature) {
        list.dataset.sig = signature;
        list.innerHTML = rows
          .map(
            (row, i) =>
              `<li class="feed__row${i === 0 ? ' is-latest' : ''}" data-history-key="${row.key}" style="animation-delay:${i * 40}ms"><span class="feed__emoji">${getCategory(row.category)?.emoji ?? '🪙'}</span><span class="feed__amount">${row.amountLabel}</span><span class="feed__time">${row.timeLabel}</span></li>`,
          )
          .join('');
      }
    }

    // ── Desglose por categoría (HUD) ──────────────────────────────────
    const total = state.totalRaised;
    const max = Math.max(1, ...INVESTMENT_CATEGORIES.map((id) => state.categoryTotals[id] ?? 0));
    for (const meta of CATEGORIES) {
      const row = q(this.stage, `[data-breakdown-row="${meta.id}"]`);
      if (!row) continue;
      const value = state.categoryTotals[meta.id] ?? 0;
      const bar = q(row, '[data-breakdown-bar]');
      const label = q(row, '[data-breakdown-value]');
      if (bar) bar.style.width = `${((value / max) * 100).toFixed(2)}%`;
      if (label) label.textContent = value > 0 ? `${formatCompact(value)} HM` : '—';
    }
    if (this.el.breakdownTotal) this.el.breakdownTotal.textContent = `${formatAmount(total)} HM`;
    if (this.el.breakdownCount) {
      const n = state.investmentHistory.length;
      this.el.breakdownCount.textContent = `${n} ${n === 1 ? 'inversión' : 'inversiones'}`;
    }
  }

  private paintStatus(view: GameView): void {
    const state = getState();
    if (this.el.statusText) {
      // El estado de la base de datos va primero: si no hay BD, decir "EN VIVO"
      // en el HUD sería mentira (lo que se ve no viene de ningún servidor).
      this.el.statusText.textContent = this.busy
        ? 'ALIMENTANDO A BRISSA…'
        : view.db === 'loading'
          ? 'CONECTANDO CON LA BASE DE DATOS…'
          : view.db === 'error'
            ? 'SIN CONEXIÓN CON LA BASE DE DATOS'
            : view.goalReached
              ? 'META ALCANZADA · SIGUE INVIRTIENDO'
              : 'EN VIVO · ESPERANDO INVERSIONES';
    }
    if (this.el.investCount) {
      const n = state.investmentHistory.length;
      this.el.investCount.textContent = `${n} ${n === 1 ? 'inversión' : 'inversiones'}`;
    }
  }

/* ═════════════════════════════════════════════════════════════════════
      FLUJO DE INVERSIÓN
      ════════════════════════════════════════════════════════════════════ */
  private bindEvents(): void {
    const on = <T extends Event>(
      target: EventTarget | null,
      type: string,
      handler: (event: T) => void,
      options?: AddEventListenerOptions,
    ): void => {
      if (!target) return;
      const fn = handler as EventListener;
      target.addEventListener(type, fn, options);
      this.disposers.push(() => target.removeEventListener(type, fn, options));
    };

    // Presets
    for (const btn of qa<HTMLButtonElement>(this.stage, '[data-action="preset"]')) {
      on(btn, 'click', () => {
        if (this.busy) return;
        const value = Number(btn.dataset.amount ?? '0');
        if (!isValidAmount(value)) return;
        this.setAmount(value, true);
        playSound('select');
      });
    }

    // Cantidad manual
    on<InputEvent>(this.el.customInput, 'input', () => {
      if (this.busy) return;
      const raw = this.el.customInput?.value ?? '';
      const parsed = parseAmount(raw);
      this.setAmount(parsed, false);
      this.validateField(raw, parsed);
    });

    on(this.el.customInput, 'keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      this.goToCategory();
    });

    // Continuar
    on(this.el.continueBtn, 'click', () => this.goToCategory());

    // Categorías
    for (const btn of qa<HTMLButtonElement>(this.stage, '[data-action="category"]')) {
      on(btn, 'click', () => {
        if (this.busy) return;
        const id = btn.dataset.category ?? null;
        this.setCategory(isCategoryId(id) ? id : null);
        playSound('select');
        this.goToReview();
      });
    }
    for (const btn of qa<HTMLButtonElement>(this.stage, '[data-action="category-none"]')) {
      on(btn, 'click', () => {
        if (this.busy) return;
        this.setCategory(null);
        playSound('select');
        this.goToReview();
      });
    }

    // Volver / Revisar
    on(q(this.stage, '[data-action="back-amount"]'), 'click', () => this.setStep('amount'));
    on(q(this.stage, '[data-action="review"]'), 'click', () => this.goToReview());

    // Confirmación
    on(q(this.stage, '[data-action="cancel"]'), 'click', () => this.closeConfirm());
    on(q(this.stage, '[data-action="invest"]'), 'click', () => void this.commit());

    // Sonido
    on(this.el.soundToggle, 'click', () => this.toggleSoundUi());

    // Demo
    for (const btn of qa<HTMLButtonElement>(this.stage, '[data-action="demo-invest"]')) {
      on(btn, 'click', () => {
        const value = Number(btn.dataset.amount ?? '0');
        if (isValidAmount(value)) void this.runInvestment(value, this.category, btn);
      });
    }

    // Aviso de base de datos
    on(q(this.stage, '[data-action="db-retry"]'), 'click', () => void this.retryDb());

    // Modo organización (sólo por teclado: Ctrl+Shift+O o manteniendo Ctrl+Shift+R)
    on(q(this.stage, '[data-action="org-close"]'), 'click', () => this.closeOrg());
    on(q(this.stage, '[data-action="org-undo"]'), 'click', () => void this.undoLast());
    on<KeyboardEvent>(this.el.orgPassword, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.checkOrgPassword();
      }
    });
    on(q(this.stage, '[data-action="org-confirm"]'), 'click', () => this.checkOrgPassword());

    // Teclado global
    on<KeyboardEvent>(document, 'keydown', (event) => this.onKeyDown(event));
    on(this.stage, 'pointerdown', () => this.markInteraction(), { passive: true });
    on(this.stage, 'pointermove', () => this.markInteraction(), { passive: true });
    on(this.stage, 'wheel', () => this.markInteraction(), { passive: true });
  }

  private setAmount(value: number | null, fromPreset: boolean): void {
    this.amount = isValidAmount(value) ? value : null;
    for (const btn of qa<HTMLButtonElement>(this.stage, '[data-action="preset"]')) {
      const match = fromPreset && Number(btn.dataset.amount) === this.amount;
      btn.classList.toggle('is-selected', match);
    }
    if (this.el.continueBtn) this.el.continueBtn.disabled = this.amount === null;
    if (this.el.selectedAmount) {
      this.el.selectedAmount.textContent = this.amount ? `${formatAmount(this.amount)} HM` : '—';
    }
  }

  private validateField(raw: string, parsed: number | null): void {
    const field = this.el.customField;
    const hint = this.el.customHint;
    if (!field || !hint) return;
    const dirty = raw.trim().length > 0;
    field.classList.toggle('is-valid', dirty && parsed !== null);
    field.classList.toggle('is-invalid', dirty && parsed === null);
    hint.classList.toggle('is-ok', dirty && parsed !== null);
    hint.classList.toggle('is-error', dirty && parsed === null);
    if (!dirty) {
      hint.textContent = 'Cualquier cantidad positiva.';
    } else if (parsed !== null) {
      hint.textContent = `Invertiré ${formatAmount(parsed)} HatoCoins.`;
    } else {
      hint.textContent = errorMessageFor(raw);
      playSound('error');
    }
  }

  private setCategory(id: InvestmentCategory | null): void {
    this.category = id;
    for (const btn of qa<HTMLButtonElement>(this.stage, '[data-action="category"]')) {
      btn.classList.toggle('is-selected', btn.dataset.category === id);
      btn.setAttribute('aria-pressed', btn.dataset.category === id ? 'true' : 'false');
    }
    for (const btn of qa<HTMLButtonElement>(this.stage, '[data-action="category-none"]')) {
      const on_ = id === null;
      btn.classList.toggle('is-selected', on_);
      btn.setAttribute('aria-pressed', on_ ? 'true' : 'false');
    }
  }

  private setStep(step: 'amount' | 'category'): void {
    this.step = step;
    if (this.el.stepAmount) this.el.stepAmount.hidden = step !== 'amount';
    if (this.el.stepCategory) this.el.stepCategory.hidden = step !== 'category';
    if (step === 'category') {
      this.el.customInput?.blur();
    } else {
      this.el.customInput?.focus({ preventScroll: true });
    }
  }

  private goToCategory(): void {
    if (this.busy || this.amount === null) {
      playSound('error');
      return;
    }
    this.markInteraction();
    this.setStep('category');
    playSound('select');
  }

  private goToReview(): void {
    if (this.busy || this.amount === null) return;
    this.markInteraction();
    const amount = this.amount;
    if (this.el.confirmAmount) this.el.confirmAmount.textContent = `${formatAmount(amount)} HM`;
    const meta = getCategory(this.category);
    if (this.el.confirmCategory) {
      this.el.confirmCategory.textContent = meta ? `${meta.emoji} ${meta.label}` : '🪙 HatoCoins';
    }
    this.setModal(this.el.confirmModal, true);
    playSound('select');
  }

  private closeConfirm(): void {
    this.setModal(this.el.confirmModal, false);
  }

  private setModal(modal: HTMLElement | null, open: boolean): void {
    if (!modal) return;
    modal.dataset.open = open ? 'true' : 'false';
    modal.setAttribute('aria-hidden', open ? 'false' : 'true');
    modal.classList.toggle('is-open', open);
  }

  /* ═════════════════════════════════════════════════════════════════════
     LA INVERSIÓN: 9 FASES
     ═════════════════════════════════════════════════════════════════════ */
  private async commit(): Promise<void> {
    if (this.busy || this.amount === null) return;
    await this.runInvestment(this.amount, this.category, q(this.stage, '[data-fx="invest-button"]'));
  }

  private async runInvestment(
    amount: number,
    category: InvestmentCategory | null,
    source: Element | null,
  ): Promise<void> {
    if (this.busy || !isValidAmount(amount)) {
      playSound('error');
      return;
    }
    if (!isReady()) {
      // El panel ya está bloqueado; esta es la red de seguridad para las
      // rutas que no pasan por él (teclado, demo, confirmación abierta).
      playSound('error');
      this.showNotify('Base de datos no disponible', '⚠️');
      window.setTimeout(() => this.hideNotify(), 2400);
      return;
    }
    this.busy = true;
    this.markInteraction();

    // Origen y destino de las monedas (coordenadas del escenario 1920 × 1080).
    const fallback = q(this.stage, '[data-fx="amount-continue"]') ?? this.stage;
    const originEl = source ?? fallback;
    const origin: Point = centerOf(originEl, this.stage, STAGE_W);
    const mouth = q(this.stage, '[data-fx="feeder-mouth"]');
    const target: Point = mouth ? centerOf(mouth, this.stage, STAGE_W) : { x: 960, y: 620 };

    const state = getState();
    const from = state.totalRaised;
    const levelFrom = Math.min(1, from / (state.goal || GOAL));

    // Cierra el modal y deja que el escenario se respire antes de volar.
    this.closeConfirm();
    this.stage.classList.add('is-investing');
    this.applyLock();
    setAnimating(true);
    this.fx.reset();
    await this.fx.sleep(210);

    // La escritura va primero y es bloqueante. La animación sólo arranca si
    // Supabase ya confirmó el total: mostrar una subida que la base de datos
    // no tiene sería mentirle al visitante (y perder su inversión).
    let result: WriteResult;
    try {
      result = await invest(amount, category);
    } catch (error) {
      this.busy = false;
      this.stage.classList.remove('is-investing');
      setAnimating(false);
      this.applyLock();
      playSound('error');
      this.showNotify('No se pudo guardar la inversión', '⚠️');
      window.setTimeout(() => this.hideNotify(), 2600);
      console.error('[HatoCoins] error al invertir:', error);
      this.render(this.view);
      return;
    }
    const next = result.state;
    const levelTo = Math.min(1, next.totalRaised / (next.goal || GOAL));

    const run = ++this.runId;
    const alive = (): boolean => run === this.runId;

    // El store ya tiene el total nuevo, pero la vista se congela en el anterior:
    // el contador sólo sube en la fase 6, cuando la comida aterriza en el comedero.
    this.displayedTotal = from;
    this.displayedLevel = levelFrom;
    this.paintProgress(from, next.goal, this.view.milestone.tone, this.view.message);

    // La meta subió: lo decide el servidor, no una comparación local. Y como la
    // meta salta de 100.000 a 200.000 en el mismo instante, el progreso baja al
    // 50 % justo después de celebrarse. Es lo que pediste: nunca se vuelve a
    // cero ni se bloquea el evento.
    const goalReached = result.tierUpgraded;

    try {
      await playInvestmentSequence(this.fx, {
        amount,
        category,
        from,
        to: next.totalRaised,
        levelFrom,
        levelTo,
        goalReached,
        layers: this.layers,
        origin,
        target,
        callbacks: {
          onPhase: (phase: SequencePhase) => this.onPhase(phase),
          onBadge: () => undefined,
          onBrissa: (brissaState) => {
            this.brissaOverride = brissaState;
            this.paintBrissa(brissaState);
          },
          onCounter: (value) => {
            if (!alive()) return;
            this.displayedTotal = value;
            // Se conserva el texto del hito: blanquearlo dejaba el panel mudo.
            this.paintProgress(value, next.goal, this.view.milestone.tone, this.view.message);
          },
          onFill: (level) => {
            if (!alive()) return;
            this.displayedLevel = level;
            if (this.el.feeder) {
              this.el.feeder.style.setProperty('--feeder-level', level.toFixed(4));
            }
          },
          onNotification: (text, emoji, tone) => {
            if (text) this.showNotify(text, emoji, tone);
            else this.hideNotify();
          },
          onCelebration: () => this.celebrate(goalReached),
        },
      });
    } finally {
      // Invalida cualquier tween en vuelo antes de fijar el estado final.
      this.runId += 1;
      this.brissaOverride = null;
      // Se relee del store y no del resultado capturado: si otra pantalla
      // invirtió durante la animación, el store ya tiene el total bueno.
      const final = getState();
      this.displayedTotal = final.totalRaised;
      this.displayedLevel = Math.min(1, final.totalRaised / (final.goal || GOAL));
      this.busy = false;
      this.stage.classList.remove('is-investing');
      this.applyLock();
      setAnimating(false);
      this.resetFlow();
      this.bounceFeeder();
      // Repinta el mensaje de hito: durante el conteo se pintó sin texto.
      this.render(this.view);
    }
  }

  private async undoLast(): Promise<void> {
    if (!isReady()) return;
    try {
      await undoLastInvestment();
      this.showNotify('Inversión deshecha', '↩️');
    } catch (error) {
      console.error('[HatoCoins] error al deshacer:', error);
      playSound('error');
      this.showNotify('No se pudo deshacer', '⚠️');
    }
    window.setTimeout(() => this.hideNotify(), 1400);
    this.render(this.view);
  }

  private onPhase(phase: SequencePhase): void {
    // Hook de instrumentación: cada fase es observable desde la consola.
    this.stage.dataset.phase = phase;
  }

  private bounceFeeder(): void {
    const feeder = this.el.feeder;
    if (!feeder) return;
    feeder.classList.remove('is-bouncing');
    void feeder.offsetWidth;
    feeder.classList.add('is-bouncing');
    window.setTimeout(() => feeder.classList.remove('is-bouncing'), 700);
  }

  /**
   * El bloqueo ya no depende de un parámetro: se bloquea si hay una animación
   * en curso O si la base de datos no está lista. Así el orden en que se
   * llame desde la animación deja de importar y no se puede quedar
   * desbloqueado por un error de una animación previa.
   */
  private applyLock(): void {
    const locked = this.busy || !isReady();
    const panel = this.el.investPanel;
    if (panel) panel.style.pointerEvents = locked ? 'none' : '';
    if (panel) panel.style.opacity = locked ? '0.45' : '';
    for (const btn of qa<HTMLButtonElement>(this.stage, '[data-action="preset"], [data-action="category"]')) {
      btn.disabled = locked;
    }
  }

  private resetFlow(): void {
    this.amount = null;
    this.category = null;
    if (this.el.customInput) this.el.customInput.value = '';
    if (this.el.customField) this.el.customField.classList.remove('is-valid', 'is-invalid');
    if (this.el.customHint) {
      this.el.customHint.textContent = 'Cualquier cantidad positiva.';
      this.el.customHint.classList.remove('is-ok', 'is-error');
    }
    this.setCategory(null);
    this.setAmount(null, false);
    this.setStep('amount');
  }

  /* ── Avisos ───────────────────────────────────────────────────────── */
  private showNotify(text: string, emoji: string, tone: 'gold' | 'goal' = 'gold'): void {
    const n = this.el.notification;
    if (!n) return;
    if (this.el.notifyTitle) this.el.notifyTitle.textContent = text;
    if (this.el.notifyEmoji) this.el.notifyEmoji.textContent = emoji;
    if (this.el.notifySub) this.el.notifySub.textContent = COPY.confirmBody;
    n.dataset.tone = tone;
    n.dataset.open = 'true';
  }

  private hideNotify(): void {
    if (this.el.notification) this.el.notification.dataset.open = 'false';
  }

  private celebrate(tierUpgraded: boolean): void {
    const c = this.el.celebration;
    if (!c) return;
    if (this.el.celebrateKicker) {
      // El servidor ya subió la meta, así que `view.goal` es la NUEVA. La que
      // se acaba de cruzar es la anterior, y a esa se le anuncia la siguiente:
      // el objetivo no tiene final, sólo se encadena.
      const view = this.view;
      const hit = view.goal - view.goalStep;
      this.el.celebrateKicker.textContent = tierUpgraded
        ? `${TIER_UP_MESSAGE} ${formatAmount(hit)} HM`
        : 'META COLECTIVA ALCANZADA';
    }
    if (this.el.celebrateSub) {
      this.el.celebrateSub.textContent = tierUpgraded
        ? `Brissa ya está alimentada. La siguiente meta es ${formatAmount(this.view.goal)} HM.`
        : 'Cada inversión alimenta una idea.';
    }
    c.dataset.open = 'true';
    if (this.el.confetti) this.fx.celebrate(this.el.confetti);
    if (!tierUpgraded) playSound('celebrate');
    window.setTimeout(() => {
      c.dataset.open = 'false';
    }, 5200);
  }

  /* ═════════════════════════════════════════════════════════════════════
     TECLADO
     ═════════════════════════════════════════════════════════════════════ */
  private onKeyDown(event: KeyboardEvent): void {
    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    // Modo organización.
    if (event.ctrlKey && event.shiftKey && lower === 'o') {
      event.preventDefault();
      this.openOrg();
      return;
    }
    // Modo demo.
    if (event.ctrlKey && event.shiftKey && lower === 'd') {
      event.preventDefault();
      this.toggleDemo();
      return;
    }
    if (this.busy) return;

    if (key === 'Escape') {
      if (this.el.orgModal?.dataset.open === 'true') this.closeOrg();
      else if (this.el.confirmModal?.dataset.open === 'true') this.closeConfirm();
      return;
    }

    if (key === 'Enter') {
      if (this.el.confirmModal?.dataset.open === 'true') {
        event.preventDefault();
        void this.commit();
        return;
      }
      if (this.step === 'amount') {
        event.preventDefault();
        this.goToCategory();
        return;
      }
      if (this.step === 'category') {
        event.preventDefault();
        this.goToReview();
        return;
      }
    }

    // Presets con 1–7.
    if (this.step === 'amount' && /^[1-7]$/.test(key)) {
      const value = PRESET_AMOUNTS[Number(key) - 1];
      if (value !== undefined) {
        event.preventDefault();
        this.setAmount(value, true);
        if (this.el.customInput) this.el.customInput.value = formatAmount(value);
        playSound('select');
      }
    }
  }

  /* ═════════════════════════════════════════════════════════════════════
     MODO ORGANIZACIÓN (protegido)
     ═════════════════════════════════════════════════════════════════════ */
  private openOrg(): void {
    const password = getOrgPassword();
    const modal = this.el.orgModal;
    const panel = this.el.orgPanel;
    if (!modal || !panel) return;
    if (password) {
      // Pide contraseña.
      this.setModal(modal, true);
      panel.dataset.view = 'password';
      if (this.el.orgPassword) {
        this.el.orgPassword.value = '';
        window.setTimeout(() => this.el.orgPassword?.focus({ preventScroll: true }), 60);
      }
    } else {
      // Sin contraseña configurada el panel se abre directo.
      panel.dataset.view = 'panel';
      this.setModal(modal, true);
    }
  }

  private checkOrgPassword(): void {
    const password = getOrgPassword();
    if (!password) {
      this.el.orgPanel?.setAttribute('data-view', 'panel');
      return;
    }
    const value = this.el.orgPassword?.value ?? '';
    if (value === password) {
      this.el.orgPanel?.setAttribute('data-view', 'panel');
      if (this.el.orgPassword) this.el.orgPassword.value = '';
    } else {
      playSound('error');
      this.el.orgPassword?.classList.add('is-wrong');
      window.setTimeout(() => this.el.orgPassword?.classList.remove('is-wrong'), 400);
    }
  }

  private closeOrg(): void {
    this.setModal(this.el.orgModal, false);
  }

  /* ═════════════════════════════════════════════════════════════════════
     SONIDO
     ═════════════════════════════════════════════════════════════════════ */
  private setupSoundButton(): void {
    if (!this.el.soundToggle) return;
    this.paintSound();
  }

  private paintSound(): void {
    const btn = this.el.soundToggle;
    if (!btn) return;
    const on = isSoundEnabled();
    btn.dataset.on = on ? 'true' : 'false';
    btn.textContent = on ? '🔊' : '🔇';
    btn.title = on ? 'Silenciar sonido' : 'Activar sonido';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  private toggleSoundUi(): void {
    toggleSound();
    this.paintSound();
  }

  /* ═════════════════════════════════════════════════════════════════════
     MODO DEMO
     ═════════════════════════════════════════════════════════════════════ */
  private setupDemo(): void {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('demo') === '1';
    let fromSession = false;
    try {
      fromSession = window.sessionStorage.getItem(DEMO_SESSION_KEY) === 'on';
    } catch {
      fromSession = false;
    }
    this.demoOn = isDev() || isDemoForced() || fromQuery || fromSession;
    this.paintDemo();
  }

  private toggleDemo(): void {
    this.demoOn = !this.demoOn;
    try {
      window.sessionStorage.setItem(DEMO_SESSION_KEY, this.demoOn ? 'on' : 'off');
    } catch {
      /* ignorado */
    }
    this.paintDemo();
  }

  private paintDemo(): void {
    const bar = this.el.demoBar;
    if (!bar) return;
    bar.hidden = !this.demoOn;
  }

  /* ═════════════════════════════════════════════════════════════════════
     INACTIVIDAD
     ═════════════════════════════════════════════════════════════════════ */
  private markInteraction(): void {
    this.lastInteraction = Date.now();
    if (this.idleOn) {
      this.idleOn = false;
      setIdle(0);
    }
  }

  private startIdleWatch(): void {
    this.lastInteraction = Date.now();
    this.idleTimer = window.setInterval(() => {
      if (this.busy) return;
      const idle = Date.now() - this.lastInteraction > IDLE_AFTER_MS;
      if (idle !== this.idleOn) {
        this.idleOn = idle;
        setIdle(idle ? IDLE_AFTER_MS : 0);
      }
    }, 2000);
  }

  /* ═════════════════════════════════════════════════════════════════════
     LIMPIEZA
     ═════════════════════════════════════════════════════════════════════ */
  destroy(): void {
    this.fx.cancelAll();
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
    this.unsubscribe?.();
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
  }
}

function isCategoryId(value: string | null | undefined): value is InvestmentCategory {
  return typeof value === 'string' && (INVESTMENT_CATEGORIES as readonly string[]).includes(value);
}

/** Marcado del historial cuando todavía no hay inversiones. */
function emptyHistoryMarkup(): string {
  return Array.from({ length: 5 }, (_, i) => {
    const meta = CATEGORIES[i % CATEGORIES.length];
    return `<li class="feed__row is-empty" data-history-key="ph-${i}"><span class="feed__emoji">${meta?.emoji ?? '🪙'}</span><span class="feed__amount">—</span><span class="feed__time">--:--</span></li>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════════════════
   ARRANQUE
   ═══════════════════════════════════════════════════════════════════════ */
function boot(): void {
  const stage = document.querySelector<HTMLElement>('[data-stage]');
  if (!stage) return;
  const game = new HatoGame(stage);
  // Limpieza total al salir: ni timers, ni listeners, ni nodos huérfanos.
  window.addEventListener('pagehide', () => game.destroy(), { once: true });
  // Utilidad mínima para depuración en el stand.
  (window as unknown as { hatoGame?: HatoGame }).hatoGame = game;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
