import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Pool } from 'pg';
import { ReportFilters, comparison, cheapest, sellerCompare, summary, periodChange, dashboard, worklist, unmatched, toXlsx, XlsxCol, POSITION_LABEL } from '@ragyu/core';
import { DB, CurrentUser, AuthUser, httpErr } from './infra';

export function parseFilters(q: Record<string, string | undefined>): ReportFilters {
  const f: ReportFilters = {};
  if (q.category) f.category = q.category;
  if (q.q) f.q = q.q;
  if (q.sourceId) f.sourceId = q.sourceId;
  if (q.stock === 'in' || q.stock === 'out' || q.stock === 'all') f.stock = q.stock;
  if (q.includeShipping === '1' || q.includeShipping === 'true') f.includeShipping = true;
  if (q.priceBasis === 'list') f.priceBasis = 'list';
  if (q.asOf) { const d = new Date(q.asOf); if (!isNaN(d.getTime())) f.asOf = d; }
  return f;
}
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const metaLines = (m: any) => [`Hazırlanma: ${new Date().toLocaleString('tr-TR')}`, `Geçerlilik anı: ${new Date(m.asOf).toLocaleString('tr-TR')}`, `Fiyat esası: ${m.priceBasis}`, `Kargo ücreti dahil: ${m.shippingIncluded ? 'EVET (kargo bilgisi olan tekliflere eklendi)' : 'HAYIR'}`, `Stok filtresi: ${m.stock}`, m.formula];
const num = (v: any) => (v === null || v === undefined ? '' : v);

@Controller('api')
export class ReportsController {
  constructor(@Inject(DB) private db: Pool) {}

  @Get('dashboard') dashboard(@CurrentUser() u: AuthUser, @Query() q: any) { return dashboard(this.db, u.orgId, parseFilters(q)); }
  @Get('worklist') worklist(@CurrentUser() u: AuthUser) { return worklist(this.db, u.orgId); }
  @Get('unmatched') unmatched(@CurrentUser() u: AuthUser) { return unmatched(this.db, u.orgId); }

  @Get('reports/sales-performance')
  sales() { return { available: false, message: 'Satış verisi entegrasyonu (ör. Ticimax siparişleri) henüz bağlı değil. Bu rapor, gerçek satış verisi olmadan rakip fiyatından satış miktarı tahmin etmez.' }; }

