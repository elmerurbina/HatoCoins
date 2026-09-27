import type { BrissaState, InvestmentCategory } from './types';
import { formatAmount } from './investments';
import { playSound } from './audio';
import { BADGE_MS, CATEGORY_BY_ID, INVESTMENT_SEQUENCE_MS } from './config';

/* ═══════════════════════════════════════════════════════════════════════
   EASING
   ═══════════════════════════════════════════════════════════════════════ */
export const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
export const easeOutExpo = (t: number): number => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const rand = (min: number, max: number): number => min + Math.random() * (max - min);

/* ═══════════════════════════════════════════════════════════════════════
   TIPOS
   ═══════════════════════════════════════════════════════════════════════ */
export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Capas de efectos visuales montadas dentro del escenario. */
export interface FxLayers {
  root: HTMLElement;
  coins: HTMLElement;
  grains: HTMLElement;
  sparks: HTMLElement;
  badge: HTMLElement;
  flash: HTMLElement;
}

interface Particle {
  el: HTMLElement;
  /** Posición inicial (left/top del elemento). */
  bx: number;
  by: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  life: number;
  maxLife: number;
}

export type SequencePhase =
  | 'idle'
  | 'launch'
  | 'coins'
  | 'food'
  | 'fill'
  | 'count'
  | 'brissa'
  | 'notify'
  | 'settle';

export interface SequenceCallbacks {
  onPhase: (phase: SequencePhase) => void;
  onBadge: (amount: number, category: InvestmentCategory | null) => void;
  onBrissa: (state: BrissaState) => void;
  onCounter: (value: number) => void;
  onFill: (level: number) => void;
  onNotification: (text: string, emoji: string, tone: 'gold' | 'goal') => void;
  onCelebration: () => void;
}

export interface SequenceContext {
  amount: number;
  category: InvestmentCategory | null;
  from: number;
  to: number;
  levelFrom: number;
  levelTo: number;
  goalReached: boolean;
  layers: FxLayers;
  /** Boca del comedero, en coordenadas del escenario (1920 × 1080). */
  target: Point;
  /** Botón que lanzó la inversión. */
  origin: Point;
  callbacks: SequenceCallbacks;
}

/* ═══════════════════════════════════════════════════════════════════════
   UTILIDADES GEOMÉTRICAS
   ═══════════════════════════════════════════════════════════════════════ */
export function quadraticBezier(p0: Point, p1: Point, p2: Point, t: number): Point {
  const inv = 1 - t;
  return {
    x: inv * inv * p0.x + 2 * inv * t * p1.x + t * t * p2.x,
    y: inv * inv * p0.y + 2 * inv * t * p1.y + t * t * p2.y,
  };
}

/**
 * Rectángulo de `element` expresado en el sistema de coordenadas de `ancestor`,
 * corrigiendo la escala del escenario 16:9 (1920 px intrínsecos).
 * Evita `offsetWidth`, que no existe en elementos SVG.
 */
export function boxIn(element: Element, ancestor: Element, intrinsicWidth = 1920): Box {
  const r = element.getBoundingClientRect();
  const a = ancestor.getBoundingClientRect();
  const scale = a.width > 0 ? a.width / intrinsicWidth : 1;
  const s = scale || 1;
  return {
    x: (r.left - a.left) / s,
    y: (r.top - a.top) / s,
    width: r.width / s,
    height: r.height / s,
  };
}

