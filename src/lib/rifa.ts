/* ═══════════════════════════════════════════════════════════════════
    RIFA · PRICE DISCOVERY — NÚCLEO PURO (sin DOM)
    Este módulo se importa desde el HTML en build, así que no puede
    tocar `document`, `window` ni `performance` en el ámbito superior.
    ═══════════════════════════════════════════════════════════════════ */

export type PrizeTier = 'sticker' | 'pamphlet' | 'certificate' | 'llavero';

export interface Prize {
  id: string;
  tier: PrizeTier;
  /** Número de diseño dentro del nivel (1..N). */
  design: number;
  name: string;
  image: string;
  /** Inversión mínima EXCLUSIVA para poder ganar este nivel. */
  minInvestment: number;
  /** Unidades totales del diseño. */
  stock: number;
  /** Unidades que quedan disponibles. */
  remaining: number;
}

export interface PrizeHistoryEntry {
  amount: number;
  prize: Prize;
  timestamp: string;
}

export type GamePhase = 'idle' | 'ready' | 'spinning' | 'revealed';

/** Estado de Brissa: `idle` → `waiting` → `receiving` → `happy`. */
export type BrissaState = 'idle' | 'waiting' | 'receiving' | 'happy' | 'almost_full' | 'completed';

export interface RifaView {
  phase: GamePhase;
  brissaState: BrissaState;
  totalInvested: number;
  investmentCount: number;
  isSpinning: boolean;
  showPrize: boolean;
  prize: Prize | null;
  bestPrize: Prize | null;
  investmentAmount: number;
  tierUnlocks: Record<PrizeTier, boolean>;
  stockLeft: number;
}

/* ── Configuración del catálogo ─────────────────────────────────────── */

const TIER_META: Record<
  PrizeTier,
  { label: string; emoji: string; color: string; minInvestment: number; weight: number }
> = {
  sticker: { label: 'Sticker', emoji: '📌', color: '#7fca8d', minInvestment: 0, weight: 12 },
  pamphlet: { label: 'Folleto', emoji: '📄', color: '#55a6c6', minInvestment: 0, weight: 6 },
  certificate: { label: 'Certificado', emoji: '🎖️', color: '#eabf4e', minInvestment: 10000, weight: 3 },
  llavero: { label: 'Llavero Premium', emoji: '🔑', color: '#c9b2f0', minInvestment: 25000, weight: 2.5 },
};

const TIER_ORDER: PrizeTier[] = ['sticker', 'pamphlet', 'certificate', 'llavero'];

/**
 * Catálogo: 5 diseños de sticker × 20 unidades, 12 folletos,
 * 10 llaveros premium y 20 certificados.
 */
/**
 * Los cinco diseños de sticker usan el arte real de src/assets/stickers.
 * El orden debe coincidir con el que se ve en la app.
 */
const STICKERS = [
  { name: 'Sticker Arete', image: '/prices/stickers/sticker1.png' },
  { name: 'Sticker Brissa', image: '/prices/stickers/sticker2.png' },
  { name: 'Sticker Logo', image: '/prices/stickers/sticker3.jpg' },
  { name: 'Sticker Milk', image: '/prices/stickers/sticker4.jpg' },
  { name: 'Sticker Ranch', image: '/prices/stickers/sticker5.png' },
] as const;

function buildCatalog(): Prize[] {
  const items: Prize[] = [];

  for (const [index, sticker] of STICKERS.entries()) {
    const design = index + 1;
    items.push({
      id: `sticker-${design}`,
      tier: 'sticker',
      design,
      name: sticker.name,
      image: sticker.image,
      minInvestment: 0,
      stock: 20,
      remaining: 20,
    });
  }

  items.push({
    id: 'pamphlet-1',
    tier: 'pamphlet',
    design: 1,
    name: 'Folleto HatoMaster',
    image: '/prices/pamphlets/brochure.png',
    minInvestment: 0,
    stock: 12,
    remaining: 12,
  });

  items.push({
    id: 'certificate-1',
    tier: 'certificate',
    design: 1,
    name: 'Certificado de foundationalist',
    image: '/prices/certificates/certificate1.svg',
    minInvestment: 10000,
    stock: 20,
    remaining: 20,
  });

  items.push({
    id: 'llavero-1',
    tier: 'llavero',
    design: 1,
    name: 'Llavero Premium',
    image: '/prices/llaveros/llavero.png',
    minInvestment: 25000,
    stock: 10,
    remaining: 10,
  });

  return items;
}

