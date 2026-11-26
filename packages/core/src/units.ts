import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'adet';
export const UNITS: Unit[] = ['g', 'kg', 'ml', 'l', 'adet'];

export interface BaseQty { qty: Decimal; unit: 'g' | 'ml' }

/** Birimi taban birime (g / ml) çevirir. 'adet' için null döner: gramajı bilinmeyen adet ürünü kg ile kıyaslanamaz. */
export function toBase(qty: Decimal.Value, unit: string): BaseQty | null {
  const q = new Decimal(qty);
  if (!q.isFinite() || q.lte(0)) return null;
  switch (unit) {
    case 'g': return { qty: q, unit: 'g' };
    case 'kg': return { qty: q.mul(1000), unit: 'g' };
    case 'ml': return { qty: q, unit: 'ml' };
    case 'l': return { qty: q.mul(1000), unit: 'ml' };
    default: return null;
  }
}

/**
 * Karşılaştırılabilir birim fiyat: fiyat / (taban miktar / 1000)  => TL/kg veya TL/l.
 * Örn. 400 g, 320 TL  =>  320 / 0,4 = 800 TL/kg.
 */
export function unitPrice(price: Decimal.Value, qty: Decimal.Value, unit: string): { value: Decimal; per: 'kg' | 'l' } | null {
  const b = toBase(qty, unit);
  const p = new Decimal(price);
  if (!b || !p.isFinite() || p.lte(0)) return null;
  return { value: p.div(b.qty.div(1000)), per: b.unit === 'g' ? 'kg' : 'l' };
}

/** Gramaj çarpanı = 1000 / taban miktar. (500 g => 2, 400 g => 2,5) */
export function multiplier(qty: Decimal.Value, unit: string): Decimal | null {
  const b = toBase(qty, unit);
  return b ? new Decimal(1000).div(b.qty) : null;
}

export function normalizeUnitToken(raw: string): Unit | null {
  const s = raw.toLowerCase().replace(/\./g, '').trim();
  if (['g', 'gr', 'gram', 'grm'].includes(s)) return 'g';
  if (['kg', 'kilo', 'kilogram', 'kgr'].includes(s)) return 'kg';
  if (['ml', 'mililitre', 'cc'].includes(s)) return 'ml';
  if (['l', 'lt', 'litre', 'ltr'].includes(s)) return 'l';
  if (['adet', 'ad', 'pcs'].includes(s)) return 'adet';
  return null;
}

/** Metinden gramaj ayıklar: "500 g", "1,5 kg", "2 x 250 gr", "400gr". Bulamazsa null. */
export function parseQtyFromText(text: string | null | undefined): { qty: Decimal; unit: Unit } | null {
  if (!text) return null;
  const t = text.toLowerCase().replace(/ /g, ' ');
  const multi = t.match(/(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|kilogram|kilo|gr|gram|g|ml|lt|litre|l)\b/);
  if (multi) {
    const u = normalizeUnitToken(multi[3]);
    if (u) return { qty: new Decimal(multi[1]).mul(new Decimal(multi[2].replace(',', '.'))), unit: u };
  }
  const re = /(\d+(?:[.,]\d+)?)\s*(kg|kilogram|kilo|gr|gram|g|ml|lt|litre|l)(?![a-zçğıöşü])/g;
  let m: RegExpExecArray | null;
  const found: { qty: Decimal; unit: Unit }[] = [];
  while ((m = re.exec(t))) {
    const u = normalizeUnitToken(m[2]);
    if (u) found.push({ qty: new Decimal(m[1].replace(',', '.')), unit: u });
  }
  return found.length ? found[0] : null;
}

/** Türkçe veya düz fiyat metnini ondalık sayıya çevirir: "1.299,90 ₺" -> 1299.90. */
export function parsePrice(raw: string | number | null | undefined, opts: { dotDecimal?: boolean } = {}): Decimal | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? new Decimal(raw) : null;
  let s = raw.replace(/[^\d.,]/g, '');
  if (!s) return null;
  const hasDot = s.includes('.');
  const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = /,\d{3}$/.test(s) && s.split(',').length > 2 ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (hasDot && !opts.dotDecimal) {
    // "1.299" -> bin ayracı; "12.5" -> ondalık
    if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  try {
    const d = new Decimal(s);
    return d.isFinite() ? d : null;
  } catch { return null; }
}

const trFmt = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const trNum = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

export function formatTRY(v: Decimal.Value | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return trFmt.format(new Decimal(v).toDecimalPlaces(2).toNumber());
}
export function formatNumberTR(v: Decimal.Value | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return trNum.format(new Decimal(v).toNumber());
}
export { Decimal };