export function centerOf(element: Element, ancestor: Element, intrinsicWidth = 1920): Point {
  const b = boxIn(element, ancestor, intrinsicWidth);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/* ═══════════════════════════════════════════════════════════════════════
   MOTOR DE EFECTOS
   Una única instancia que posee TODAS las animaciones en vuelo.
   `cancelAll()` las detiene a todas: nada de timers huérfanos ni leaks
   aunque el visitante invierta 500 veces seguidas en el stand.
   ═══════════════════════════════════════════════════════════════════════ */
export class Fx {
  private timers = new Set<number>();
  private resolvers = new Map<number, () => void>();
  private frameWaiters = new Set<number>();
  private animations = new Set<Animation>();
  private particles: Particle[] = [];
  private grainFloor = 0;
  private physicsRunning = false;
  private physicsRaf: number | null = null;
  private celebrateRaf: number | null = null;
  private cancelled = false;

  get isCancelled(): boolean {
    return this.cancelled;
  }

  reset(): void {
    this.cancelled = false;
  }

  /* ── Capa de montaje ────────────────────────────────────────────────── */

  mount(host: HTMLElement): FxLayers {
    let root = host.querySelector<HTMLElement>('[data-fx-root]');
    if (!root) {
      root = document.createElement('div');
      root.className = 'hm-fx';
      root.setAttribute('data-fx-root', '');
      root.setAttribute('aria-hidden', 'true');
      host.append(root);
    }
    const owner = root;
    const pick = (name: string): HTMLElement => {
      let el = owner.querySelector<HTMLElement>(`[data-fx-layer="${name}"]`);
      if (!el) {
        el = document.createElement('div');
        el.className = `hm-fx__layer hm-fx__layer--${name}`;
        el.setAttribute('data-fx-layer', name);
        owner.append(el);
      }
      return el;
    };
    return {
      root: owner,
      coins: pick('coins'),
      grains: pick('grains'),
      sparks: pick('sparks'),
      badge: pick('badge'),
      flash: pick('flash'),
    };
  }

  /* ── Reloj cooperativo cancelable ───────────────────────────────────── */

  sleep(ms: number): Promise<void> {
    if (this.cancelled || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const id = window.setTimeout(() => {
        this.timers.delete(id);
        this.resolvers.delete(id);
        resolve();
      }, ms);
      this.timers.add(id);
      this.resolvers.set(id, resolve);
    });
  }

  private nextFrame(): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const id = window.requestAnimationFrame(() => {
        this.frameWaiters.delete(id);
        resolve();
      });
      this.frameWaiters.add(id);
    });
  }

  private track(animation: Animation): Animation {
    this.animations.add(animation);
    const drop = (): void => {
      this.animations.delete(animation);
    };
    void animation.finished.then(drop).catch(drop);
    return animation;
  }

  /** Detiene y limpia absolutamente todo lo que esté en vuelo. */
  cancelAll(): void {
    this.cancelled = true;
    for (const id of this.timers) {
      window.clearTimeout(id);
      this.resolvers.get(id)?.();
    }
    this.timers.clear();
    this.resolvers.clear();
    for (const id of this.frameWaiters) window.cancelAnimationFrame(id);
    this.frameWaiters.clear();
    for (const animation of this.animations) {
      try {
        animation.cancel();
      } catch {
        /* ya finalizada */
      }
    }
    this.animations.clear();
    for (const p of this.particles) p.el.remove();
    this.particles = [];
    if (this.physicsRaf !== null) {
      window.cancelAnimationFrame(this.physicsRaf);
      this.physicsRaf = null;
    }
    this.physicsRunning = false;
    if (this.celebrateRaf !== null) {
      window.cancelAnimationFrame(this.celebrateRaf);
      this.celebrateRaf = null;
    }
  }

  /* ═════════════════════════════════════════════════════════════════════
     FASE 1 · Insignia "+500 HM"
     ═════════════════════════════════════════════════════════════════════ */
  async playBadge(layers: FxLayers, amount: number, category: InvestmentCategory | null): Promise<void> {
    const meta = category ? CATEGORY_BY_ID[category] : null;
    layers.badge.textContent = '';
    const amountEl = document.createElement('div');
    amountEl.className = 'hm-badge__amount';
    amountEl.textContent = `+${formatAmount(amount)} HM`;
    const tagEl = document.createElement('div');
    tagEl.className = 'hm-badge__tag';
    tagEl.textContent = meta ? `${meta.emoji}  ${meta.label}` : '🪙  HatoCoins';
    layers.badge.append(amountEl, tagEl);

    layers.badge.classList.remove('is-live');
    void layers.badge.offsetWidth; // reflow: reinicia la animación
    layers.badge.classList.add('is-live');
    playSound('coin');
    // Se espera la duración completa de `hm-badge-in` para no cortar la animación.
    await this.sleep(BADGE_MS);
    layers.badge.classList.remove('is-live');
  }

  /** Flash de pantalla para impactos grandes. */
  flash(layers: FxLayers, hard: boolean): void {
    if (!hard) return;
    layers.flash.classList.remove('is-hard', 'is-live');
    void layers.flash.offsetWidth;
    layers.flash.classList.add('is-hard', 'is-live');
  }

  /** Apaga el destello de pantalla. */
  clearFlash(layers: FxLayers): void {
    layers.flash.classList.remove('is-live');
  }

  /* ═════════════════════════════════════════════════════════════════════
     FASE 2 · Monedas HatoCoins volando en arco hacia el comedero
     ═════════════════════════════════════════════════════════════════════ */
  coinCountFor(amount: number): number {
    return clamp(Math.round(Math.sqrt(Math.max(1, amount)) / 1.7), 6, 22);
  }

  flyCoins(layers: FxLayers, origin: Point, target: Point, amount: number): void {
    const count = this.coinCountFor(amount);
    for (let i = 0; i < count; i += 1) {
      const from: Point = { x: origin.x + rand(-120, 120), y: origin.y + rand(-80, 40) };
      const to: Point = { x: target.x + rand(-60, 60), y: target.y + rand(-30, 14) };
      const control: Point = {
        x: (from.x + to.x) / 2 + rand(-200, 200),
        y: Math.min(from.y, to.y) - rand(170, 430),
      };
      this.spawnCoin(layers, from, control, to, rand(780, 1090), i * 44 + rand(0, 60));
    }
  }

  private spawnCoin(
    layers: FxLayers,
    p0: Point,
    p1: Point,
    p2: Point,
    duration: number,
    delay: number,
  ): void {
    const el = document.createElement('div');
    el.className = 'hm-coin';
    el.style.left = `${p0.x}px`;
    el.style.top = `${p0.y}px`;
    const face = document.createElement('span');
    face.className = 'hm-coin__face';
    face.textContent = 'H';
    el.append(face);
    layers.coins.append(el);

    const spin = rand(320, 780) * (Math.random() > 0.5 ? 1 : -1);
    const steps = 24;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const p = quadraticBezier(p0, p1, p2, easeInOutCubic(t));
      // Se hunde al llegar: sensación de peso dentro del comedero.
      const scale = t < 0.76 ? 0.68 + t * 0.6 : 1.13 - (t - 0.76) * 0.55;
      frames.push({
        offset: t,
        transform: `translate3d(${(p.x - p0.x).toFixed(1)}px, ${(p.y - p0.y).toFixed(1)}px, 0) rotate(${(spin * t).toFixed(1)}deg) scale(${scale.toFixed(3)})`,
        opacity: t > 0.86 ? (1 - (t - 0.86) / 0.14).toFixed(2) : '1',
      });
    }

    const animation = this.track(
      el.animate(frames, { duration, delay, easing: 'linear', fill: 'both' }),
    );

    void animation.finished
      .then(() => {
        if (!el.isConnected) return;
        const arrival = quadraticBezier(p0, p1, p2, 1);
        el.remove();
        this.spawnSplash(layers, arrival, 'coin');
        playSound('coin');
      })
      .catch(() => el.remove());
  }

  /* ═════════════════════════════════════════════════════════════════════
     FASES 3 y 4 · Chispas y granos de alimento con física real
     ═════════════════════════════════════════════════════════════════════ */
  spawnSplash(layers: FxLayers, at: Point, kind: 'coin' | 'food'): void {
    const count = kind === 'coin' ? 7 : 6;
    for (let i = 0; i < count; i += 1) {
      const el = document.createElement('span');
      el.className = `hm-spark hm-spark--${kind}`;
      el.style.left = `${at.x}px`;
      el.style.top = `${at.y}px`;
      layers.sparks.append(el);
      const angle = rand(0, Math.PI * 2);
      const speed = kind === 'coin' ? rand(110, 330) : rand(70, 200);
      this.particles.push({
        el,
        bx: at.x,
        by: at.y,
        x: at.x,
        y: at.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 70,
        spin: 0,
        life: 0,
        maxLife: rand(320, 640),
      });
    }
    this.ensurePhysics();
  }

  /** Granos de comida cayendo dentro del comedero. */
  pourFood(layers: FxLayers, at: Point, amount: number, floorY: number): void {
    this.grainFloor = floorY;
    const count = clamp(Math.round(Math.sqrt(Math.max(1, amount)) / 2.2) + 10, 14, 44);
    for (let i = 0; i < count; i += 1) {
      const el = document.createElement('span');
      const size = rand(7, 15);
      el.className = 'hm-grain';
      el.style.width = `${size}px`;
      el.style.height = `${(size * rand(0.6, 0.9)).toFixed(1)}px`;
      const x = at.x + rand(-74, 74);
      const y = at.y + rand(-44, 12);
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      layers.grains.append(el);
      this.particles.push({
        el,
        bx: x,
        by: y,
        x,
        y,
        vx: rand(-80, 80),
        vy: rand(60, 280),
        spin: rand(-300, 300),
        life: 0,
        maxLife: rand(1100, 2000),
      });
    }
    this.ensurePhysics();
  }

  private ensurePhysics(): void {
    if (this.physicsRunning || this.cancelled) return;
    this.physicsRunning = true;
    let last = performance.now();

    const step = (now: number): void => {
      this.physicsRaf = null;
      if (this.cancelled) {
        this.physicsRunning = false;
        return;
      }
      // dt acotado: si la pestaña estuvo en segundo plano no "teletransporta".
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      for (let i = this.particles.length - 1; i >= 0; i -= 1) {
        const p = this.particles[i];
        if (!p) continue;
        p.life += dt * 1000;

        const isGrain = p.el.classList.contains('hm-grain');
        if (isGrain) {
          p.vy += 1500 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          if (p.y >= this.grainFloor && p.vy > 0) {
            p.y = this.grainFloor;
            p.vy *= -0.32;
            p.vx *= 0.7;
            if (Math.abs(p.vy) < 46) p.vy = 0;
          }
        } else {
          p.vy += 880 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }

        const k = 1 - p.life / p.maxLife;
        p.el.style.transform = `translate3d(${(p.x - p.bx).toFixed(1)}px, ${(p.y - p.by).toFixed(1)}px, 0) rotate(${p.spin.toFixed(0)}deg) scale(${clamp(isGrain ? 1 : k, 0.15, 1).toFixed(2)})`;
        p.el.style.opacity = String(clamp(isGrain ? k * 1.8 : k, 0, 1));

        if (p.life >= p.maxLife) {
          p.el.remove();
          this.particles.splice(i, 1);
        }
      }

      if (this.particles.length > 0) {
        this.physicsRaf = window.requestAnimationFrame(step);
      } else {
        this.physicsRunning = false;
      }
    };

    this.physicsRaf = window.requestAnimationFrame(step);
  }

  /* ═════════════════════════════════════════════════════════════════════
     FASE 6 · Contador interpolado con rebote de recompensa
     ═══════════════════════════════════════════════════════════════════════ */
  async tweenCounter(from: number, to: number, onUpdate: (value: number) => void): Promise<void> {
    if (this.cancelled) return;
    const delta = to - from;
    if (delta === 0) {
      onUpdate(to);
      return;
    }
    const start = performance.now();
    const duration = 1000;
    const sign = delta >= 0 ? 1 : -1;
    let lastTick = from;

    for (;;) {
      if (this.cancelled) return;
      const t = clamp((performance.now() - start) / duration, 0, 1);
      // easeOutExpo + un rebote por encima del objetivo que vuelve a entrar.
      const overshoot = t < 1 ? Math.sin(clamp((t - 0.82) / 0.18, 0, 1) * Math.PI) * 0.035 : 0;
      const value = Math.round(from + delta * (easeOutExpo(t) + overshoot * sign));
      const clamped = t < 1 ? value : to;

      if (Math.abs(clamped - lastTick) >= 90) {
        lastTick = clamped;
        playSound('tick');
      }
      onUpdate(clamped);

      if (t >= 1) {
        onUpdate(to);
        return;
      }
      await this.nextFrame();
    }
  }

  /* ═════════════════════════════════════════════════════════════════════
     FASE 5 · Relleno del comedero con muelle amortiguado
     ═══════════════════════════════════════════════════════════════════════ */
  async springFill(from: number, to: number, onUpdate: (level: number) => void): Promise<void> {
    if (this.cancelled) return;
    const start = performance.now();
    const duration = 820;
    const delta = to - from;
    for (;;) {
      if (this.cancelled) return;
      const t = clamp((performance.now() - start) / duration, 0, 1);
      const bounce = t < 1 ? Math.sin(t * Math.PI * 3) * (1 - t) ** 2 * 0.05 : 0;
      onUpdate(clamp(from + delta * (easeOutCubic(t) + bounce * (delta >= 0 ? 1 : -1)), 0, 1));
      if (t >= 1) {
        onUpdate(to);
        return;
      }
      await this.nextFrame();
    }
  }

  /* ═════════════════════════════════════════════════════════════════════
     CONFETI DE META (canvas, se autodestruye al terminar)
     ═══════════════════════════════════════════════════════════════════════ */
  celebrate(canvas: HTMLCanvasElement, durationMs = 5600): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (this.celebrateRaf !== null) window.cancelAnimationFrame(this.celebrateRaf);

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = 1920;
    const height = 1080;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = ['#eabf4e', '#45a75f', '#55a6c6', '#a583e0', '#dcc094', '#f4d681', '#7fca8d'];
    const pieces = Array.from({ length: 200 }, () => ({
      x: rand(-80, width + 80),
      y: rand(-height, -40),
      w: rand(7, 16),
      h: rand(10, 24),
      vy: rand(160, 440),
      vx: rand(-90, 90),
      rot: rand(0, Math.PI * 2),
      vr: rand(-5, 5),
      color: colors[Math.floor(Math.random() * colors.length)] ?? '#eabf4e',
      phase: rand(0, 6.28),
    }));

    const start = performance.now();
    const frame = (now: number): void => {
      this.celebrateRaf = null;
      if (this.cancelled) return;
      const elapsed = now - start;
      ctx.clearRect(0, 0, width, height);
      const dt = 1 / 60;
      for (const p of pieces) {
        p.y += p.vy * dt;
        p.x += (p.vx + Math.sin(elapsed / 420 + p.phase) * 70) * dt;
        p.rot += p.vr * dt;
        if (p.y > height + 40) {
          p.y = -40;
          p.x = rand(0, width);
        }
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = 0.92;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (elapsed < durationMs) {
        this.celebrateRaf = window.requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, width, height);
      }
    };
    this.celebrateRaf = window.requestAnimationFrame(frame);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   ORQUESTA DE LA SECUENCIA COMPLETA  (≈ 3.2 s, 9 fases)
   ═══════════════════════════════════════════════════════════════════════ */
