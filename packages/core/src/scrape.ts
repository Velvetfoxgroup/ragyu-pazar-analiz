import type { Pool } from 'pg';
import Decimal from 'decimal.js';
import { safeFetch, FetchResult, UrlBlockedError } from './ssrf';
import { getAdapter, Extracted } from './extract';
import './adapters/sites';
import { toBase, unitPrice } from './units';
import { findMismatches } from './matching';

export type Fetcher = (url: string) => Promise<FetchResult>;
export interface CheckOptions { trigger: 'scheduled' | 'manual' | 'retry'; userId?: string | null; fetcher?: Fetcher; now?: () => Date; skipRateWait?: boolean }
export interface CheckResult {
  runId: string; status: 'ok' | 'review' | 'error'; error?: string; observationId?: string;
  extracted?: Extracted; reasons: { code: string; message: string }[]; checkedAt: string;
  unitPrice?: { value: string; per: string } | null; httpStatus?: number;
}

export const PRICE_JUMP_THRESHOLD = new Decimal(process.env.PRICE_JUMP_THRESHOLD ?? '0.40');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function raiseAlert(db: Pool, orgId: string, type: string, refType: string, refId: string, message: string, severity = 'warning') {
  await db.query(
    `INSERT INTO alerts(org_id,type,severity,ref_type,ref_id,message) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (org_id,type,ref_id) WHERE status='open' DO UPDATE SET message=EXCLUDED.message`,
    [orgId, type, severity, refType, refId, message],
  );
}
async function resolveAlerts(db: Pool, type: string, refId: string) {
  await db.query(`UPDATE alerts SET status='resolved', resolved_at=now() WHERE type=$1 AND ref_id=$2 AND status='open'`, [type, refId]);
}