  @Get('reports/:name')
  async report(@CurrentUser() u: AuthUser, @Param('name') name: string, @Query() q: Record<string, string>, @Res() res: any) {
    const f = parseFilters(q); const xlsx = q.format === 'xlsx';
    const send = async (title: string, meta: any, cols: XlsxCol[], rows: any[], json: any) => {
      if (!xlsx) return res.json(json);
      const buf = await toXlsx(title, metaLines(meta), cols, rows);
      res.set({ 'Content-Type': XLSX, 'Content-Disposition': `attachment; filename="${name}.xlsx"` }); return res.send(buf);
    };
    if (name === 'comparison') {
      const r = await comparison(this.db, u.orgId, f);
      const srcNames = [...new Set(r.rows.flatMap((x) => x.offers.filter((o) => o.eligible).map((o) => o.sourceName)))].sort();
      const cols: XlsxCol[] = [{ header: 'Ürün kodu', key: 'code' }, { header: 'Ürün', key: 'name', width: 34 }, { header: 'Kategori', key: 'category' }, { header: 'Paket', key: 'pack' }, { header: 'Ragyu paket fiyatı', key: 'own', fmt: 'try' }, { header: 'Ragyu TL/kg', key: 'ownUnit', fmt: 'try' },
        { header: 'Konum', key: 'pos' }, { header: 'Güvenilir rakip sayısı', key: 'n' }, { header: 'En düşük TL/kg', key: 'min', fmt: 'try' }, { header: 'En ucuz satıcı', key: 'minSrc', width: 26 }, { header: 'Ortalama TL/kg', key: 'avg', fmt: 'try' }, { header: 'Fark %', key: 'diff', fmt: 'pct' },
        ...srcNames.map((s) => ({ header: `${s} TL/kg`, key: `s:${s}`, fmt: 'try' as const, width: 18 })), { header: 'Dışlanan teklif', key: 'excl', width: 40 }];
      const rows = r.rows.map((x) => ({ code: x.code, name: x.name, category: x.category, pack: `${x.packQty} ${x.packUnit}`, own: x.ownPrice, ownUnit: x.ownUnitPrice, pos: x.position.label, n: x.stats.count, min: x.stats.min, minSrc: x.stats.minSource, avg: x.stats.avg, diff: x.position.diffPct,
        ...Object.fromEntries(srcNames.map((s) => [`s:${s}`, x.offers.find((o) => o.eligible && o.sourceName === s)?.unitPrice ?? ''])),
        excl: x.offers.filter((o) => !o.eligible).map((o) => `${o.sourceName}: ${o.excludedLabel}`).join('; ') }));
      return send('Fiyat karşılaştırma', r.meta, cols, rows, r);
    }
    if (name === 'cheapest') {
      const n = Math.min(10, Number(q.n ?? 5)); const r = await cheapest(this.db, u.orgId, f, n);
      const cols: XlsxCol[] = [{ header: 'Ürün kodu', key: 'code' }, { header: 'Ürün', key: 'name', width: 34 }, { header: 'Ragyu TL/kg', key: 'own', fmt: 'try' }, ...Array.from({ length: n }, (_, i) => [{ header: `${i + 1}. satıcı`, key: `s${i}`, width: 24 }, { header: `${i + 1}. TL/kg`, key: `p${i}`, fmt: 'try' as const }]).flat()];
      const rows = r.rows.map((x) => ({ code: x.code, name: x.name, own: x.ownUnitPrice, ...Object.fromEntries(Array.from({ length: n }, (_, i) => [[`s${i}`, x.top[i]?.sourceName ?? ''], [`p${i}`, x.top[i]?.unitPrice ?? '']]).flat()) }));
      return send(`${n} en ucuz`, r.meta, cols, rows, r);
    }
    if (name === 'seller') {
      if (!q.sellerSourceId) throw httpErr(400, 'Satıcı (sellerSourceId) seçilmedi.', 'validation');
      const r = await sellerCompare(this.db, u.orgId, q.sellerSourceId, f);
      const cols: XlsxCol[] = [{ header: 'Ürün kodu', key: 'code' }, { header: 'Ürün', key: 'name', width: 34 }, { header: 'Ragyu TL/kg', key: 'own', fmt: 'try' }, { header: 'Satıcı ürünü', key: 'title', width: 34 }, { header: 'Satıcı TL/kg', key: 'theirs', fmt: 'try' }, { header: 'Fark TL', key: 'diff', fmt: 'try' }, { header: 'Fark %', key: 'pct', fmt: 'pct' }, { header: 'Sonuç', key: 'verdict' }, { header: 'Dışlama nedeni', key: 'why', width: 28 }];
      const rows = r.rows.map((x) => ({ code: x.code, name: x.name, own: x.ownUnitPrice, title: x.offer.title, theirs: x.offer.unitPrice, diff: x.diffAbs, pct: x.diffPct, verdict: x.verdict, why: x.offer.excludedLabel ?? '' }));
      return send('Seçilen satıcı kıyası', r.meta, cols, rows, r);
    }
    if (name === 'summary') {
      const r = await summary(this.db, u.orgId, f);
      const cols: XlsxCol[] = [{ header: 'Ürün kodu', key: 'code' }, { header: 'Ürün', key: 'name', width: 34 }, { header: 'Ragyu TL/kg', key: 'own', fmt: 'try' }, { header: 'Min', key: 'min', fmt: 'try' }, { header: 'Ortalama', key: 'avg', fmt: 'try' }, { header: 'Medyan', key: 'med', fmt: 'try' }, { header: 'Maks', key: 'max', fmt: 'try' }, { header: 'Teklif sayısı', key: 'n' }, { header: 'Konum', key: 'pos' }, { header: 'Fark % (min)', key: 'diff', fmt: 'pct' }];
      const rows = r.rows.map((x) => ({ code: x.code, name: x.name, own: x.ownUnitPrice, min: x.stats.min, avg: x.stats.avg, med: x.stats.median, max: x.stats.max, n: x.stats.count, pos: x.position.label, diff: x.position.diffPct }));
      return send('Fiyat özeti', r.meta, cols, rows, r);
    }
    if (name === 'weekly') {
      const to = q.to ? new Date(q.to) : new Date(); const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86400_000);
      const r = await periodChange(this.db, u.orgId, f, from, to);
      const cols: XlsxCol[] = [{ header: 'Ürün kodu', key: 'code' }, { header: 'Ürün', key: 'name', width: 34 }, { header: 'Satıcı', key: 'src', width: 24 }, { header: 'Başlangıç TL/kg', key: 's', fmt: 'try' }, { header: 'Bitiş TL/kg', key: 'e', fmt: 'try' }, { header: 'Değişim TL', key: 'c', fmt: 'try' }, { header: 'Değişim %', key: 'p', fmt: 'pct' }, { header: 'Başlangıç gözlemi', key: 'so' }, { header: 'Bitiş gözlemi', key: 'eo' }, { header: 'Not', key: 'n', width: 30 }];
      const rows = r.rows.flatMap((x) => x.changes.map((c) => ({ code: x.code, name: x.name, src: c.sourceName, s: c.startUnitPrice, e: c.endUnitPrice, c: c.change, p: c.changePct, so: c.startObservedAt ?? '', eo: c.endObservedAt ?? '', n: c.note ?? '' })));
      return send('Dönemsel fiyat değişimi', { ...r.meta, formula: `Dönem: ${from.toLocaleString('tr-TR')} → ${to.toLocaleString('tr-TR')}. Her uçta o anda geçerli (güvenilir) son gözlem kullanılır; bugünkü fiyat geçmişe uygulanmaz.` }, cols, rows, r);
    }
    throw httpErr(404, 'Rapor bulunamadı.', 'not_found');
  }
}
