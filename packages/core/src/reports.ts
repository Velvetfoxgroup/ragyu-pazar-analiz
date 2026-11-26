import type { Pool } from 'pg';
import Decimal from 'decimal.js';
import ExcelJS from 'exceljs';
import { toBase } from './units';

export interface ReportFilters {
  asOf?: Date;
  category?: string; q?: string; sourceId?: string; variantId?: string;
  stock?: 'in' | 'out' | 'all';          // varsayılan: in (stokta olmayan teklifler sıralamaya girmez)
  includeShipping?: boolean;              // kargo dahil karşılaştırma (raporda açıkça belirtilir)
  priceBasis?: 'sale' | 'list';           // indirimli fiyat | liste fiyatı
}

export type ExclusionReason =
  | 'match_unapproved' | 'self_listing' | 'quality_review' | 'quality_invalid' | 'qty_unknown' | 'unit_family'
  | 'stale' | 'out_of_stock' | 'in_stock_only' | 'multibuy' | 'url_inactive' | 'no_observation' | 'source_filter';

export const REASON_LABEL: Record<ExclusionReason, string> = {
  match_unapproved: 'Eşleşme onaylı değil', self_listing: 'Ragyu’nun kendi ilanı', quality_review: 'Veri inceleme bekliyor',
  quality_invalid: 'Fiyat geçersiz', qty_unknown: 'Gramaj bilinmiyor', unit_family: 'Birim türü uyuşmuyor', stale: 'Veri güncel değil',
  out_of_stock: 'Stokta yok', in_stock_only: 'Stok filtresi dışı', multibuy: 'Çoklu alım şartı var', url_inactive: 'URL pasif', no_observation: 'Henüz gözlem yok', source_filter: 'Kaynak filtresi dışı',
};

export interface Offer {
  linkId: string; competitorProductId: string; sourceId: string; sourceName: string; sellerName: string | null; title: string;
  linkStatus: string; url: string | null; observedAt: string | null;
  salePrice: string | null; listPrice: string | null; shippingFee: string | null; comparedPrice: string | null;
  packQty: string | null; packUnit: string | null; unitPrice: string | null; per: 'kg' | 'l' | null;
  inStock: boolean | null; campaign: string | null; multibuyMin: number | null; qtySource: string | null;
  eligible: boolean; excluded?: ExclusionReason; excludedLabel?: string; mismatches: any[];
}

export type PositionKey = 'cheapest' | 'same' | 'below_avg' | 'avg' | 'above_avg' | 'most_expensive' | 'none';
export const POSITION_LABEL: Record<PositionKey, string> = {
  cheapest: 'En ucuz', same: 'Aynı', below_avg: 'Ortalamadan ucuz', avg: 'Ortalama', above_avg: 'Ortalamadan pahalı', most_expensive: 'En pahalı', none: 'Kıyas yok',
};
/**
 * Fiyat konumu formülü (R = Ragyu birim fiyatı, rakip birim fiyatları c_i yalnızca güvenilir tekliflerden):
 *  min = min(c_i), max = max(c_i), ort = ortalama(c_i)
 *  R < min → En ucuz;  R = min → Aynı;  R > max → En pahalı;
 *  |R − ort| ≤ %2·ort → Ortalama;  R < ort → Ortalamadan ucuz;  aksi → Ortalamadan pahalı.
 *  Fark TL = R − min ; Fark % = (R − min) / min · 100.  Sıra = 1 + #{c_i < R}.
 */
