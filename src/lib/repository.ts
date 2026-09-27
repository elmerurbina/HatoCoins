/**
 * Capa de acceso a datos (Supabase). Sustituye a la antigua capa de
 * `localStorage`: aquí ya no hay ningún `localStorage` de estado de juego.
 *
 * Reglas de la capa:
 *  · Ningún componente habla con Supabase directamente; todos pasan por aquí.
 *  · Los acumulados NUNCA se calculan en el cliente para Write: los mantiene
 *    el trigger `investments_apply_totals`. Así dos pantallas que invierten a
 *    la vez no pueden pisarse (el riesgo clásico de "leer-modificar-escribir").
 *  · Todas las funciones son `async` y devuelven el `GameState` YA LEÍDO de la
 *    base de datos, nunca una estimación local: la animación usa la cifra
 *    autoritativa.
 *  · El error de red se propaga tipado (`RepositoryError`) para que la UI
 *    pueda distinguir "no hay conexión" de "el usuario escribió una burrada".
 */

import { EVENT_ID, GOAL, GOAL_STEP, HISTORY_VISIBLE, MAX_HISTORY, emptyCategoryTotals } from './config';
import { getSupabase } from './supabase';
import type { CategoryTotals, GameState, Investment, InvestmentCategory } from './types';
import { INVESTMENT_CATEGORIES } from './types';

/* ═══════════════════════════════════════════════════════════════════════
   ERRORES
   ═══════════════════════════════════════════════════════════════════════ */

export type RepositoryErrorKind = 'network' | 'config' | 'server';

export class RepositoryError extends Error {
  readonly kind: RepositoryErrorKind;

  constructor(kind: RepositoryErrorKind, message: string) {
    super(message);
    this.name = 'RepositoryError';
    this.kind = kind;
  }
}

/** Traduce el `PostgrestError` de supabase-js a un error de la app. */
function fail(context: string, error: { message: string; code?: string } | null): never {
  const message = error?.message ?? 'Error desconocido';
  // 42501 = permisos RLS, PGRST116 = fila inexistente, 23503 = clave foránea.
  const kind: RepositoryErrorKind =
    error?.code === '42501' || error?.code === 'PGRST116' || error?.code === '23503'
      ? 'server'
      : 'network';
  throw new RepositoryError(kind, `${context}: ${message}`);
}

/* ═══════════════════════════════════════════════════════════════════════
   FORMA DE LAS FILAS
   ═══════════════════════════════════════════════════════════════════════ */

/** Fila de `public.events` (los acumulados los mantiene el trigger). */
export interface EventRow {
  id: string;
  goal: number;
  goal_step: number;
  tiers_reached: number;
  total_raised: number;
  category_totals: Record<string, number> | null;
}

/**
 * Lo que devuelven los RPC: la fila del evento y si esta escritura cruzó una
 * meta. Es un sobre y no la fila pelada porque "se superó la meta" no cabe en
 * una columna de `events` (al cruzar, la meta ya ha subido y la comparación
 * se ha perdido).
 */
export interface WriteResult {
  state: GameState;
  tierUpgraded: boolean;
}

/** Fila de `public.investments` (registro append-only). */
export interface InvestmentRow {
  id: number;
  amount: number;
  category: string | null;
  created_at: string;
}

const isCategory = (value: unknown): value is InvestmentCategory =>
  typeof value === 'string' && (INVESTMENT_CATEGORIES as readonly string[]).includes(value);

/**
 * Lee el sobre que devuelven los RPC: `{ event, tier_upgraded }`.
 *
 * Tolera que PostgREST entregue un objeto o un array de un elemento (según la
 * versión) y que las claves lleguen en camelCase o en snake_case. Adivinar mal
 * aquí dejaría todos los totales a 0 en silencio, que es el peor fallo posible.
 */