/* ── Utilidades ─────────────────────────────────────────────────────── */

export function getTierMeta(tier: PrizeTier) {
  return TIER_META[tier];
}

export function getTierLabel(tier: PrizeTier): string {
  return TIER_META[tier]?.label ?? tier;
}

export function getTierEmoji(tier: PrizeTier): string {
  return TIER_META[tier]?.emoji ?? '🎁';
}

export function getTierColor(tier: PrizeTier): string {
  return TIER_META[tier]?.color ?? '#dde8e0';
}

/** Peso relativo por unidad, para ordenar "mejor premio". */
export function getTierRank(tier: PrizeTier): number {
  return TIER_META[tier]?.weight ?? 0;
}

/**
 * Acepta enteros positivos en formato deThousands de varias regiones.
 * `,` y espacios se ignoran siempre. El punto sólo cuenta como separador
 * si el número entero es una cadena de grupos de 3 dígitos
 * ("1.500" -> 1500, "1.500.000" -> 1500000). Un decimal real ("1.5")
 * se rechaza, igual que negativos, exponenciales o texto.
 */
export function parseInvestment(raw: string): number | null {
  if (typeof raw !== 'string') return null;

  const cleaned = raw.replace(/[$€£¥₡\s,]/g, '');
  if (!/^\d+$|^\d{1,3}(\.\d{3})+$/.test(cleaned)) return null;

  const n = Number(cleaned.replace(/\./g, ''));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function isValidInvestment(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0;
}

export function formatAmount(value: number): string {
  return new Intl.NumberFormat('es-MX').format(Math.round(value));
}

/** Niveles desbloqueados. El umbral es ESTRICTAMENTE mayor. */
export function getUnlockedTiers(investment: number): PrizeTier[] {
  return TIER_ORDER.filter((tier) => {
    const min = TIER_META[tier].minInvestment;
    return min === 0 ? investment > 0 : investment > min;
  });
}

/**
 * Probabilidad: cada unidad pesa `pesoBase × unidadesRestantes × rampa`.
 * La rampa sube de 0.18 → 1 entre el umbral y 3× el umbral, así que
 * "cuanto mayor la inversión, mejor la probabilidad" de verdad.
 */
function rampFor(investment: number, min: number): number {
  if (min <= 0) return 1;
  const t = (investment - min) / (min * 3);
  return 0.18 + 0.82 * Math.min(1, Math.max(0, t));
}

export function computeOdds(catalog: Prize[], investment: number) {
  const rows: Array<{ prize: Prize; weight: number; chance: number }> = [];
  let total = 0;

  for (const prize of catalog) {
    if (prize.remaining <= 0) continue;
    if (prize.minInvestment > 0 && investment <= prize.minInvestment) continue;
    const w = TIER_META[prize.tier].weight * prize.remaining * rampFor(investment, prize.minInvestment);
    rows.push({ prize, weight: w, chance: 0 });
    total += w;
  }

  if (total > 0) for (const row of rows) row.chance = row.weight / total;
  return rows;
}

export function pickPrize(catalog: Prize[], investment: number): Prize | null {
  const rows = computeOdds(catalog, investment);
  const last = rows[rows.length - 1];
  if (!last) return null;

  let r = Math.random();
  for (const row of rows) {
    r -= row.chance;
    if (r <= 0) {
      row.prize.remaining = Math.max(0, row.prize.remaining - 1);
      return row.prize;
    }
  }

  last.prize.remaining = Math.max(0, last.prize.remaining - 1);
  return last.prize;
}

/* ── Motor del juego ────────────────────────────────────────────────── */

export class RifaGame {
  private catalog: Prize[];
  private history: PrizeHistoryEntry[] = [];
  private listeners = new Set<(view: RifaView) => void>();

  private phase: GamePhase = 'idle';
  private totalInvested = 0;
  private investmentCount = 0;
  private currentInvestment = 0;
  private currentPrize: Prize | null = null;
  private bestPrize: Prize | null = null;
  private showPrize = false;
  private spinning = false;

  constructor() {
    this.catalog = buildCatalog();
  }

  /* Lectura */
  getPhase(): GamePhase {
    return this.phase;
  }
  getCatalog(): Prize[] {
    return this.catalog.map((p) => ({ ...p }));
  }
  getCurrentInvestment(): number {
    return this.currentInvestment;
  }
  getCurrentPrize(): Prize | null {
    return this.currentPrize;
  }
  getHistory(): PrizeHistoryEntry[] {
    return [...this.history];
  }
  isSpinning(): boolean {
    return this.spinning;
  }
  getStockLeft(tier?: PrizeTier): number {
    return this.catalog
      .filter((p) => (tier ? p.tier === tier : true))
      .reduce((sum, p) => sum + p.remaining, 0);
  }
  getOdds(): ReturnType<typeof computeOdds> {
    return computeOdds(this.catalog, this.currentInvestment);
  }

  subscribe(listener: (view: RifaView) => void): () => void {
    this.listeners.add(listener);
    listener(this.getView());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const view = this.getView();
    for (const l of this.listeners) l(view);
  }

  getView(): RifaView {
    const unlocked = getUnlockedTiers(this.currentInvestment);
    return {
      phase: this.phase,
      brissaState: this.brissaState,
      totalInvested: this.totalInvested,
      investmentCount: this.investmentCount,
      isSpinning: this.spinning,
      showPrize: this.showPrize,
      prize: this.currentPrize,
      bestPrize: this.bestPrize,
      investmentAmount: this.currentInvestment,
      tierUnlocks: {
        sticker: unlocked.includes('sticker'),
        pamphlet: unlocked.includes('pamphlet'),
        certificate: unlocked.includes('certificate'),
        llavero: unlocked.includes('llavero'),
      },
      stockLeft: this.getStockLeft(),
    };
  }

  private get brissaState(): BrissaState {
    if (this.spinning) return 'receiving';
    if (this.showPrize) return 'happy';
    if (this.currentInvestment > 0) return 'waiting';
    return 'idle';
  }

  setInvestmentAmount(amount: number): void {
    this.currentInvestment = isValidInvestment(amount) ? amount : 0;
    if (!this.spinning) {
      this.phase = this.currentInvestment > 0 ? 'ready' : 'idle';
    }
    this.emit();
  }

  /** Devuelve el premio ya descontado del inventario, o `null` si no hay stock. */
  resolveSpin(): Prize | null {
    if (this.spinning) return null;
    if (!isValidInvestment(this.currentInvestment)) return null;
    return pickPrize(this.catalog, this.currentInvestment);
  }

  commitSpin(): void {
    this.spinning = true;
    this.phase = 'spinning';
    this.showPrize = false;
    this.currentPrize = null;
    this.emit();
  }

  /** Cierra la tirada: suma inversión, guarda historial y revela. */
  settle(prize: Prize): void {
    this.spinning = false;
    this.totalInvested += this.currentInvestment;
    this.investmentCount += 1;
    this.currentPrize = prize;
    this.showPrize = true;
    this.phase = 'revealed';
    this.history.unshift({
      amount: this.currentInvestment,
      prize: { ...prize },
      timestamp: new Date().toISOString(),
    });
    if (this.history.length > 40) this.history.length = 40;
    if (!this.bestPrize || getTierRank(prize.tier) > getTierRank(this.bestPrize.tier)) {
      this.bestPrize = { ...prize };
    }
    this.emit();
  }

  /** Reinicia el stock y los contadores. */
  resetAll(): void {
    this.catalog = buildCatalog();
    this.history = [];
    this.totalInvested = 0;
    this.investmentCount = 0;
    this.currentInvestment = 0;
    this.currentPrize = null;
    this.bestPrize = null;
    this.showPrize = false;
    this.spinning = false;
    this.phase = 'idle';
    this.emit();
  }
}