export function classifyPosition(own: Decimal | null, offers: Decimal[]): { key: PositionKey; rank: number | null; diffAbs: string | null; diffPct: string | null; avgDiffPct: string | null } {
  if (!own || offers.length === 0) return { key: 'none', rank: null, diffAbs: null, diffPct: null, avgDiffPct: null };
  const min = Decimal.min(...offers); const max = Decimal.max(...offers);
  const avg = offers.reduce((a, b) => a.plus(b), new Decimal(0)).div(offers.length);
  let key: PositionKey;
  if (own.lt(min)) key = 'cheapest';
  else if (own.eq(min)) key = 'same';
  else if (own.gt(max)) key = 'most_expensive';
  else if (own.minus(avg).abs().lte(avg.mul('0.02'))) key = 'avg';
  else if (own.lt(avg)) key = 'below_avg';
  else key = 'above_avg';
  const rank = 1 + offers.filter((c) => c.lt(own)).length;
  return { key, rank, diffAbs: own.minus(min).toDecimalPlaces(2).toString(), diffPct: own.minus(min).div(min).mul(100).toDecimalPlaces(1).toString(), avgDiffPct: own.minus(avg).div(avg).mul(100).toDecimalPlaces(1).toString() };
}

export interface ComparisonRow {
  variantId: string; productId: string; code: string; sku: string; name: string; brand: string | null; category: string | null; imageUrl: string | null;
  packQty: string; packUnit: string; ownPrice: string | null; ownUnitPrice: string | null; per: 'kg' | 'l' | null; ownUnitKnown: boolean;
  offers: Offer[];
  stats: { count: number; min: string | null; minSource: string | null; avg: string | null; median: string | null; max: string | null };
  position: ReturnType<typeof classifyPosition> & { label: string };
}

export interface ComparisonReport {
  meta: { asOf: string; shippingIncluded: boolean; priceBasis: string; stock: string; filters: ReportFilters; formula: string };
  rows: ComparisonRow[];
}