function readEnvelope(data: unknown): { event: EventRow; tierUpgraded: boolean } {
  const unwrapped = (Array.isArray(data) ? data[0] : data) as
    | {
        event?: EventRow;
        tier_upgraded?: boolean;
        tierUpgraded?: boolean;
      }
    | null
    | undefined;

  const event = unwrapped?.event;
  if (!event || typeof event !== 'object') {
    throw new RepositoryError('server', 'El servidor no devolvió el evento.');
  }

  return {
    event,
    tierUpgraded: unwrapped!.tier_upgraded === true || unwrapped!.tierUpgraded === true,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   NORMALIZACIÓN (puro, sin red — por eso tiene test propio)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Convierte filas crudas de Supabase en un `GameState` íntegro.
 *
 * Es la barrera de confianza: la base de datos puede devolver `null` en
 * columnas `jsonb`, un `category` desconocido si alguien editó el `check`
 * desde el panel de Supabase, o amounts fuera de rango. Aquí se sanea todo
 * para que la presentación nunca reciba basura.
 */
export function normalizeState(
  event: Partial<EventRow> | null | undefined,
  history: readonly Partial<InvestmentRow>[] = [],
): GameState {
  const goal =
    typeof event?.goal === 'number' && Number.isFinite(event.goal) && event.goal > 0
      ? Math.floor(event.goal)
      : GOAL;

  const rawStep = Number(event?.goal_step);
  const goalStep = Number.isFinite(rawStep) && rawStep > 0 ? Math.floor(rawStep) : GOAL_STEP;

  const rawTiers = Number(event?.tiers_reached);
  const tiersReached = Number.isFinite(rawTiers) && rawTiers > 0 ? Math.floor(rawTiers) : 0;

  const rawTotal = Number(event?.total_raised ?? 0);
  const totalRaised =
    Number.isFinite(rawTotal) && rawTotal > 0 ? Math.floor(rawTotal) : 0;

  // ── Historial: sólo filas utilizables, ordenadas de más antigua a más nueva
  const investmentHistory: Investment[] = history
    .filter((row): row is Partial<InvestmentRow> & { amount: number } => {
      const amount = Number(row?.amount);
      return typeof row?.id === 'number' && Number.isFinite(amount) && amount > 0;
    })
    .map((row) => ({
      id: Math.floor(row.id as number),
      amount: Math.floor(Number(row.amount)),
      category: isCategory(row.category) ? row.category : null,
      timestamp: typeof row.created_at === 'string' ? row.created_at : new Date(0).toISOString(),
    }))
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_HISTORY);

  // ── Acumulados por categoría
  const categoryTotals: CategoryTotals = emptyCategoryTotals();
  const stored = event?.category_totals;
  if (stored && typeof stored === 'object') {
    for (const [key, value] of Object.entries(stored)) {
      if (!isCategory(key)) continue;
      const amount = Number(value);
      if (Number.isFinite(amount) && amount > 0) categoryTotals[key] = Math.floor(amount);
    }
  }

  // Fallback: si el jsonb vino vacío pero hay historial legible, se reconstruye
  // (la fila de `events` pudo quedar sin sincronizar; el historial no miente).
  const storedSum = Object.values(categoryTotals).reduce((a, b) => a + b, 0);
  if (storedSum === 0 && investmentHistory.length > 0) {
    for (const item of investmentHistory) {
      if (item.category) categoryTotals[item.category] += item.amount;
    }
  }

  const last = investmentHistory.at(-1) ?? null;

  return {
    totalRaised,
    goal,
    goalStep,
    tiersReached,
    lastInvestment: last?.amount ?? null,
    lastCategory: last?.category ?? null,
    investmentHistory,
    categoryTotals,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   LECTURAS
   ═══════════════════════════════════════════════════════════════════════ */

/** El historial reciente, del más nuevo al más viejo. */
async function fetchHistory(): Promise<InvestmentRow[]> {
  const { data, error } = await getSupabase()
    .from('investments')
    .select('id, amount, category, created_at')
    .eq('event_id', EVENT_ID)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(HISTORY_VISIBLE);
  if (error) fail('No se pudo leer el historial', error);
  return (data ?? []) as InvestmentRow[];
}

/**
 * Carga el estado del evento. Crea la fila si el evento aún no existe
 * (primer arranque del stand), de forma idempotente.
 */
export async function loadGameState(): Promise<GameState> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('events')
    .select('id, goal, goal_step, tiers_reached, total_raised, category_totals')
    .eq('id', EVENT_ID)
    .maybeSingle();
  if (error) fail('No se pudo leer el evento', error);

  const row = (Array.isArray(data) ? data[0] : data) as EventRow | null;
  if (row && typeof row === 'object') return normalizeState(row, await fetchHistory());

  // Evento inexistente → lo creamos. Si otra pantalla ganó la carrera, el
  // `upsert` no pisa nada porque la fila ya existiría (ignoreDuplicates).
  const { error: insertError } = await supabase
    .from('events')
    .upsert(
      { id: EVENT_ID, goal: GOAL, goal_step: GOAL_STEP },
      { onConflict: 'id', ignoreDuplicates: true },
    );
  if (insertError) fail('No se pudo crear el evento', insertError);

  return normalizeState(
    { id: EVENT_ID, goal: GOAL, goal_step: GOAL_STEP, total_raised: 0 },
    [],
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ESCRITURAS (todas devuelven el estado autoritativo leído del servidor)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Registra una inversión. El RPC inserta en `investments` y devuelve la fila
 * de `events` ya actualizada por el trigger: un solo viaje de ida y vuelta.
 */
export async function addInvestment(
  amount: number,
  category: InvestmentCategory | null,
): Promise<WriteResult> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RepositoryError('server', 'El monto debe ser un entero positivo.');
  }

  const { data, error } = await getSupabase().rpc('add_investment', {
    p_event_id: EVENT_ID,
    p_amount: amount,
    p_category: category,
  });
  if (error) fail('No se pudo registrar la inversión', error);

  const row = readEnvelope(data);
  return {
    state: normalizeState(row.event, await fetchHistory()),
    tierUpgraded: row.tierUpgraded,
  };
}

/** Deshace la última inversión (modo organización). */
export async function undoLastInvestment(): Promise<WriteResult> {
  const { data, error } = await getSupabase().rpc('undo_last_investment', {
    p_event_id: EVENT_ID,
  });
  if (error) fail('No se pudo deshacer la inversión', error);

  const row = readEnvelope(data);
  return {
    state: normalizeState(row.event, await fetchHistory()),
    tierUpgraded: row.tierUpgraded,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   REALTIME
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Escucha los cambios del evento en el resto de pantallas del stand.
 *
 * Se suscribe a DOS canales:
 *  · `events`      → una sola fila: trae los acumulados. Es lo que dispara el
 *                    repintado del total, la barra y el desglose.
 *  · `investments` → cada fila nueva: trae el "última inversión" y el
 *                    historial sin tener que consultarlos.
 *
 * Con los dos, una segunda pantalla refleja una inversión en el instante en
 * que se confirma, sin hacer polling.
 */
export function subscribeToEvent(
  onChange: (state: GameState) => void,
  onStatus?: (status: 'live' | 'error') => void,
): () => void {
  const supabase = getSupabase();

  const channel = supabase
    .channel(`event:${EVENT_ID}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'events', filter: `id=eq.${EVENT_ID}` },
      () => {
        // La fila de `events` ya trae los acumulados: no hace falta releer.
        void refreshFromEventRow(onChange);
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'investments', filter: `event_id=eq.${EVENT_ID}` },
      () => {
        void refreshFromEventRow(onChange);
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') onStatus?.('live');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        onStatus?.('error');
      }
    });

  return () => {
    void supabase.removeChannel(channel);
  };
}

/** Relee la fila del evento + historial y lo entrega normalizado. */
async function refreshFromEventRow(onChange: (state: GameState) => void): Promise<void> {
  try {
    onChange(await loadGameState());
  } catch {
    // Un fallo puntual de realtime no debe romper la pantalla: la próxima
    // inversión traerá el estado fresco de todas formas.
  }
}
