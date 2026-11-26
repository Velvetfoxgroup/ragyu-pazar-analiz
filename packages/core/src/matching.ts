import { parseQtyFromText, toBase } from './units';

/** Ürün adından et niteliklerini çıkarır (Türkçe, küçük harfe duyarsız). */
export interface MeatAttrs {
  species?: string;      // dana, kuzu, tavuk, hindi, balık...
  cut?: string;          // antrikot, kıyma, kuşbaşı, pirzola...
  processing?: string;   // kıyma, dilimli, marine, köfte, sucuk...
  bone?: 'kemikli' | 'kemiksiz';
  state?: 'taze' | 'donuk';
  brand?: string;
}

const lower = (s: string) => s.toLocaleLowerCase('tr-TR');

const SPECIES = ['dana', 'kuzu', 'tavuk', 'hindi', 'balık', 'somon', 'koyun', 'oğlak', 'ördek', 'bıldırcın', 'manda'];
const CUTS = ['antrikot', 'ribeye', 'bonfile', 'kontrfile', 'kuşbaşı', 'kıyma', 'pirzola', 'but', 'kol', 'kaburga', 'biftek', 'tomahawk', 'T-bone', 'döş', 'incik', 'gerdan', 'külbastı', 'şnitzel', 'bacak', 'kanat', 'göğüs', 'sote'];
const PROCESSING = ['köfte', 'sucuk', 'salam', 'sosis', 'pastırma', 'dilimli', 'marine', 'füme', 'kavurma', 'hamburger', 'burger', 'döner'];

export function extractAttrs(title: string): MeatAttrs {
  const t = lower(title);
  const out: MeatAttrs = {};
  for (const s of SPECIES) if (t.includes(s)) { out.species = s; break; }
  for (const c of CUTS) if (t.includes(lower(c))) { out.cut = lower(c); break; }
  for (const p of PROCESSING) if (t.includes(p)) { out.processing = p; break; }
  if (/kemiksiz/.test(t)) out.bone = 'kemiksiz'; else if (/kemikli/.test(t)) out.bone = 'kemikli';
  if (/donuk|dondurulmuş/.test(t)) out.state = 'donuk'; else if (/taze|soğutulmuş/.test(t)) out.state = 'taze';
  return out;
}

export interface Mismatch { field: string; ours: string; theirs: string; severity: 'high' | 'medium' }

export interface Comparable {
  title: string; brand?: string | null; attrs?: Record<string, any> | null;
  packQty?: string | number | null; packUnit?: string | null;
}

/** İki ürün arasındaki nitelik uyuşmazlıklarını döndürür. Boş dizi = çelişki yok. */
export function findMismatches(ours: Comparable, theirs: Comparable): Mismatch[] {
  const a = { ...extractAttrs(ours.title), ...(ours.attrs ?? {}) } as Record<string, string>;
  const b = { ...extractAttrs(theirs.title), ...(theirs.attrs ?? {}) } as Record<string, string>;
  const out: Mismatch[] = [];
  const labels: Record<string, string> = { species: 'Hayvan türü', cut: 'Kesim', processing: 'İşlenme biçimi', bone: 'Kemikli/kemiksiz', state: 'Taze/donuk' };
  for (const f of Object.keys(labels)) {
    if (a[f] && b[f] && lower(a[f]) !== lower(b[f])) out.push({ field: labels[f], ours: a[f], theirs: b[f], severity: f === 'processing' || f === 'species' || f === 'cut' ? 'high' : 'medium' });
    else if (f === 'processing' && !!a[f] !== !!b[f]) out.push({ field: labels[f], ours: a[f] ?? '—', theirs: b[f] ?? '—', severity: 'high' });
  }
  if (ours.brand && theirs.brand && lower(ours.brand) !== lower(theirs.brand)) out.push({ field: 'Marka', ours: ours.brand, theirs: theirs.brand, severity: 'medium' });
  const qa = ours.packQty && ours.packUnit ? toBase(ours.packQty, ours.packUnit) : null;
  const qb = theirs.packQty && theirs.packUnit ? toBase(theirs.packQty, theirs.packUnit) : null;
  if (qa && qb) {
    if (qa.unit !== qb.unit) out.push({ field: 'Birim', ours: `${ours.packQty} ${ours.packUnit}`, theirs: `${theirs.packQty} ${theirs.packUnit}`, severity: 'high' });
    else if (!qa.qty.eq(qb.qty)) out.push({ field: 'Paket gramajı', ours: `${ours.packQty} ${ours.packUnit}`, theirs: `${theirs.packQty} ${theirs.packUnit}`, severity: 'medium' });
  } else if (qa && !qb) {
    out.push({ field: 'Paket gramajı', ours: `${ours.packQty} ${ours.packUnit}`, theirs: 'bilinmiyor', severity: 'high' });
  }
  return out;
}

function tokens(s: string): string[] {
  return lower(s).replace(/[^a-zçğıöşü0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !/^\d+$/.test(w));
}

/** 0..1 arası benzerlik puanı (Jaccard + nitelik uyuşmazlığı cezası). Öneri üretmek için; karar insana aittir. */
export function similarity(ours: Comparable, theirs: Comparable): { score: number; mismatches: Mismatch[] } {
  const A = new Set(tokens(ours.title)); const B = new Set(tokens(theirs.title));
  let inter = 0; A.forEach((w) => { if (B.has(w)) inter++; });
  const union = A.size + B.size - inter;
  let score = union ? inter / union : 0;
  const mismatches = findMismatches(ours, theirs);
  for (const m of mismatches) score -= m.severity === 'high' ? 0.25 : 0.08;
  return { score: Math.max(0, Math.min(1, score)), mismatches };
}

export { parseQtyFromText };