export async function comparison(db: Pool, orgId: string, f: ReportFilters = {}): Promise<ComparisonReport> {
  const asOf = f.asOf ?? new Date();
  const isNow = !f.asOf || Math.abs(asOf.getTime() - Date.now()) < 5000;
  const stock = f.stock ?? 'in'; const basis = f.priceBasis ?? 'sale';
  const params: any[] = [orgId, asOf];
  let vWhere = 'v.org_id=$1 AND v.active AND p.active';
  if (f.category) { params.push(f.category); vWhere += ` AND p.category=$${params.length}`; }
  if (f.q) { params.push(`%${f.q.toLowerCase()}%`); vWhere += ` AND (lower(p.name) LIKE $${params.length} OR lower(p.code) LIKE $${params.length} OR lower(v.sku) LIKE $${params.length})`; }
  if (f.variantId) { params.push(f.variantId); vWhere += ` AND v.id=$${params.length}`; }

  const vars = await db.query(
    `SELECT v.id AS variant_id, v.sku, v.pack_qty, v.pack_unit, p.id AS product_id, p.code, p.name, p.brand, p.category, p.image_url,
            COALESCE((SELECT h.price FROM own_price_history h WHERE h.variant_id=v.id AND h.valid_from <= $2 ORDER BY h.valid_from DESC LIMIT 1),
                     CASE WHEN ${isNow ? 'true' : 'false'} THEN v.price END) AS own_price
       FROM product_variants v JOIN products p ON p.id=v.product_id WHERE ${vWhere} ORDER BY p.name, v.sku`, params);

  const ids = vars.rows.map((r) => r.variant_id);
  const offersByVariant = new Map<string, Offer[]>();
  if (ids.length) {
    const rows = await db.query(
      `SELECT l.id AS link_id, l.variant_id, l.status AS link_status, l.mismatches,
              cp.id AS cp_id, cp.title, cp.url AS cp_url, s.id AS source_id, s.name AS source_name, s.stale_after_hours, sl.name AS seller_name, COALESCE(sl.is_self,false) AS is_self,
              o.observed_at, o.sale_price, o.list_price, o.shipping_fee, o.pack_qty, o.pack_unit, o.base_qty, o.base_unit, o.in_stock, o.campaign, o.multibuy_min, o.quality, o.quality_reasons, o.qty_source, o.url AS obs_url,
              (SELECT bool_or(t.active) FROM tracked_urls t WHERE t.competitor_product_id=cp.id) AS has_active_url
         FROM product_links l
         JOIN competitor_products cp ON cp.id=l.competitor_product_id
         JOIN sources s ON s.id=cp.source_id
         LEFT JOIN sellers sl ON sl.id=cp.seller_id
         LEFT JOIN LATERAL (SELECT * FROM price_observations o WHERE o.competitor_product_id=cp.id AND o.observed_at <= $2 ORDER BY o.observed_at DESC LIMIT 1) o ON true
        WHERE l.org_id=$1 AND l.variant_id = ANY($3) AND l.status IN ('approved','review','suggested')`, [orgId, asOf, ids]);
    for (const r of rows.rows) {
      let reason: ExclusionReason | undefined;
      const unit = r.base_unit as 'g' | 'ml' | null;
      let compared: Decimal | null = null; let unitP: Decimal | null = null;
      if (r.sale_price) {
        const chosen = basis === 'list' && r.list_price ? new Decimal(r.list_price) : new Decimal(r.sale_price);
        compared = f.includeShipping && r.shipping_fee ? chosen.plus(r.shipping_fee) : chosen;
        if (r.base_qty) unitP = compared.div(new Decimal(r.base_qty).div(1000));
      }
      const v = vars.rows.find((x) => x.variant_id === r.variant_id)!;
      const vb = toBase(v.pack_qty, v.pack_unit);
      if (r.link_status !== 'approved') reason = 'match_unapproved';
      else if (r.is_self) reason = 'self_listing';
      else if (f.sourceId && f.sourceId !== r.source_id) reason = 'source_filter';
      else if (!r.observed_at) reason = 'no_observation';
      else if (isNow && !r.has_active_url) reason = 'url_inactive';
      else if (r.quality === 'invalid') reason = 'quality_invalid';
      else if (r.quality === 'review') reason = (r.quality_reasons ?? []).some((x: any) => x.code === 'qty_unknown') ? 'qty_unknown' : 'quality_review';
      else if (!unitP) reason = 'qty_unknown';
      else if (vb && unit && vb.unit !== unit) reason = 'unit_family';
      else if (new Date(r.observed_at).getTime() < asOf.getTime() - r.stale_after_hours * 3600_000) reason = 'stale';
      else if (r.multibuy_min && r.multibuy_min > 1) reason = 'multibuy';
      else if (stock === 'in' && r.in_stock === false) reason = 'out_of_stock';
      else if (stock === 'out' && r.in_stock !== false) reason = 'in_stock_only';
      const o: Offer = {
        linkId: r.link_id, competitorProductId: r.cp_id, sourceId: r.source_id, sourceName: r.source_name, sellerName: r.seller_name, title: r.title,
        linkStatus: r.link_status, url: r.obs_url ?? r.cp_url, observedAt: r.observed_at ? new Date(r.observed_at).toISOString() : null,
        salePrice: r.sale_price, listPrice: r.list_price, shippingFee: r.shipping_fee, comparedPrice: compared?.toString() ?? null,
        packQty: r.pack_qty, packUnit: r.pack_unit, unitPrice: unitP?.toDecimalPlaces(2).toString() ?? null, per: unit === 'g' ? 'kg' : unit === 'ml' ? 'l' : null,
        inStock: r.in_stock, campaign: r.campaign, multibuyMin: r.multibuy_min, qtySource: r.qty_source,
        eligible: !reason, excluded: reason, excludedLabel: reason ? REASON_LABEL[reason] : undefined, mismatches: r.mismatches ?? [],
      };
      (offersByVariant.get(r.variant_id) ?? offersByVariant.set(r.variant_id, []).get(r.variant_id)!).push(o);
    }
  }

  const out: ComparisonRow[] = vars.rows.map((v) => {
    const offers = (offersByVariant.get(v.variant_id) ?? []).sort((a, b) => Number(a.eligible ? 0 : 1) - Number(b.eligible ? 0 : 1) || Number(a.unitPrice ?? 1e18) - Number(b.unitPrice ?? 1e18));
    const ownBase = toBase(v.pack_qty, v.pack_unit);
    const own = v.own_price ? new Decimal(v.own_price) : null;
    const ownUnit = own && ownBase ? own.div(ownBase.qty.div(1000)) : null;
    const elig = offers.filter((o) => o.eligible);
    const vals = elig.map((o) => new Decimal(o.unitPrice!)).sort((a, b) => a.cmp(b));
    const min = vals[0]; const max = vals[vals.length - 1];
    const avg = vals.length ? vals.reduce((a, b) => a.plus(b), new Decimal(0)).div(vals.length) : null;
    const med = vals.length ? (vals.length % 2 ? vals[(vals.length - 1) / 2] : vals[vals.length / 2 - 1].plus(vals[vals.length / 2]).div(2)) : null;
    const pos = classifyPosition(ownUnit, vals);
    return {
      variantId: v.variant_id, productId: v.product_id, code: v.code, sku: v.sku, name: v.name, brand: v.brand, category: v.category, imageUrl: v.image_url,
      packQty: v.pack_qty, packUnit: v.pack_unit, ownPrice: v.own_price, ownUnitPrice: ownUnit?.toDecimalPlaces(2).toString() ?? null,
      per: ownBase ? (ownBase.unit === 'g' ? 'kg' : 'l') : null, ownUnitKnown: !!ownUnit, offers,
      stats: { count: vals.length, min: min?.toDecimalPlaces(2).toString() ?? null, minSource: elig.find((o) => new Decimal(o.unitPrice!).eq(min ?? -1))?.sourceName ?? null,
        avg: avg?.toDecimalPlaces(2).toString() ?? null, median: med?.toDecimalPlaces(2).toString() ?? null, max: max?.toDecimalPlaces(2).toString() ?? null },
      position: { ...pos, label: POSITION_LABEL[pos.key] },
    };
  });
  return {
    meta: {
      asOf: asOf.toISOString(), shippingIncluded: !!f.includeShipping, priceBasis: basis === 'list' ? 'Liste fiyatı' : 'İndirimli (satış) fiyatı', stock,
      filters: { ...f, asOf: undefined },
      formula: 'Birim fiyat = paket fiyatı ÷ (gramaj ÷ 1000) → TL/kg. Konum: Ragyu birim fiyatı, yalnızca onaylı eşleşme, geçerli fiyat, bilinen gramaj, güncel veri ve stokta olan rakip tekliflerle kıyaslanır.',
    },
    rows: out,
  };
}

