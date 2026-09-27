/**
 * Tipos del juego HatoCoins.
 * TypeScript estricto: sin `any` salvo casos absolutamente inevitables
 * (y documentados en el punto exacto donde aparecen).
 */

/** Categorías de destino de la inversión. */
export type InvestmentCategory = 'ganaderia' | 'ia' | 'datos' | 'offline' | 'rural';

export const INVESTMENT_CATEGORIES: readonly InvestmentCategory[] = [
  'ganaderia',
  'ia',
  'datos',
  'offline',
  'rural',
] as const;

/** Estados emocional/animado de Brissa. */
export type BrissaState = 'idle' | 'waiting' | 'receiving' | 'happy' | 'almost_full' | 'completed';

/** Registro de una inversión anónima guardada en el historial. */
export interface Investment {
  amount: number;
  category: InvestmentCategory | null;
  timestamp: string;
  /** Identificador incremental, evita colisiones al deserializar. */
  id: number;
}

export type CategoryTotals = Record<InvestmentCategory, number>;

export interface GameState {
  totalRaised: number;
  /** Meta VIGENTE. Sube sola en saltos de `goalStep` al alcanzarse. */
  goal: number;
  /** En cuánto sube la meta al cruzarse. */
  goalStep: number;
  /** Cuántas metas se han superado. 0 = todavía ninguna. */
  tiersReached: number;
  lastInvestment: number | null;
  lastCategory: InvestmentCategory | null;
  investmentHistory: Investment[];
  categoryTotals: CategoryTotals;
}

/** Definición de una categoría, usada por la UI y los textos. */
export interface CategoryMeta {
  id: InvestmentCategory;
  emoji: string;
  label: string;
  shortLabel: string;
  /** Clase de color de acento (Tailwind, texto + fondo). */
  accent: string;
  glow: string;
  blurb: string;
}

/** Etapas de progreso narradas por el juego. */
export interface Milestone {
  from: number; // porcentaje inclusivo
  to: number; // porcentaje exclusivo
  message: string;
  tone: 'calm' | 'warm' | 'good' | 'great' | 'fire' | 'goal';
}

export type GamePhase = 'idle' | 'selecting' | 'confirming' | 'animating' | 'blocked';

/**
 * Estado de la conexión con la base de datos.
 * `loading` mantiene el panel bloqueado hasta la primera lectura.
 */
export type DbStatus = 'loading' | 'ready' | 'error';

/** Vista plana que consume la capa de presentación. */
export interface GameView {
  total: number;
  goal: number;
  percent: number;
  level: number; // 0 → 1, saturado en 1
  remaining: number;
  /** La meta siguiente, ya sumada: goal + goalStep. */
  nextGoal: number;
  /** En cuánto sube la meta. Permite recuperar la meta anterior para el texto. */
  goalStep: number;
  milestone: Milestone;
  message: string;
  brissa: BrissaState;
  /** Metas superadas hasta ahora. */
  tiersReached: number;
  /** Hay al menos una meta superada. */
  goalReached: boolean;
  /** `error` bloquea el panel de inversión y muestra el aviso de configuración. */
  db: DbStatus;
  dbError: string | null;
}
