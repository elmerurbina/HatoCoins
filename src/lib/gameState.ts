import { GOAL, MILESTONES, createInitialState } from './config';
import {
  RepositoryError,
  addInvestment as persistInvestment,
  loadGameState,
  subscribeToEvent,
  undoLastInvestment as persistUndo,
  type WriteResult,
} from './repository';
import { isSupabaseConfigured, supabaseConfigError } from './supabase';
import type { DbStatus, GameState, GameView, InvestmentCategory, Milestone } from './types';

/**
 * Store observable mínimo (sin dependencias externas).
 *
 * A diferencia de la versión con `localStorage`, TODAS las mutaciones son
 * `async` y devuelven el estado que el servidor acaba de confirmar. No hay
 * estado optimista a propósito: si la escritura falla, la pantalla no puede
 * mostrar un total que no existe en la base de datos.
 *
 * Los componentes se suscriben con `subscribe()` y reciben un `GameView` ya
 * derivado: no necesitan saber nada de Supabase ni de cálculos.
 */

type Listener = (view: GameView) => void;

const listeners = new Set<Listener>();

let state: GameState = createInitialState();
let hydrated = false;

/* Estado de la conexión: la UI bloquea el panel hasta que la BD responde. */
let dbStatus: DbStatus = 'loading';
let dbError: string | null = null;

/* Flags de interfaz: no se guardan, sólo afectan a la vista derivada. */
let uiAnimating = false;
let uiIdleMs = 0;

/* ═══════════════════════════════════════════════════════════════════════
   DERIVACIONES PURAS
   ═══════════════════════════════════════════════════════════════════════ */

export function percentOf(total: number, goal: number): number {
  if (!Number.isFinite(goal) || goal <= 0) return 0;
  return (total / goal) * 100;
}

export function milestoneFor(percent: number): Milestone {
  const found = MILESTONES.find((m) => percent >= m.from && percent < m.to);
  return found ?? MILESTONES[MILESTONES.length - 1]!;
}

export function brissaStateFor(view: {
  percent: number;
  goalReached: boolean;
  animating: boolean;
  idleFor: number;
}): GameView['brissa'] {
  if (view.animating) return 'receiving';
  if (view.goalReached) return 'completed';
  if (view.percent >= 80) return 'almost_full';
  if (view.idleFor) return 'waiting';
  return 'idle';
}

function buildView(animating: boolean, idleFor: number): GameView {
  const goal = state.goal > 0 ? state.goal : GOAL;
  const step = state.goalStep > 0 ? state.goalStep : goal;
  const percent = percentOf(state.totalRaised, goal);
  const milestone = milestoneFor(percent);
  // "Hay meta superada" = se cruzó al menos una. Ya no cabe comprobar
  // total >= meta, porque al cruzar, la meta ya ha subido y la comparación
  // vuelve a ser falsa: por eso el servidor lleva la cuenta en tiers_reached.
  const goalReached = state.tiersReached > 0;
  const level = Math.max(0, Math.min(1, percent / 100));

  return {
    total: state.totalRaised,
    goal,
    percent,
    level,
    remaining: Math.max(0, goal - state.totalRaised),
    nextGoal: goal + step,
    goalStep: step,
    milestone,
    message: milestone.message,
    brissa: brissaStateFor({ percent, goalReached, animating, idleFor }),
    tiersReached: state.tiersReached,
    goalReached,
    db: dbStatus,
    dbError,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   API DEL STORE
   ═══════════════════════════════════════════════════════════════════════ */

export function getState(): GameState {
  return state;
}

export function getView(): GameView {
  return buildView(uiAnimating, uiIdleMs);
}

export function isReady(): boolean {
  return dbStatus === 'ready';
}

function setDbStatus(status: DbStatus, error: string | null = null): void {
  if (dbStatus === status && dbError === error) return;
  dbStatus = status;
  dbError = error;
  emit();
}

/**
 * Primera carga: lee el evento desde Supabase. Si faltan credenciales, no
 * lanza: deja la app en estado `error` para que la UI muestre el aviso de
 * configuración en lugar de quedarse en blanco.
 */
export async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  const configError = supabaseConfigError();
  if (configError) {
    state = createInitialState();
    setDbStatus('error', configError);
    return;
  }

  setDbStatus('loading');
  try {
    state = await loadGameState();
    setDbStatus('ready');
  } catch (error) {
    state = createInitialState();
    setDbStatus('error', messageOf(error));
  }
}

/** Reintenta la carga tras un error (botón "Reintentar"). */
export async function retryHydrate(): Promise<void> {
  hydrated = false;
  await hydrate();
}

let disconnect: (() => void) | null = null;

/**
 * Escucha los cambios que hacen otras pantallas. Devuelve la función de
 * cierre, o `null` si Supabase no está operativo.
 */
export function connectRealtime(): (() => void) | null {
  if (disconnect) return disconnect;
  if (!isSupabaseConfigured()) return null;

  try {
    disconnect = subscribeToEvent(
      (next) => {
        // Realtime es la autoridad: aunque esta pantalla no haya invertido,
        // adopta el total que confirma el servidor.
        state = next;
        emit();
      },
      (status) => {
        if (status === 'error') setDbStatus('error', 'Se perdió la conexión con Supabase.');
        else if (dbStatus === 'error') setDbStatus('ready');
      },
    );
  } catch (error) {
    setDbStatus('error', messageOf(error));
    return null;
  }

  return () => {
    disconnect?.();
    disconnect = null;
  };
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  // Entrega inmediata del estado actual (evita flashes de UI vacía).
  listener(getView());
  return () => {
    listeners.delete(listener);
  };
}

export function emit(): void {
  const view = getView();
  for (const listener of listeners) listener(view);
}

/* ═══════════════════════════════════════════════════════════════════════
   FLAGS DE INTERFAZ (no se guardan)
   ═══════════════════════════════════════════════════════════════════════ */

export function setAnimating(value: boolean): void {
  if (uiAnimating === value) return;
  uiAnimating = value;
  emit();
}

export function setIdle(ms: number): void {
  if (uiIdleMs === ms) return;
  uiIdleMs = ms;
  emit();
}

/* ═══════════════════════════════════════════════════════════════════════
   MUTACIONES (todas contra Supabase; propagan el error si falla)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Registra una inversión y devuelve si se cruzó una meta, para que la
 * celebración la disponga la escritura que realmente la causó y no un render
 * posterior (que ya no podría distinguirla de un cambio ajeno por Realtime).
 */
export async function invest(
  amount: number,
  category: InvestmentCategory | null,
): Promise<WriteResult> {
  const result = await persistInvestment(amount, category);
  state = result.state;
  emit();
  return result;
}

/** Deshace la última inversión (corrige un error de tecleo). */
export async function undoLastInvestment(): Promise<WriteResult> {
  const result = await persistUndo();
  state = result.state;
  emit();
  return result;
}

/** Traduce cualquier excepción a un mensaje presentable. */
function messageOf(error: unknown): string {
  if (error instanceof RepositoryError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Error desconocido';
}