/** Her ürün için en ucuz N güvenilir satıcı. */
export async function cheapest(db: Pool, orgId: string, f: ReportFilters, n = 5) {
  const rep = await comparison(db, orgId, f);
  return { meta: rep.meta, rows: rep.rows.map((r) => ({ ...r, top: r.offers.filter((o) => o.eligible).slice(0, n), excludedCount: r.offers.filter((o) => !o.eligible).length })) };
}

/** Seçilen satıcıyla Ragyu karşılaştırması. */
export async function sellerCompare(db: Pool, orgId: string, sourceId: string, f: ReportFilters) {
  const rep = await comparison(db, orgId, { ...f, sourceId: undefined });
  const rows = rep.rows.flatMap((r) => {
    const o = r.offers.find((x) => x.sourceId === sourceId && x.linkStatus === 'approved' && x.excluded !== 'self_listing');
    if (!o) return [];
    const diff = o.eligible && r.ownUnitPrice && o.unitPrice ? new Decimal(r.ownUnitPrice).minus(o.unitPrice) : null;
    return [{ variantId: r.variantId, code: r.code, name: r.name, category: r.category, packQty: r.packQty, packUnit: r.packUnit,
      ownUnitPrice: r.ownUnitPrice, per: r.per, offer: o, diffAbs: diff?.toDecimalPlaces(2).toString() ?? null,
      diffPct: diff && o.unitPrice ? diff.div(o.unitPrice).mul(100).toDecimalPlaces(1).toString() : null,
      verdict: !diff ? 'Kıyas dışı' : diff.lt(0) ? 'Ragyu daha ucuz' : diff.eq(0) ? 'Eşit' : 'Ragyu daha pahalı' }];
  });
  return { meta: rep.meta, rows };
}

