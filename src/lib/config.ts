import type { CategoryMeta, CategoryTotals, GameState, Milestone } from './types';
import { INVESTMENT_CATEGORIES } from './types';

/* ═══════════════════════════════════════════════════════════════════════
   SUPABASE

   El estado del juego ya NO vive en `localStorage`: vive en Supabase, para
   que todas las pantallas del stand compartan los mismos totales en vivo.
   Ver `supabase/migrations/0001_init.sql` para el esquema.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Identificador del evento dentro de la base de datos. Dos eventos distintos
 * (por ejemplo, dos actos en el mismo stand) coexisten cambiando este valor
 * y desplegando con otra variable de entorno.
 */
export const EVENT_ID =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.PUBLIC_EVENT_ID?.trim() ||
  'default';

/**
 * Única clave que sigue en `localStorage`, y es deliberado: el sonido es una
 * preferencia DEL DISPOSITIVO, no del evento. Si se guardara en la base de
 * datos, apagar el sonido en una pantalla silenciaría a todas las demás.
 */
export const SETTINGS_KEY = 'hatomaster_brissa_settings';

/* ═══════════════════════════════════════════════════════════════════════
   METAS POR ETAPAS  ← aquí se cambia la meta del stand

   No hay un techo: cuando se alcanza `GOAL`, la meta sube sola a
   `GOAL + GOAL_STEP` (100.000 → 200.000 → 300.000…) y el avance lo aplica
   el trigger de PostgreSQL, de modo que todas las pantallas lo ven a la vez.
   En la práctica casi nunca se usa el valor de `.env`: lo lee la base de
   datos, que es la autoridad. Sólo importa la primera vez que se crea el
   evento.
   ═══════════════════════════════════════════════════════════════════════ */
const ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export const GOAL = positiveInt(ENV.PUBLIC_GOAL, 100_000);
export const GOAL_STEP = positiveInt(ENV.PUBLIC_GOAL_STEP, 100_000);

/* ═══════════════════════════════════════════════════════════════════════
   CANTIDADES PREDEFINIDAS (sugerencias; el usuario puede escribir lo que sea)
   ═══════════════════════════════════════════════════════════════════════ */
export const PRESET_AMOUNTS: readonly number[] = [10, 50, 100, 250, 500, 1000, 2500];

/** Cantidades del modo demo. */
export const DEMO_AMOUNTS: readonly number[] = [100, 500, 1000, 2500];

/** Máximo de registros conservados en el historial (rendimiento en TV). */
export const MAX_HISTORY = 250;

/** MáximoShown en "últimas inversiones". */
export const HISTORY_VISIBLE = 5;

/** Duración de la secuencia de animación de inversión (ms). */
export const INVESTMENT_SEQUENCE_MS = 3200;

/** Duración de la insignia "+X HM". Debe coincidir con `hm-badge-in` en global.css. */
export const BADGE_MS = 620;

/** Milisegundos de inactividad antes de que Brissa pase a modo "esperando". */
export const IDLE_AFTER_MS = 18_000;

/* ═══════════════════════════════════════════════════════════════════════
   CATEGORÍAS
   ═══════════════════════════════════════════════════════════════════════ */
export const CATEGORIES: readonly CategoryMeta[] = [
  {
    id: 'ganaderia',
    emoji: '🐄',
    label: 'Gestión Ganadera',
    shortLabel: 'Gestión',
    accent: 'text-hm-green-300',
    glow: 'shadow-[0_0_28px_-6px_rgb(69_167_95/0.75)]',
    blurb: 'Registro, salud y bienestar del hato.',
  },
  {
    id: 'ia',
    emoji: '🤖',
    label: 'Inteligencia Artificial',
    shortLabel: 'IA',
    accent: 'text-hm-purple-300',
    glow: 'shadow-[0_0_28px_-6px_rgb(165_131_224/0.75)]',
    blurb: 'Modelos que convierten datos en decisiones.',
  },
  {
    id: 'datos',
    emoji: '📊',
    label: 'Datos & Analítica',
    shortLabel: 'Datos',
    accent: 'text-hm-blue-300',
    glow: 'shadow-[0_0_28px_-6px_rgb(85_166_198/0.75)]',
    blurb: 'Indicadores claros para decidir mejor.',
  },
  {
    id: 'offline',
    emoji: '📱',
    label: 'Tecnología Offline',
    shortLabel: 'Offline',
    accent: 'text-hm-earth-200',
    glow: 'shadow-[0_0_28px_-6px_rgb(220_192_148/0.7)]',
    blurb: 'Funciona en la finca, con o sin señal.',
  },
  {
    id: 'rural',
    emoji: '🌱',
    label: 'Transformación Rural',
    shortLabel: 'Rural',
    accent: 'text-hm-gold-300',
    glow: 'shadow-[0_0_28px_-6px_rgb(244_214_129/0.7)]',
    blurb: 'Más productividad para la comunidad.',
  },
] as const;

