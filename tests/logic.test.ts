/**
 * Pruebas de la lógica pura: parser de cantidades y normalización de las
 * filas que devuelve Supabase.
 *
 * No hay red ni `localStorage` aquí: `normalizeState` es una función pura que
 * traduce filas crudas a `GameState`, y es justamente la barrera que protege
 * la UI de una base de datos con datos raros. Eso es lo que se prueba aquí.
 */

import { parseAmount } from '../src/lib/investments';
import { normalizeState } from '../src/lib/repository';
import { EVENT_ID, GOAL, MAX_HISTORY } from '../src/lib/config';

let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} → ${JSON.stringify(got)}${ok ? '' : ` (esperado ${JSON.stringify(want)})`}`,
  );
};

console.log('── parseAmount: positivos aceptados ──');
for (const [inp, want] of [
  ['500', 500],
  ['1,000', 1000],
  ['1.000', 1000],
  ['$1 000', 1000],
  ["1'000", 1000],
  [' 750 ', 750],
  ['500 HM', 500],
  ['007', 7],
  ['12 500', 12500],
  ['1,000,000', 1000000],
] as const)
  eq(`"${inp}"`, parseAmount(inp), want);

console.log('\n── parseAmount: inválidos rechazados ──');
for (const inp of [
  '',
  '   ',
  '0',
  '00',
  '-5',
  '- 5',
  '−5',
  '5-',
  'abc',
  '1e3',
  '1E3',
  '12,5,6',
  '1.5',
  '12 34',
  '12a',
  'a12',
  'NaN',
  'Infinity',
  '.',
  ',',
  '1,00',
  '1.00,000',
])
  eq(`"${inp}"`, parseAmount(inp), null);

console.log('\n── los acumulados del servidor sobreviven al recorte del historial ──');
const many = Array.from({ length: MAX_HISTORY + 40 }, (_, i) => ({
  id: i + 1,
  amount: 100,
  category: i % 2 === 0 ? 'ganaderia' : 'ia',
  created_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
}));
// Una inversión de "datos" MUY antigua (id 0 → se ordena la primera y cae
// fuera de la ventana de 250). Sus 500 HM sólo sobreviven en el desglose
// porque el trigger del servidor los mantiene en `events.category_totals`.
many.unshift({
  id: 0,
  amount: 500,
  category: 'datos',
  created_at: new Date(2025, 0, 1).toISOString(),
});
const fullTotal = many.reduce((s, i) => s + i.amount, 0);

const state = normalizeState(
  {
    id: EVENT_ID,
    goal: 10000,
    total_raised: fullTotal,
    category_totals: { ganaderia: 14500, ia: 14500, datos: 500, offline: 0, rural: 0 },
    tiers_reached: 2,
  },
  many,
);
eq('historial recortado', state.investmentHistory.length, MAX_HISTORY);
eq('la fila antigua sale del historial', state.investmentHistory.some((i) => i.id === 0), false);
eq('totalRaised íntegro', state.totalRaised, fullTotal);
eq('totales por categoría', state.categoryTotals, {
  ganaderia: 14500,
  ia: 14500,
  datos: 500,
  offline: 0,
  rural: 0,
});
eq(
  'suma = total',
  Object.values(state.categoryTotals).reduce((a: number, b) => a + b, 0),
  fullTotal,
);
eq('última inversión = la más reciente', state.lastInvestment, 100);
eq('última categoría', state.lastCategory, 'ia');
eq('metas superadas', state.tiersReached, 2);
eq('meta vigente', state.goal, 10000);
eq('paso de meta', state.goalStep, 100_000);

console.log('\n── metas por etapas ──');
// La meta vigente la fija el servidor al subir; el cliente sólo la refleja.
eq('meta vigente', normalizeState({ goal: 200000, total_raised: 137500 }).goal, 200000);
eq('total íntegro', normalizeState({ goal: 200000, total_raised: 137500 }).totalRaised, 137500);
eq('tier 0 = ninguna superada', normalizeState({ total_raised: 99999, tiers_reached: 0 }).tiersReached, 0);
eq('tier 1', normalizeState({ total_raised: 100000, tiers_reached: 1 }).tiersReached, 1);
eq('tier 5', normalizeState({ total_raised: 500000, tiers_reached: 5 }).tiersReached, 5);
eq('tiers negativos → 0', normalizeState({ tiers_reached: -3 }).tiersReached, 0);
eq('tiers no numéricos → 0', normalizeState({ tiers_reached: 'x' as never }).tiersReached, 0);
eq('goal no numérico → por defecto', normalizeState({ goal: 'x' as never }).goal, 100_000);
eq('goal_step por defecto', normalizeState({}).goalStep, 100_000);
eq('goal_step inválido → por defecto', normalizeState({ goal_step: 0 }).goalStep, 100_000);
eq('goal_step válido', normalizeState({ goal_step: 50000 }).goalStep, 50000);
eq('excedente sigue en el total', normalizeState({ goal: 100000, total_raised: 103000 }).totalRaised, 103000);


console.log('\n── datos ausentes o manipulados se reparan ──');
const now = new Date().toISOString();
eq(
  'jsonb ausente → se reconstruye',
  normalizeState({ total_raised: 300 }, [{ id: 1, amount: 300, category: 'ia', created_at: now }])
    .categoryTotals.ia,
  300,
);
eq('jsonb corrupto → 0', normalizeState({ total_raised: 0, category_totals: 5 as never }).categoryTotals, {
  ganaderia: 0,
  ia: 0,
  datos: 0,
  offline: 0,
  rural: 0,
});
eq('categoría desconocida se ignora', normalizeState({
  total_raised: 0,
  category_totals: { inventada: 900 } as never,
}).categoryTotals, { ganaderia: 0, ia: 0, datos: 0, offline: 0, rural: 0 });
eq('total inflado', normalizeState({ total_raised: 5000 }).totalRaised, 5000);
eq(
  'total negativo',
  normalizeState({ total_raised: -250 }).totalRaised,
  0,
);
eq('total no numérico', normalizeState({ total_raised: 'x' as never }).totalRaised, 0);
eq('meta no numérica → GOAL', normalizeState({ goal: 'x' as never }).goal, GOAL);
eq('meta cero → GOAL', normalizeState({ goal: 0 }).goal, GOAL);
eq('fila vacía', normalizeState(null).totalRaised, 0);
eq('sin argumentos', normalizeState(undefined).goal, GOAL);

console.log('\n── filas de historial corruptas se descartan ──');
const dirty = normalizeState(
  { total_raised: 1000 },
  [
    { id: 1, amount: 100, category: 'ia', created_at: now },
    { id: 0, amount: -50, category: 'ia', created_at: now },
    { id: 3, amount: 0, category: 'ia', created_at: now },
    { id: 4, amount: Number.NaN, category: 'ia', created_at: now },
    { id: 5, amount: 300, category: 'no-existe' as never, created_at: now },
    { amount: 900, category: 'rural', created_at: now },
  ] as never,
);
eq('sólo 2 filas válidas', dirty.investmentHistory.length, 2);
eq(
  'categoría inválida → null',
  dirty.investmentHistory.find((i) => i.id === 5)?.category,
  null,
);
eq('última inversión válida', dirty.lastInvestment, 300);
eq('ordenados de más antiguo a más nuevo', dirty.investmentHistory.map((i) => i.id), [1, 5]);
eq(
  'sin categoría → no suma a ninguna',
  dirty.categoryTotals.rural,
  0,
);

console.log('\n── la base de datos es la autoridad (nunca se recalcula el total) ──');
// Dos pantallas invierten a la vez: cada RPC devuelve el total que el trigger
// calculó en el servidor, así que ningún cliente puede "inventar" un total.
const a = normalizeState({ goal: 10000, total_raised: 500 });
const b = normalizeState({ goal: 10000, total_raised: 1000 });
eq('pantalla A ve 500', a.totalRaised, 500);
eq('pantalla B ve 1000 (post-realtime)', b.totalRaised, 1000);
eq('ninguno se infla', a.totalRaised + 500, 1000);

console.log(`\n${fails === 0 ? 'TODO OK' : fails + ' FALLOS'}  (EVENT_ID=${EVENT_ID})`);
if (fails > 0) throw new Error(fails + ' pruebas fallaron');