/** Fiyat özeti: ürün bazında min/ort/medyan/maks + dağılım + rakip kapsama. */
export async function summary(db: Pool, orgId: string, f: ReportFilters) {
  const rep = await comparison(db, orgId, f);
  const dist: Record<string, number> = {};
  for (const r of rep.rows) dist[r.position.key] = (dist[r.position.key] ?? 0) + 1;
  const perSource = new Map<string, { sourceId: string; name: string; matched: number; reliable: number; cheaperThanMe: number; cheaperThanMeCount: number }>();
  for (const r of rep.rows) for (const o of r.offers) {
    if (o.excluded === 'self_listing') continue;
    const s = perSource.get(o.sourceId) ?? perSource.set(o.sourceId, { sourceId: o.sourceId, name: o.sourceName, matched: 0, reliable: 0, cheaperThanMe: 0, cheaperThanMeCount: 0 }).get(o.sourceId)!;
    if (o.linkStatus === 'approved') s.matched++;
    if (o.eligible) { s.reliable++; if (r.ownUnitPrice && new Decimal(o.unitPrice!).lt(r.ownUnitPrice)) s.cheaperThanMeCount++; }
  }
  const total = rep.rows.length;
  return { meta: rep.meta, distribution: dist, total, rows: rep.rows,
    sources: [...perSource.values()].map((s) => ({ ...s, coveragePct: total ? Math.round((s.matched / total) * 100) : 0 })).sort((a, b) => b.matched - a.matched) };
}

/** Haftalık (veya seçilen dönem) fiyat değişimi: başlangıç ve bitiş anında geçerli gözlemler karşılaştırılır. */
export async function periodChange(db: Pool, orgId: string, f: ReportFilters, from: Date, to: Date) {
  const [a, b] = await Promise.all([comparison(db, orgId, { ...f, asOf: from }), comparison(db, orgId, { ...f, asOf: to })]);
  const startByLink = new Map<string, Offer>();
  a.rows.forEach((r) => r.offers.forEach((o) => startByLink.set(o.linkId, o)));
  const rows = b.rows.map((r) => {
    const prevRow = a.rows.find((x) => x.variantId === r.variantId);
    const changes = r.offers.filter((o) => o.linkStatus === 'approved' && o.excluded !== 'self_listing').map((o) => {
      const s = startByLink.get(o.linkId);
      const p0 = s?.eligible && s.unitPrice ? new Decimal(s.unitPrice) : null;
      const p1 = o.eligible && o.unitPrice ? new Decimal(o.unitPrice) : null;
      const d = p0 && p1 ? p1.minus(p0) : null;
      return { sourceId: o.sourceId, sourceName: o.sourceName, title: o.title, startUnitPrice: p0?.toString() ?? null, endUnitPrice: p1?.toString() ?? null,
        change: d?.toDecimalPlaces(2).toString() ?? null, changePct: d && p0 ? d.div(p0).mul(100).toDecimalPlaces(1).toString() : null,
        startObservedAt: s?.observedAt ?? null, endObservedAt: o.observedAt, note: !p0 && p1 ? 'Dönem başında güvenilir veri yok' : p0 && !p1 ? 'Dönem sonunda güvenilir veri yok' : undefined };
    });
    const own0 = prevRow?.ownUnitPrice ? new Decimal(prevRow.ownUnitPrice) : null; const own1 = r.ownUnitPrice ? new Decimal(r.ownUnitPrice) : null;
    return { variantId: r.variantId, code: r.code, name: r.name, category: r.category, per: r.per, ownStart: own0?.toString() ?? null, ownEnd: own1?.toString() ?? null,
      ownChangePct: own0 && own1 && !own0.isZero() ? own1.minus(own0).div(own0).mul(100).toDecimalPlaces(1).toString() : null,
      minStart: prevRow?.stats.min ?? null, minEnd: r.stats.min, changes };
  }).filter((r) => r.changes.length);
  return { meta: { ...b.meta, from: from.toISOString(), to: to.toISOString() }, rows };
}