export const CATEGORY_BY_ID: Readonly<Record<string, CategoryMeta>> = Object.freeze(
  Object.fromEntries(CATEGORIES.map((c) => [c.id, c])),
);

export function getCategory(id: string | null | undefined): CategoryMeta | null {
  if (!id) return null;
  return CATEGORY_BY_ID[id] ?? null;
}

/* ═══════════════════════════════════════════════════════════════════════
   ETAPAS NARRATIVAS DE PROGRESO
   ═══════════════════════════════════════════════════════════════════════ */
export const MILESTONES: readonly Milestone[] = [
  {
    from: 0,
    to: 20,
    message: 'Brissa está esperando...',
    tone: 'calm',
  },
  {
    from: 20,
    to: 40,
    message: '¡Ya empezamos a llenar el comedero!',
    tone: 'warm',
  },
  {
    from: 40,
    to: 60,
    message: '¡La comunidad está creciendo!',
    tone: 'good',
  },
  {
    from: 60,
    to: 80,
    message: '¡Brissa ya está comiendo!',
    tone: 'great',
  },
  {
    from: 80,
    to: 100,
    message: '🔥 ¡YA CASI!',
    tone: 'fire',
  },
  {
    // La meta se puede superar: al 100% o más el mensaje es de logro, no de
    // "casi". Sin esta etapa, `milestoneFor` devolvía "¡YA CASI!" con la meta
    // ya alcanzada.
    from: 100,
    to: Number.POSITIVE_INFINITY,
    message: '🎉 ¡META ALCANZADA! Brissa está alimentada.',
    tone: 'goal',
  },
] as const;

export const GOAL_MESSAGE =
  'Gracias por invertir en el futuro de la ganadería.';

/** Se celebra cada vez que se cruza una meta, nunca hay "meta superada". */
export const TIER_UP_MESSAGE = '🎉 ¡META ALCANZADA!';

/* ═══════════════════════════════════════════════════════════════════════
   TEXTOS DE LA INTERFAZ
   ═══════════════════════════════════════════════════════════════════════ */
export const COPY = {
  brand: 'HATOMASTER',
  brandTag: 'Sistema integral de gestión ganadera',
  headline: 'ALIMENTA A BRISSA',
  quote: 'Cada inversión alimenta una idea.',
  amountTitle: '¿CUÁNTO QUIERES INVERTIR?',
  customLabel: 'O INGRESA TU CANTIDAD',
  continue: 'CONTINUAR',
  whereTitle: '¿DÓNDE QUIERES INVERTIR?',
  whereSubtitle: 'Opcional · puedes dejarlo en “Sin destino”',
  skipCategory: 'SIN DESTINO',
  confirmTitle: 'CONFIRMA TU INVERSIÓN',
  confirmBody: 'Tu inversión alimentará a Brissa.',
  cancel: 'CANCELAR',
  invest: 'INVERTIR',
  historyTitle: 'ÚLTIMAS INVERSIONES',
  breakdownTitle: '¿DÓNDE ESTÁ INVIRTIENDO LA COMUNIDAD?',
  noInvestments: 'Aún no hay inversiones. ¡Sé el primero!',
  soundOn: 'Activar sonido',
  soundOff: 'Silenciar sonido',
} as const;

/* ═══════════════════════════════════════════════════════════════════════
   ESTADO INICIAL — SIEMPRE 0 / 10,000 HM
   ═══════════════════════════════════════════════════════════════════════ */
export function emptyCategoryTotals(): CategoryTotals {
  return INVESTMENT_CATEGORIES.reduce((acc, id) => {
    acc[id] = 0;
    return acc;
  }, {} as CategoryTotals);
}

export function createInitialState(goal: number = GOAL): GameState {
  return {
    totalRaised: 0,
    goal,
    goalStep: GOAL_STEP,
    tiersReached: 0,
    lastInvestment: null,
    lastCategory: null,
    investmentHistory: [],
    categoryTotals: emptyCategoryTotals(),
  };
}