export async function runCheck(db: Pool, trackedUrlId: string, opts: CheckOptions): Promise<CheckResult> {
  const now = opts.now ?? (() => new Date());
  const { rows } = await db.query(
    `SELECT t.*, s.adapter_key, s.config AS source_config, s.min_interval_ms, s.check_interval_minutes, s.name AS source_name,
            cp.title AS cp_title, cp.attrs AS cp_attrs
       FROM tracked_urls t JOIN sources s ON s.id=t.source_id JOIN competitor_products cp ON cp.id=t.competitor_product_id
      WHERE t.id=$1`, [trackedUrlId]);
  if (!rows.length) throw new Error('İzlenen URL bulunamadı');
  const t = rows[0];
  const orgId: string = t.org_id;

  const run = await db.query(
    `INSERT INTO scrape_runs(org_id,tracked_url_id,url,trigger,triggered_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [orgId, t.id, t.url, opts.trigger, opts.userId ?? null]);
  const runId: string = run.rows[0].id;

  // Kaynağa istekler arası en az min_interval_ms: atomik "slot" ayırma.
  if (!opts.skipRateWait) {
    const slot = await db.query(
      `UPDATE sources SET last_attempt_at = GREATEST(now(), COALESCE(last_attempt_at, 'epoch'::timestamptz) + ($2 || ' milliseconds')::interval)
        WHERE id=$1 RETURNING last_attempt_at, now() AS n`, [t.source_id, String(t.min_interval_ms)]);
    const wait = new Date(slot.rows[0].last_attempt_at).getTime() - new Date(slot.rows[0].n).getTime();
    if (wait > 0) await sleep(Math.min(wait, 30000));
  } else {
    await db.query('UPDATE sources SET last_attempt_at=now() WHERE id=$1', [t.source_id]);
  }
  await db.query('UPDATE tracked_urls SET last_attempt_at=now() WHERE id=$1', [t.id]);

  const fail = async (message: string, httpStatus?: number, structural = false): Promise<CheckResult> => {
    const failures = (t.consecutive_failures ?? 0) + 1;
    const backoffMin = Math.min(t.check_interval_minutes, 15 * 2 ** Math.min(failures - 1, 6));
    await db.query(`UPDATE scrape_runs SET status='error', error=$2, http_status=$3, finished_at=now() WHERE id=$1`, [runId, message, httpStatus ?? null]);
    await db.query(
      `UPDATE tracked_urls SET last_status='error', last_error=$2, consecutive_failures=$3, next_check_at=now() + ($4 || ' minutes')::interval WHERE id=$1`,
      [t.id, message, failures, String(backoffMin)]);
    if (failures >= 3 || structural) {
      await raiseAlert(db, orgId, 'scrape_failing', 'tracked_url', t.id,
        structural ? `Sayfa yapısı değişmiş olabilir: ${message}` : `${failures} kez üst üste toplama hatası: ${message}`, 'critical');
    }
    return { runId, status: 'error', error: message, reasons: [], checkedAt: now().toISOString(), httpStatus };
  };

  let res: FetchResult;
  try {
    res = await (opts.fetcher ?? ((u) => safeFetch(u)))(t.url);
  } catch (e: any) {
    return fail(e instanceof UrlBlockedError ? `URL engellendi: ${e.message}` : `İstek başarısız: ${e.message ?? e}`);
  }
  if (res.status < 200 || res.status >= 300) {
    const hint = res.status === 404 || res.status === 410 ? ' Sayfa bulunamadı: ürün kaldırılmış veya URL değişmiş olabilir; adresi tarayıcıda kontrol edin, gerekirse URL’yi düzenleyin.'
      : [429, 503, 508, 509].includes(res.status) ? ' Site hatası (siteden geliyor, geçici olabilir; sayfa tarayıcıda da hata veriyorsa sorun sitededir). Otomatik olarak daha sonra yeniden denenecek; kaynak yavaşlatıldı.' : '';
    if ([429, 503, 508, 509].includes(res.status)) {
      // Siteyi zorlamamak için: aynı kaynağın yakın vadeli diğer kontrolleri 10 dk ertelenir.
      await db.query(`UPDATE tracked_urls SET next_check_at = now() + interval '10 minutes' WHERE source_id=$1 AND id<>$2 AND active AND next_check_at < now() + interval '10 minutes'`, [t.source_id, t.id]);
    }
    return fail(`Sunucu ${res.status} durum kodu döndürdü.${hint}`, res.status);
  }

  const adapter = getAdapter(t.adapter_key);
  const cfg = { ...(t.source_config ?? {}), ...(t.extraction ?? {}) };
  let ex: Extracted;
  try { ex = adapter.extract(res.body, cfg); } catch (e: any) { return fail(`Sayfa ayrıştırılamadı: ${e.message}`, res.status, true); }
  if (!ex.salePrice || !ex.title) {
    return fail('Fiyat veya ürün adı bulunamadı; sayfa yapısı değişmiş olabilir. Eski fiyat yeni gözlem olarak kaydedilmedi.', res.status, true);
  }

  // ---- gramaj kararı: onaylı düzeltme > sayfa > elle girilen beklenen paket
  const at = now();
  const ov = await db.query(
    `SELECT * FROM qty_overrides WHERE tracked_url_id=$1 AND status='approved' AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2) ORDER BY valid_from DESC LIMIT 1`, [t.id, at]);
  const expected = t.cp_attrs?.pack_qty && t.cp_attrs?.pack_unit ? { qty: String(t.cp_attrs.pack_qty), unit: String(t.cp_attrs.pack_unit) } : null;
  let qty: { qty: string; unit: string } | null = null; let qtySource: string | null = null;
  const reasons: { code: string; message: string }[] = [];
  if (ov.rowCount) { qty = { qty: ov.rows[0].pack_qty, unit: ov.rows[0].pack_unit }; qtySource = 'override'; }
  else if (ex.packQty && ex.packUnit) { qty = { qty: ex.packQty, unit: ex.packUnit }; qtySource = 'page'; }
  else if (expected) { qty = expected; qtySource = 'manual'; }

  const sale = new Decimal(ex.salePrice);
  let quality: 'ok' | 'review' | 'invalid' = 'ok';
  if (sale.lte(0)) { quality = 'invalid'; reasons.push({ code: 'invalid_price', message: 'Fiyat geçersiz (sıfır veya negatif).' }); }

  const base = qty ? toBase(qty.qty, qty.unit) : null;
  if (!qty) { quality = quality === 'invalid' ? quality : 'review'; reasons.push({ code: 'qty_unknown', message: 'Gramaj sayfadan okunamadı; kilogram kıyasına dahil edilmedi.' }); }
  else if (!base) { quality = quality === 'invalid' ? quality : 'review'; reasons.push({ code: 'qty_unknown', message: 'Adet bazlı ürünün gramajı bilinmiyor; kg fiyatıyla kıyaslanamaz.' }); }

  if (qtySource === 'page' && expected) {
    const eb = toBase(expected.qty, expected.unit);
    if (base && eb && (eb.unit !== base.unit || !eb.qty.eq(base.qty))) {
      quality = quality === 'invalid' ? quality : 'review';
      reasons.push({ code: 'qty_conflict', message: `Sayfadaki gramaj (${ex.packQty} ${ex.packUnit}) kayıtlı gramajla (${expected.qty} ${expected.unit}) çelişiyor.` });
    }
  }
  const mm = findMismatches({ title: t.cp_title }, { title: ex.title }).filter((m) => m.severity === 'high' && m.field !== 'Paket gramajı');
  if (mm.length) {
    quality = quality === 'invalid' ? quality : 'review';
    reasons.push({ code: 'content_mismatch', message: `Sayfadaki ürün kayıtlı ürünle uyuşmuyor: ${mm.map((m) => `${m.field} (${m.ours} ≠ ${m.theirs})`).join(', ')}` });
  }
  // eşleşmiş Ragyu varyantlarının birim ailesi ile çelişki
  if (base) {
    const fam = await db.query(
      `SELECT DISTINCT v.pack_unit FROM product_links l JOIN product_variants v ON v.id=l.variant_id
        WHERE l.competitor_product_id=$1 AND l.status IN ('approved','review','suggested')`, [t.competitor_product_id]);
    for (const r of fam.rows) {
      const vb = toBase(1, r.pack_unit);
      if (vb && vb.unit !== base.unit) { quality = quality === 'invalid' ? quality : 'review'; reasons.push({ code: 'unit_family', message: `Rakip ürün ${base.unit} bazlı, Ragyu varyantı ${vb.unit} bazlı.` }); break; }
    }
  }
  const up = base && sale.gt(0) && qty ? unitPrice(sale, qty.qty, qty.unit) : null;

  // fiyat sıçraması: bir önceki geçerli gözlemin birim fiyatına (yoksa paket fiyatına) göre
  const prev = await db.query(
    `SELECT sale_price, unit_price FROM price_observations WHERE tracked_url_id=$1 AND quality='ok' ORDER BY observed_at DESC LIMIT 1`, [t.id]);
  if (prev.rowCount) {
    const p = up && prev.rows[0].unit_price ? new Decimal(prev.rows[0].unit_price) : new Decimal(prev.rows[0].sale_price);
    const c = up && prev.rows[0].unit_price ? up.value : sale;
    if (p.gt(0) && c.minus(p).abs().div(p).gt(PRICE_JUMP_THRESHOLD)) {
      quality = quality === 'invalid' ? quality : 'review';
      reasons.push({ code: 'price_jump', message: `Beklenmedik fiyat sıçraması: ${p.toDecimalPlaces(2)} → ${c.toDecimalPlaces(2)} (eşik %${PRICE_JUMP_THRESHOLD.mul(100)}).` });
    }
  }

  const obs = await db.query(
    `INSERT INTO price_observations(org_id,tracked_url_id,competitor_product_id,scrape_run_id,url,observed_at,list_price,sale_price,currency,
        pack_qty,pack_unit,qty_source,base_qty,base_unit,unit_price,in_stock,campaign,shipping_fee,multibuy_min,product_title,quality,quality_reasons,raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`,
    [orgId, t.id, t.competitor_product_id, runId, t.url, at, ex.listPrice, ex.salePrice, ex.currency ?? 'TRY',
      qty?.qty ?? null, qty?.unit ?? null, qtySource, base?.qty.toString() ?? null, base?.unit ?? null, up?.value.toString() ?? null,
      ex.inStock, ex.campaign, ex.shippingFee, ex.multibuyMin, ex.title, quality, JSON.stringify(reasons), JSON.stringify({ method: ex.method, extracted: ex })]);
  const obsId: string = obs.rows[0].id;

  if (!expected && qty && qtySource === 'page') {
    await db.query(`UPDATE competitor_products SET attrs = attrs || $2::jsonb WHERE id=$1`, [t.competitor_product_id, JSON.stringify({ pack_qty: qty.qty, pack_unit: qty.unit })]);
  }
  const status = quality === 'ok' ? 'ok' : 'review';
  await db.query(`UPDATE scrape_runs SET status=$2, finished_at=now(), http_status=$3, extracted=$4 WHERE id=$1`, [runId, status, res.status, JSON.stringify({ ...ex, reasons })]);
  await db.query(
    `UPDATE tracked_urls SET last_status=$2, last_error=NULL, last_success_at=now(), consecutive_failures=0,
        next_check_at=now() + ($3 || ' minutes')::interval WHERE id=$1`, [t.id, status, String(t.check_interval_minutes)]);
  await db.query('UPDATE sources SET last_success_at=now() WHERE id=$1', [t.source_id]);
  await resolveAlerts(db, 'scrape_failing', t.id);

  const typeOf: Record<string, string> = { qty_unknown: 'qty_doubt', qty_conflict: 'qty_doubt', price_jump: 'price_jump', content_mismatch: 'content_mismatch', unit_family: 'match_issue' };
  for (const r of reasons) {
    if (typeOf[r.code]) await raiseAlert(db, orgId, typeOf[r.code], r.code === 'price_jump' ? 'observation' : 'tracked_url', r.code === 'price_jump' ? obsId : t.id, `${t.source_name}: ${r.message}`);
  }
  return { runId, status, observationId: obsId, extracted: ex, reasons, checkedAt: at.toISOString(), unitPrice: up ? { value: up.value.toString(), per: up.per } : null, httpStatus: res.status };
}

/** Zamanı gelen URL'leri seçer ve "kira" (lease) koyar; çift kuyruklamayı önler. */
export async function claimDue(db: Pool, limit = 50): Promise<{ id: string }[]> {
  const { rows } = await db.query(
    `UPDATE tracked_urls SET next_check_at = now() + interval '10 minutes'
      WHERE id IN (SELECT t.id FROM tracked_urls t JOIN sources s ON s.id=t.source_id
                    WHERE t.active AND s.active AND t.next_check_at <= now()
                    ORDER BY t.next_check_at LIMIT $1 FOR UPDATE OF t SKIP LOCKED)
      RETURNING id`, [limit]);
  return rows;
}

/** Güncel olmayan kaynaklar için uyarı üretir / kapatır. */
export async function refreshStaleAlerts(db: Pool): Promise<number> {
  const { rows } = await db.query(
    `SELECT id, org_id, name, last_success_at, stale_after_hours FROM sources WHERE active`);
  let n = 0;
  for (const s of rows) {
    const stale = !s.last_success_at || Date.now() - new Date(s.last_success_at).getTime() > s.stale_after_hours * 3600_000;
    if (stale) { await raiseAlert(db, s.org_id, 'stale_source', 'source', s.id, `${s.name}: ${s.stale_after_hours} saatten uzun süredir başarılı veri alınamadı; fiyatlar güncel değil.`, 'critical'); n++; }
    else await resolveAlerts(db, 'stale_source', s.id);
  }
  return n;
}