export async function dashboard(db: Pool, orgId: string, f: ReportFilters = {}) {
  const sum = await summary(db, orgId, f);
  const now = new Date();
  const wk = await periodChange(db, orgId, f, new Date(now.getTime() - 7 * 86400_000), now);
  const perSource = new Map<string, { name: string; up: number; down: number; same: number }>();
  for (const r of wk.rows) for (const c of r.changes) {
    if (c.changePct === null) continue;
    const s = perSource.get(c.sourceId) ?? perSource.set(c.sourceId, { name: c.sourceName, up: 0, down: 0, same: 0 }).get(c.sourceId)!;
    const v = Number(c.changePct); if (v > 0) s.up++; else if (v < 0) s.down++; else s.same++;
  }
  const q = async (sql: string, p: any[] = [orgId]) => Number((await db.query(sql, p)).rows[0].n);
  const tracked = sum.rows.filter((r) => r.offers.some((o) => o.linkStatus === 'approved' && o.excluded !== 'self_listing')).length;
  const reliable = sum.rows.filter((r) => r.stats.count > 0).length;
  const withoutApproved = sum.total - tracked;
  const stale = await db.query(`SELECT id,name,last_attempt_at,last_success_at,stale_after_hours FROM sources WHERE org_id=$1 AND active ORDER BY name`, [orgId]);
  const staleList = stale.rows.filter((s) => !s.last_success_at || Date.now() - new Date(s.last_success_at).getTime() > s.stale_after_hours * 3600_000);
  const cheapestCount = sum.distribution.cheapest ?? 0;
  const cheaperSellers = [...sum.sources].sort((a, b) => b.cheaperThanMeCount - a.cheaperThanMeCount).slice(0, 10);
  return {
    meta: sum.meta,
    totals: { products: sum.total, tracked, reliable, unmatched: withoutApproved, staleSources: staleList.length,
      pendingLinks: await q(`SELECT count(*) n FROM product_links WHERE org_id=$1 AND status IN ('review','suggested')`),
      openAlerts: await q(`SELECT count(*) n FROM alerts WHERE org_id=$1 AND status='open'`) },
    headline: { cheapest: cheapestCount, ofTotal: sum.total },
    distribution: sum.distribution,
    sourcesWithCoverage: sum.sources,
    cheaperThanMe: cheaperSellers.map((s) => ({ name: s.name, count: s.cheaperThanMeCount })),
    priceMovers: [...perSource.values()].sort((a, b) => b.up + b.down - (a.up + a.down)),
    staleSources: staleList,
    sourceHealth: stale.rows,
  };
}

export async function worklist(db: Pool, orgId: string) {
  const pending = await db.query(
    `SELECT l.id, l.status, l.origin, l.score, l.mismatches, l.created_at, p.name AS product_name, v.sku, v.pack_qty, v.pack_unit, cp.title AS competitor_title, s.name AS source_name
       FROM product_links l JOIN product_variants v ON v.id=l.variant_id JOIN products p ON p.id=v.product_id
       JOIN competitor_products cp ON cp.id=l.competitor_product_id JOIN sources s ON s.id=cp.source_id
      WHERE l.org_id=$1 AND l.status IN ('review','suggested') ORDER BY l.created_at DESC LIMIT 200`, [orgId]);
  const failed = await db.query(
    `SELECT t.id, t.url, t.last_error, t.last_attempt_at, t.last_success_at, t.consecutive_failures, s.name AS source_name, cp.title
       FROM tracked_urls t JOIN sources s ON s.id=t.source_id JOIN competitor_products cp ON cp.id=t.competitor_product_id
      WHERE t.org_id=$1 AND t.active AND t.last_status='error' ORDER BY t.consecutive_failures DESC, t.last_attempt_at DESC LIMIT 200`, [orgId]);
  const alerts = await db.query(`SELECT * FROM alerts WHERE org_id=$1 AND status='open' ORDER BY created_at DESC LIMIT 300`, [orgId]);
  const qtyDoubts = await db.query(
    `SELECT t.id AS tracked_url_id, t.url, cp.title, s.name AS source_name, o.reasons FROM tracked_urls t
       JOIN competitor_products cp ON cp.id=t.competitor_product_id JOIN sources s ON s.id=t.source_id
       JOIN LATERAL (SELECT quality_reasons AS reasons FROM price_observations o WHERE o.tracked_url_id=t.id ORDER BY observed_at DESC LIMIT 1) o ON true
      WHERE t.org_id=$1 AND t.active AND o.reasons::text LIKE '%qty_%' LIMIT 200`, [orgId]);
  const now = new Date();
  const wk = await periodChange(db, orgId, {}, new Date(now.getTime() - 7 * 86400_000), now);
  const big = wk.rows.flatMap((r) => r.changes.filter((c) => c.changePct && Math.abs(Number(c.changePct)) >= 10).map((c) => ({ variantId: r.variantId, code: r.code, name: r.name, ...c })));
  const pendingOverrides = await db.query(
    `SELECT q.id, q.pack_qty, q.pack_unit, q.reason, q.created_at, t.url, cp.title FROM qty_overrides q JOIN tracked_urls t ON t.id=q.tracked_url_id JOIN competitor_products cp ON cp.id=t.competitor_product_id
      WHERE q.org_id=$1 AND q.status='pending' ORDER BY q.created_at`, [orgId]);
  return { pendingLinks: pending.rows, failedScrapes: failed.rows, qtyDoubts: qtyDoubts.rows, alerts: alerts.rows, bigChanges: big, pendingOverrides: pendingOverrides.rows };
}