export async function playInvestmentSequence(fx: Fx, ctx: SequenceContext): Promise<void> {
  const { amount, category, layers, target, origin, callbacks } = ctx;
  const big = amount >= 500;
  const huge = amount >= 2000;

  // Reloj de la secuencia: la última fase absorbe lo que falte para acercarse a
  // INVESTMENT_SEQUENCE_MS, sin depender de una suma escrita a mano. Se mide el
  // tiempo real, no el pedido, para que una fase más larga no desborde el total.
  let elapsed = 0;
  const wait = async (ms: number): Promise<void> => {
    const t0 = performance.now();
    await fx.sleep(ms);
    elapsed += performance.now() - t0;
  };

  /* FASE 1 — "+500 HM" */
  callbacks.onPhase('launch');
  void fx.playBadge(layers, amount, category);
  callbacks.onBadge(amount, category);
  fx.flash(layers, huge);
  await wait(BADGE_MS);

  /* FASE 2 — las monedas vuelan hacia el comedero */
  callbacks.onPhase('coins');
  fx.flyCoins(layers, origin, target, amount);
  await wait(320);

  /* FASE 3 — la comida cae dentro del comedero */
  callbacks.onPhase('food');
  callbacks.onBrissa('receiving');
  fx.pourFood(layers, { x: target.x, y: target.y - 78 }, amount, target.y + 38);
  playSound('food');
  await wait(190);

  /* FASE 4 y 5 — el comedero se llena */
  callbacks.onPhase('fill');
  void fx.springFill(ctx.levelFrom, ctx.levelTo, callbacks.onFill);
  fx.spawnSplash(layers, { x: target.x, y: target.y + 20 }, 'food');
  await wait(140);

  /* FASE 6 — el contador sube interpolado */
  callbacks.onPhase('count');
  // El tweener va "en vuelo" a propósito: se.await lo dejaría colgado si el
  // navegador pausa los rAF (pestaña en segundo plano). Quien lo usa descarta los
  // cuadros tardíos con un token de ejecución (ver HatoGame.commit).
  void fx.tweenCounter(ctx.from, ctx.to, callbacks.onCounter);
  await wait(360);

  /* FASE 7 — Brissa reacciona */
  callbacks.onPhase('brissa');
  if (big) callbacks.onBrissa('happy');
  playSound('success');
  await wait(200);

  /* FASE 8 — recompensa en pantalla */
  callbacks.onPhase('notify');
  const meta = category ? CATEGORY_BY_ID[category] : null;
  callbacks.onNotification(
    `¡BRISSA RECIBIÓ ${formatAmount(amount)} HatoCoins!`,
    meta ? meta.emoji : '🪙',
    'gold',
  );
  if (ctx.goalReached) {
    playSound('celebrate');
    callbacks.onCelebration();
  }
  await wait(Math.max(200, INVESTMENT_SEQUENCE_MS - elapsed));

  /* FASE 9 — vuelta suave al estado normal */
  callbacks.onPhase('settle');
  callbacks.onNotification('', '', 'gold');
  fx.clearFlash(layers);
  callbacks.onBrissa(ctx.goalReached ? 'completed' : 'happy');
}
