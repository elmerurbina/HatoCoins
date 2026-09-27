import { SETTINGS_KEY } from './config';

/**
 * Motor de sonido 100% sintetizado con WebAudio.
 * · Cero archivos de audio → cero descargas → funciona offline.
 * · SILENCIADO POR DEFECTO. Nada suena sin interacción previa del usuario.
 * · El AudioContext se crea perezosamente en el primer gesto real.
 */

export type SoundName = 'coin' | 'food' | 'success' | 'celebrate' | 'select' | 'error' | 'tick';

type Sfx = Record<SoundName, () => void>;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = false;
let readPreference = false;

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

function readStoredPreference(): boolean {
  if (readPreference) return enabled;
  readPreference = true;
  if (!isBrowser()) return false;
  try {
    enabled = window.localStorage.getItem(SETTINGS_KEY) === 'sound:on';
  } catch {
    enabled = false;
  }
  return enabled;
}

function ensureContext(): AudioContext | null {
  if (!isBrowser()) return null;
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = 0.28;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

function tone(
  frequency: number,
  start: number,
  duration: number,
  options: {
    type?: OscillatorType;
    gain?: number;
    sweepTo?: number;
    delay?: number;
  } = {},
): void {
  const context = ensureContext();
  if (!context || !master) return;
  const {
    type = 'sine',
    gain = 0.5,
    sweepTo,
    delay = 0,
  } = options;
  const t0 = context.currentTime + start + delay;
  const osc = context.createOscillator();
  const env = context.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, t0);
  if (sweepTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t0 + duration);
  }
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + Math.min(0.02, duration * 0.3));
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(env);
  env.connect(master);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

function noise(duration: number, options: { gain?: number; freq?: number; q?: number; delay?: number } = {}): void {
  const context = ensureContext();
  if (!context || !master) return;
  const { gain = 0.25, freq = 1400, q = 0.9, delay = 0 } = options;
  const t0 = context.currentTime + delay;
  const frames = Math.floor(context.sampleRate * duration);
  if (frames <= 0) return;
  const buffer = context.createBuffer(1, frames, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  }
  const src = context.createBufferSource();
  src.buffer = buffer;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const env = context.createGain();
  env.gain.setValueAtTime(gain, t0);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter);
  filter.connect(env);
  env.connect(master);
  src.start(t0);
  src.stop(t0 + duration + 0.02);
}

const sfx: Sfx = {
  select: () => {
    tone(660, 0, 0.09, { type: 'triangle', gain: 0.28, sweepTo: 880 });
  },
  tick: () => {
    tone(1500, 0, 0.035, { type: 'square', gain: 0.1 });
  },
  coin: () => {
    // Moneda metálica: dos armónicos brillantes + repique.
    tone(1180, 0, 0.11, { type: 'triangle', gain: 0.3, sweepTo: 1760 });
    tone(2360, 0.02, 0.09, { type: 'sine', gain: 0.16 });
    noise(0.06, { gain: 0.1, freq: 4200, q: 2.2 });
  },
  food: () => {
    // Granos cayendo: Impactsos short y granulares.
    for (let i = 0; i < 5; i += 1) {
      noise(0.05, { gain: 0.16, freq: 700 + i * 220, q: 1.1, delay: i * 0.045 });
    }
    tone(220, 0, 0.14, { type: 'sine', gain: 0.16, sweepTo: 130 });
  },
  success: () => {
    // Arpegio mayor ascendente: "recompensa".
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => {
      tone(f, i * 0.075, 0.2, { type: 'triangle', gain: 0.3 });
      tone(f * 2, i * 0.075, 0.12, { type: 'sine', gain: 0.09 });
    });
    tone(1567.98, 0.34, 0.42, { type: 'sine', gain: 0.14 });
  },
  celebrate: () => {
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98];
    notes.forEach((f, i) => {
      tone(f, i * 0.085, 0.3, { type: 'triangle', gain: 0.26 });
    });
    noise(0.5, { gain: 0.14, freq: 5200, q: 0.6, delay: 0.1 });
    tone(1046.5, 0.5, 0.7, { type: 'sine', gain: 0.18 });
    tone(1318.5, 0.56, 0.7, { type: 'sine', gain: 0.13 });
    tone(2093, 0.62, 0.6, { type: 'sine', gain: 0.08 });
  },
  error: () => {
    tone(320, 0, 0.16, { type: 'sawtooth', gain: 0.16, sweepTo: 190 });
  },
};

/* ── API pública ─────────────────────────────────────────────────────── */

export function isSoundEnabled(): boolean {
  return readStoredPreference();
}

/** Activa o desactiva. `true` = encendido. Persiste la preferencia. */
export function setSoundEnabled(value: boolean): boolean {
  enabled = value;
  readPreference = true;
  if (isBrowser()) {
    try {
      window.localStorage.setItem(SETTINGS_KEY, value ? 'sound:on' : 'sound:off');
    } catch {
      /* ignorado */
    }
  }
  if (value) {
    ensureContext();
    sfx.select();
  }
  return enabled;
}

export function toggleSound(): boolean {
  return setSoundEnabled(!isSoundEnabled());
}

/** Reproduce un efecto. No hace nada si el sonido está apagado. */
export function playSound(name: SoundName): void {
  if (!isSoundEnabled()) return;
  const fx = sfx[name];
  if (!fx) return;
  fx();
}

/** Libera el AudioContext (limpieza en `beforeunload`). */
export function disposeAudio(): void {
  if (ctx) {
    void ctx.close().catch(() => undefined);
    ctx = null;
    master = null;
  }
}