/** Eşleşmeyen çalışma kuyruğu: onaylı rakip eşleşmesi olmayan Ragyu varyantları + bağlanmamış rakip ürünleri. */
export async function unmatched(db: Pool, orgId: string) {
  const variants = await db.query(
    `SELECT v.id AS variant_id, v.sku, v.pack_qty, v.pack_unit, p.id AS product_id, p.name, p.code, p.category,
            (SELECT count(*) FROM product_links l WHERE l.variant_id=v.id AND l.status IN ('review','suggested'))::int AS pending_count
       FROM product_variants v JOIN products p ON p.id=v.product_id
      WHERE v.org_id=$1 AND v.active AND p.active AND NOT EXISTS (SELECT 1 FROM product_links l WHERE l.variant_id=v.id AND l.status='approved') ORDER BY p.name`, [orgId]);
  const cps = await db.query(
    `SELECT cp.id, cp.title, cp.brand, cp.url, cp.attrs, s.name AS source_name,
            (SELECT o.unit_price FROM price_observations o WHERE o.competitor_product_id=cp.id ORDER BY observed_at DESC LIMIT 1) AS last_unit_price
       FROM competitor_products cp JOIN sources s ON s.id=cp.source_id
      WHERE cp.org_id=$1 AND NOT EXISTS (SELECT 1 FROM product_links l WHERE l.competitor_product_id=cp.id AND l.status IN ('approved','review','suggested')) ORDER BY s.name, cp.title`, [orgId]);
  return { variants: variants.rows, competitorProducts: cps.rows };
}

// ------------------------------------------------------------------ Excel
export interface XlsxCol { header: string; key: string; width?: number; fmt?: 'try' | 'pct' | 'text' }
export async function toXlsx(title: string, meta: string[], cols: XlsxCol[], rows: Record<string, any>[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); wb.creator = 'Ragyu Pazar ve Fiyat Analiz Merkezi'; wb.created = new Date();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([title]).font = { bold: true, size: 14 };
  meta.forEach((m) => ws.addRow([m]).font = { italic: true, color: { argb: 'FF555555' } });
  ws.addRow([]);
  const hr = ws.addRow(cols.map((c) => c.header)); hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hr.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7A1F2B' } }; });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 16; });
  for (const r of rows) {
    const row = ws.addRow(cols.map((c) => { const v = r[c.key]; return v !== null && v !== undefined && (c.fmt === 'try' || c.fmt === 'pct') && v !== '' ? Number(v) : v ?? ''; }));
    cols.forEach((c, i) => { if (c.fmt === 'try') row.getCell(i + 1).numFmt = '#,##0.00 "₺"'; if (c.fmt === 'pct') row.getCell(i + 1).numFmt = '0.0"%"'; });
  }
  ws.views = [{ state: 'frozen', ySplit: 4 + meta.length }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
