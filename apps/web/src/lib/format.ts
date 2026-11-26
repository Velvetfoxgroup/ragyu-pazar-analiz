const cur = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 });
/** Yalnızca GÖSTERİM için; hesaplar sunucuda ondalık (decimal) tipiyle yapılır. */
export const tl = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : cur.format(Number(v)));
export const n = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '—' : num.format(Number(v)));
export const pct = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : `${Number(v) > 0 ? '+' : ''}${num.format(Number(v))}%`);
export const dt = (v: string | Date | null | undefined) => (v ? new Date(v).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const ago = (v: string | Date | null | undefined) => {
  if (!v) return 'hiç';
  const m = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  return m < 1 ? 'az önce' : m < 60 ? `${m} dk önce` : m < 1440 ? `${Math.round(m / 60)} sa önce` : `${Math.round(m / 1440)} gün önce`;
};
export const pack = (q: string | number, u: string) => `${num.format(Number(q))} ${u}`;
