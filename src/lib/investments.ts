import { HISTORY_VISIBLE } from './config';
import type { CategoryTotals, Investment, InvestmentCategory } from './types';

/* ═══════════════════════════════════════════════════════════════════════
   FORMATO
   ═══════════════════════════════════════════════════════════════════════ */

const nf = new Intl.NumberFormat('en-US');
const nfCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** 10000 → "10,000" (coma de millar, como en el stand). */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return nf.format(Math.round(value));
}

/** 1234 → "1.2K" (para etiquetas pequeñas del HUD). */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) < 1000) return nfCompact.format(value);
  return nfCompact.format(value);
}

/** 47.83 → "48%" */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value)}%`;
}

/** ISO → "14:32" */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/* ═══════════════════════════════════════════════════════════════════════
   SANEO DE CANTIDADES ESCRITAS POR EL USUARIO
   Acepta enteros positivos: "500", "1,000", "1.000", "$1 000", "1'000", " 750 ", "500 HM".
   Rechaza "", "0", "-5", "abc", "1e3", "12,5,6", "1.5", "12 34", "12a".
   ═══════════════════════════════════════════════════════════════════════ */

/** Símbolo de moneda admitido como adorno (se descarta antes de validar). */
const CURRENCY_PREFIX = /^[$€£¥₡]+/;
/** Sufijo de la moneda del evento: "500 HM", "500hm". */
const CURRENCY_SUFFIX = /\s*(?:hm|HatoCoins|HC)$/i;

export function parseAmount(input: string): number | null {
  if (typeof input !== 'string') return null;

  const raw = input.trim();
  if (!raw) return null;

  // Signo negativo o guion: nunca se "limpia", se rechaza.
  if (/[-−–—]/.test(raw)) return null;
  // Notación científica: fuera de alcance para importes de stand.
  if (/[eE]/.test(raw)) return null;

  // Se retira el adorno de moneda antes de validar los dígitos.
  const bare = raw.replace(CURRENCY_PREFIX, '').replace(CURRENCY_SUFFIX, '').trim();
  if (!bare) return null;

  // Entero simple, o millares con grupos de EXACTAMENTE 3 dígitos.
  // "1,000" y "1 000" son válidos; "1.5", "12 34" y "12,5,6" no.
  const isInteger = /^\d+$/.test(bare);
  const isGrouped = /^\d{1,3}(?:[.,]\d{3})+$/.test(bare);
  const isSpaced = /^\d{1,3}(?:[  '’ ]\d{3})+$/.test(bare);
  if (!isInteger && !isGrouped && !isSpaced) return null;

  const digits = bare.replace(/[.,  '’ ]/g, '').replace(/^0+(?=\d)/, '');
  const n = Number(digits);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return n;
}

/** Última inversión válida o `null` (para deshabilitar "Continuar"). */
export function isValidAmount(n: number | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && Number.isInteger(n);
}

/* ═══════════════════════════════════════════════════════════════════════
   HISTORIAL
   ═══════════════════════════════════════════════════════════════════════ */

export interface HistoryEntryView {
  amount: number;
  amountLabel: string;
  category: InvestmentCategory | null;
  timeLabel: string;
  key: string;
}

/** Últimas inversiones, de la más reciente a la más antigua. */
export function recentHistory(history: readonly Investment[], limit = HISTORY_VISIBLE): HistoryEntryView[] {
  return history
    .slice(-limit)
    .reverse()
    .map((item) => ({
      amount: item.amount,
      amountLabel: `+${formatAmount(item.amount)} HM`,
      category: item.category,
      timeLabel: formatTime(item.timestamp),
      key: `${item.id}-${item.timestamp}`,
    }));
}

export interface BreakdownRow {
  category: InvestmentCategory;
  amount: number;
  label: string;
  shortLabel: string;
  emoji: string;
  percent: number;
  width: number;
}

/** Filas del "¿dónde está invirtiendo la comunidad?", ordenadas por importe. */
export function breakdownRows(
  totals: CategoryTotals,
  categories: readonly { id: InvestmentCategory; label: string; shortLabel: string; emoji: string }[],
  total: number,
): BreakdownRow[] {
  const max = Math.max(1, ...categories.map((c) => totals[c.id] ?? 0));
  return categories
    .map((c) => {
      const amount = totals[c.id] ?? 0;
      return {
        category: c.id,
        amount,
        label: c.label,
        shortLabel: c.shortLabel,
        emoji: c.emoji,
        percent: total > 0 ? (amount / total) * 100 : 0,
        // Ancho de barra relativo al mayor, no al total: se lee mejor como HUD.
        width: (amount / max) * 100,
      };
    })
    .sort((a, b) => b.amount - a.amount);
}
