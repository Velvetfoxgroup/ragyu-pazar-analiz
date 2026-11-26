import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { can, validateUrlSyntax, UrlBlockedError, findMismatches, similarity, parseQtyFromText, tx, listAdapters } from '@ragyu/core';
import { DB, Perm, CurrentUser, AuthUser, parse, httpErr, auditFrom, QueueService } from './infra';

const unit = z.enum(['g', 'kg', 'ml', 'l', 'adet']);
const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, '');

function checkUrl(raw: string): URL {
  try { return validateUrlSyntax(raw); } catch (e) { if (e instanceof UrlBlockedError) throw httpErr(400, e.message, 'url_blocked'); throw e; }
}

@Controller('api')
export class CompetitorsController {
  constructor(@Inject(DB) private db: Pool, @Inject(QueueService) private queue: QueueService) {}

  // ------------------------------------------------------------ kaynaklar (rakip siteler)
  @Get('sources')
  async sources(@CurrentUser() u: AuthUser) {
    const r = await this.db.query(
      `SELECT s.*, (SELECT count(*)::int FROM tracked_urls t WHERE t.source_id=s.id AND t.active) AS active_urls,
              (SELECT count(*)::int FROM tracked_urls t WHERE t.source_id=s.id AND t.active AND t.last_status='error') AS failing_urls,
              (SELECT count(*)::int FROM competitor_products c WHERE c.source_id=s.id) AS product_count
         FROM sources s WHERE s.org_id=$1 ORDER BY lower(s.name)`, [u.orgId]);
    const now = Date.now();
    return { adapters: listAdapters(), sources: r.rows.map((s) => {
      const age = s.last_success_at ? (now - new Date(s.last_success_at).getTime()) / 3600_000 : null;
      return { ...s, freshness: !s.active ? 'inactive' : age === null ? 'never' : age > s.stale_after_hours ? 'stale' : 'fresh', ageHours: age };
    }) };
  }

  @Perm('source:manage') @Post('sources')
  async createSource(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().min(2).max(80), domain: z.string().min(3).max(120), adapterKey: z.string().default('generic-html'), config: z.record(z.any()).default({}), checkIntervalMinutes: z.number().int().min(5).max(10080).default(360), staleAfterHours: z.number().int().min(1).max(720).default(48), minIntervalMs: z.number().int().min(500).max(60000).default(2000) }), body);
    const domain = b.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    const r = await this.db.query(`INSERT INTO sources(org_id,name,domain,adapter_key,config,check_interval_minutes,stale_after_hours,min_interval_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (org_id, lower(domain)) DO NOTHING RETURNING id`, [u.orgId, b.name, domain, b.adapterKey, JSON.stringify(b.config), b.checkIntervalMinutes, b.staleAfterHours, b.minIntervalMs]);
    if (!r.rowCount) throw httpErr(409, 'Bu alan adı zaten tanımlı.', 'duplicate');
    await auditFrom(this.db, u, 'source.created', 'source', r.rows[0].id, { domain });
    return { id: r.rows[0].id };
  }

  @Perm('source:manage') @Patch('sources/:id')
  async updateSource(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ name: z.string().optional(), adapterKey: z.string().optional(), config: z.record(z.any()).optional(), active: z.boolean().optional(), checkIntervalMinutes: z.number().int().min(5).optional(), staleAfterHours: z.number().int().min(1).optional(), minIntervalMs: z.number().int().min(500).optional() }), body);
    const r = await this.db.query(`UPDATE sources SET name=COALESCE($3,name), adapter_key=COALESCE($4,adapter_key), config=COALESCE($5::jsonb,config), active=COALESCE($6,active), check_interval_minutes=COALESCE($7,check_interval_minutes), stale_after_hours=COALESCE($8,stale_after_hours), min_interval_ms=COALESCE($9,min_interval_ms) WHERE id=$1 AND org_id=$2 RETURNING id`,
      [id, u.orgId, b.name ?? null, b.adapterKey ?? null, b.config ? JSON.stringify(b.config) : null, b.active ?? null, b.checkIntervalMinutes ?? null, b.staleAfterHours ?? null, b.minIntervalMs ?? null]);
    if (!r.rowCount) throw httpErr(404, 'Kaynak bulunamadı.', 'not_found');
    await auditFrom(this.db, u, 'source.updated', 'source', id, b);
    return { ok: true };
  }

  // ------------------------------------------------------------ manuel rakip URL'si
  @Perm('url:write') @Post('variants/:variantId/urls')
  async addUrl(@CurrentUser() u: AuthUser, @Param('variantId') variantId: string, @Body() body: unknown) {
    const b = parse(z.object({ url: z.string().min(8).max(2000), title: z.string().max(200).optional(), expectedQty: z.coerce.number().positive().optional(), expectedUnit: unit.optional(), note: z.string().max(500).optional() }), body);
    const url = checkUrl(b.url);
    const v = (await this.db.query(`SELECT v.*, p.name AS product_name, p.attrs AS p_attrs, p.brand FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.org_id=$2`, [variantId, u.orgId])).rows[0];
    if (!v) throw httpErr(404, 'Varyant bulunamadı.', 'not_found');
    const dupe = await this.db.query(`SELECT 1 FROM tracked_urls t JOIN product_links l ON l.competitor_product_id=t.competitor_product_id WHERE t.org_id=$1 AND t.active AND t.url=$2 AND l.variant_id=$3`, [u.orgId, url.toString(), variantId]);
    if (dupe.rowCount) throw httpErr(409, 'Bu URL bu ürün için zaten izleniyor.', 'duplicate');
    const res = await tx(this.db, async (c) => {
      const domain = hostOf(url);
      let src = (await c.query(`SELECT id FROM sources WHERE org_id=$1 AND lower(domain) IN ($2,$3)`, [u.orgId, domain, 'www.' + domain])).rows[0];
      let createdSource = false;
      if (!src) { src = (await c.query(`INSERT INTO sources(org_id,name,domain,adapter_key) VALUES ($1,$2,$3,'generic-html') RETURNING id`, [u.orgId, domain, domain])).rows[0]; createdSource = true; }
      const attrs: any = {}; const q = b.expectedQty && b.expectedUnit ? { qty: b.expectedQty, unit: b.expectedUnit } : null;
      if (q) { attrs.pack_qty = String(q.qty); attrs.pack_unit = q.unit; }
      const title = b.title?.trim() || decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? domain).replace(/[-_]+/g, ' ');
      const cp = (await c.query(`INSERT INTO competitor_products(org_id,source_id,title,url,attrs,discovered_by) VALUES ($1,$2,$3,$4,$5,'manual') RETURNING id`, [u.orgId, src.id, title, url.toString(), JSON.stringify(attrs)])).rows[0];
      const mm = findMismatches({ title: v.product_name, brand: v.brand, attrs: v.p_attrs, packQty: v.pack_qty, packUnit: v.pack_unit }, { title, packQty: q?.qty ?? null, packUnit: q?.unit ?? null });
      // Elle girilen eşleşme de onay akışından geçer; onay yetkisi olan kullanıcı doğrudan onaylayabilir.
      const approve = can(u.role, 'match:approve');
      const link = (await c.query(`INSERT INTO product_links(org_id,variant_id,competitor_product_id,status,origin,mismatches,note,created_by,reviewed_by,reviewed_at) VALUES ($1,$2,$3,$4,'manual',$5,$6,$7,$8,$9) RETURNING id`,
        [u.orgId, variantId, cp.id, approve ? 'approved' : 'review', JSON.stringify(mm), b.note ?? null, u.id, approve ? u.id : null, approve ? new Date() : null])).rows[0];
      const t = (await c.query(`INSERT INTO tracked_urls(org_id,source_id,competitor_product_id,url,origin,created_by) VALUES ($1,$2,$3,$4,'manual',$5) RETURNING id`, [u.orgId, src.id, cp.id, url.toString(), u.id])).rows[0];
      return { sourceId: src.id, createdSource, competitorProductId: cp.id, linkId: link.id, trackedUrlId: t.id, linkStatus: approve ? 'approved' : 'review', mismatches: mm };
    });
    await auditFrom(this.db, u, 'url.added', 'tracked_url', res.trackedUrlId, { url: url.toString(), variantId, linkStatus: res.linkStatus });
    return res;
  }

  @Perm('url:write') @Patch('urls/:id')
  async updateUrl(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ url: z.string().max(2000).optional(), active: z.boolean().optional(), extraction: z.record(z.any()).optional() }), body);
    const t = (await this.db.query('SELECT * FROM tracked_urls WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!t) throw httpErr(404, 'URL bulunamadı.', 'not_found');
    let newId: string | null = null;
    if (b.url && b.url !== t.url) {
      const nu = checkUrl(b.url).toString();
      // Eski satır ve gözlemleri korunur; yeni URL yeni kayıt olur, eskisi pasifleşir ve yenisine bağlanır.
      newId = await tx(this.db, async (c) => {
        const n = (await c.query(`INSERT INTO tracked_urls(org_id,source_id,competitor_product_id,url,origin,active,extraction,created_by) VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING id`,
          [u.orgId, t.source_id, t.competitor_product_id, nu, t.origin, JSON.stringify(b.extraction ?? t.extraction), u.id])).rows[0].id;
        await c.query(`UPDATE tracked_urls SET active=false, deactivated_at=now(), replaced_by=$2 WHERE id=$1`, [id, n]);
        await c.query(`UPDATE competitor_products SET url=$2 WHERE id=$1`, [t.competitor_product_id, nu]);
        return n;
      });
      await auditFrom(this.db, u, 'url.changed', 'tracked_url', newId!, { from: t.url, to: nu, previousId: id });
      return { ok: true, trackedUrlId: newId };
    }
    if (b.active !== undefined && b.active !== t.active) {
      await this.db.query(`UPDATE tracked_urls SET active=$2, deactivated_at=CASE WHEN $2 THEN NULL ELSE now() END, next_check_at=CASE WHEN $2 THEN now() ELSE next_check_at END WHERE id=$1`, [id, b.active]);
      await auditFrom(this.db, u, b.active ? 'url.activated' : 'url.deactivated', 'tracked_url', id, { url: t.url });
    }
    if (b.extraction) {
      await this.db.query('UPDATE tracked_urls SET extraction=$2 WHERE id=$1', [id, JSON.stringify(b.extraction)]);
      await auditFrom(this.db, u, 'url.extraction_changed', 'tracked_url', id, { extraction: b.extraction });
    }
    return { ok: true, trackedUrlId: id };
  }

  @Perm('check:run') @Post('urls/:id/check-now')
  async checkNow(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const t = (await this.db.query('SELECT 1 FROM tracked_urls WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!t) throw httpErr(404, 'URL bulunamadı.', 'not_found');
    await auditFrom(this.db, u, 'url.check_now', 'tracked_url', id, {});
    return this.queue.checkNow(id, u.id);
  }

  @Get('urls/:id/history')
  async history(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const t = (await this.db.query(`SELECT t.*, s.name AS source_name FROM tracked_urls t JOIN sources s ON s.id=t.source_id WHERE t.id=$1 AND t.org_id=$2`, [id, u.orgId])).rows[0];
    if (!t) throw httpErr(404, 'URL bulunamadı.', 'not_found');
    const runs = (await this.db.query(`SELECT id, url, trigger, started_at, finished_at, status, http_status, error, extracted FROM scrape_runs WHERE tracked_url_id=$1 ORDER BY started_at DESC LIMIT 50`, [id])).rows;
    // Aynı rakip ürünün tüm URL'lerinden gelen gözlemler: URL değişse de geçmiş görünür.
    const obs = (await this.db.query(`SELECT o.id, o.observed_at, o.url, o.tracked_url_id, o.scrape_run_id, o.sale_price, o.list_price, o.unit_price, o.pack_qty, o.pack_unit, o.qty_source, o.in_stock, o.quality, o.quality_reasons FROM price_observations o WHERE o.competitor_product_id=$1 ORDER BY o.observed_at DESC LIMIT 200`, [t.competitor_product_id])).rows;
    return { url: t, runs, observations: obs };
  }

  // ------------------------------------------------------------ gramaj düzeltmesi
  @Perm('gram:write') @Post('urls/:id/qty-override')
  async override(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ packQty: z.coerce.number().positive(), packUnit: unit, reason: z.string().min(3).max(300), validFrom: z.coerce.date().optional(), validTo: z.coerce.date().nullable().optional() }), body);
    const t = (await this.db.query('SELECT 1 FROM tracked_urls WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!t) throw httpErr(404, 'URL bulunamadı.', 'not_found');
    if (b.validTo && b.validFrom && b.validTo <= b.validFrom) throw httpErr(400, 'Bitiş tarihi başlangıçtan sonra olmalıdır.', 'bad_range');
    const auto = can(u.role, 'gram:approve');
    const r = await this.db.query(`INSERT INTO qty_overrides(org_id,tracked_url_id,pack_qty,pack_unit,reason,status,valid_from,valid_to,created_by,approved_by) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,now()),$8,$9,$10) RETURNING id, status`,
      [u.orgId, id, b.packQty, b.packUnit, b.reason, auto ? 'approved' : 'pending', b.validFrom ?? null, b.validTo ?? null, u.id, auto ? u.id : null]);
    await auditFrom(this.db, u, 'qty_override.created', 'qty_override', r.rows[0].id, { trackedUrlId: id, ...b, status: r.rows[0].status });
    return r.rows[0];
  }

  @Perm('gram:approve') @Post('qty-overrides/:id/:decision')
  async decideOverride(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('decision') decision: string) {
    if (!['approve', 'reject'].includes(decision)) throw httpErr(404, 'Bulunamadı.', 'not_found');
    const r = await this.db.query(`UPDATE qty_overrides SET status=$3, approved_by=$4 WHERE id=$1 AND org_id=$2 AND status='pending' RETURNING id`, [id, u.orgId, decision === 'approve' ? 'approved' : 'rejected', u.id]);
    if (!r.rowCount) throw httpErr(404, 'Bekleyen düzeltme bulunamadı.', 'not_found');
    await auditFrom(this.db, u, `qty_override.${decision}d`, 'qty_override', id, {});
    return { ok: true };
  }

  // ------------------------------------------------------------ eşleşmeler
  @Get('links')
  async links(@CurrentUser() u: AuthUser, @Query('status') status?: string) {
    const st = status ? status.split(',') : ['review', 'suggested'];
    const r = await this.db.query(
      `SELECT l.*, p.name AS product_name, p.code, v.sku, v.pack_qty, v.pack_unit, cp.title AS competitor_title, cp.url AS competitor_url, s.name AS source_name,
              ru.display_name AS reviewed_by_name,
              (SELECT unit_price FROM price_observations o WHERE o.competitor_product_id=cp.id ORDER BY observed_at DESC LIMIT 1) AS last_unit_price
         FROM product_links l JOIN product_variants v ON v.id=l.variant_id JOIN products p ON p.id=v.product_id
         JOIN competitor_products cp ON cp.id=l.competitor_product_id JOIN sources s ON s.id=cp.source_id LEFT JOIN users ru ON ru.id=l.reviewed_by
        WHERE l.org_id=$1 AND l.status = ANY($2) ORDER BY l.updated_at DESC LIMIT 500`, [u.orgId, st]);
    return r.rows;
  }

  @Perm('match:write') @Post('links')
  async createLink(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ variantId: z.string().uuid(), competitorProductId: z.string().uuid(), note: z.string().max(500).optional() }), body);
    const v = (await this.db.query(`SELECT v.*, p.name, p.brand, p.attrs FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.org_id=$2`, [b.variantId, u.orgId])).rows[0];
    const cp = (await this.db.query('SELECT * FROM competitor_products WHERE id=$1 AND org_id=$2', [b.competitorProductId, u.orgId])).rows[0];
    if (!v || !cp) throw httpErr(404, 'Ürün bulunamadı.', 'not_found');
    const mm = findMismatches({ title: v.name, brand: v.brand, attrs: v.attrs, packQty: v.pack_qty, packUnit: v.pack_unit }, { title: cp.title, brand: cp.brand, attrs: cp.attrs, packQty: cp.attrs?.pack_qty, packUnit: cp.attrs?.pack_unit });
    const r = await this.db.query(`INSERT INTO product_links(org_id,variant_id,competitor_product_id,status,origin,mismatches,note,created_by) VALUES ($1,$2,$3,'review','manual',$4,$5,$6)
      ON CONFLICT (variant_id,competitor_product_id) DO UPDATE SET status='review', mismatches=EXCLUDED.mismatches, updated_at=now() RETURNING id`, [u.orgId, b.variantId, b.competitorProductId, JSON.stringify(mm), b.note ?? null, u.id]);
    await auditFrom(this.db, u, 'link.created', 'link', r.rows[0].id, b);
    return { id: r.rows[0].id, mismatches: mm };
  }

  @Post('links/:id/status')
  async setStatus(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    if (!can(u.role, 'match:write') && !can(u.role, 'match:approve')) throw httpErr(403, 'Bu işlem için yetkiniz yok.', 'forbidden');
    const b = parse(z.object({ status: z.enum(['approved', 'rejected', 'invalidated', 'review']), note: z.string().max(500).optional() }), body);
    const l = (await this.db.query('SELECT * FROM product_links WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!l) throw httpErr(404, 'Eşleşme bulunamadı.', 'not_found');
    // Onay ve geçersiz kılma yalnızca onay yetkisi olanlarda; düzenleyici reddedebilir veya incelemeye alabilir.
    if ((b.status === 'approved' || b.status === 'invalidated') && !can(u.role, 'match:approve')) throw httpErr(403, 'Eşleşmeyi onaylama/geçersiz kılma yetkiniz yok.', 'forbidden');
    if (b.status === 'approved' && (l.mismatches as any[]).length && !b.note?.trim()) throw httpErr(400, 'Uyuşmazlık görünen eşleşmeyi onaylamak için gerekçe yazın.', 'note_required');
    await this.db.query(`UPDATE product_links SET status=$2, note=COALESCE($3,note), reviewed_by=$4, reviewed_at=now(), updated_at=now() WHERE id=$1`, [id, b.status, b.note ?? null, u.id]);
    await auditFrom(this.db, u, `link.${b.status}`, 'link', id, { from: l.status, note: b.note, mismatches: l.mismatches });
    return { ok: true };
  }

  /** Eşleşmeyi düzelt: başka bir Ragyu varyantına taşı; yeniden onay gerekir. */
  @Perm('match:write') @Post('links/:id/reassign')
  async reassign(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ variantId: z.string().uuid() }), body);
    const l = (await this.db.query('SELECT * FROM product_links WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    const v = (await this.db.query(`SELECT v.*, p.name, p.brand, p.attrs FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=$1 AND v.org_id=$2`, [b.variantId, u.orgId])).rows[0];
    if (!l || !v) throw httpErr(404, 'Kayıt bulunamadı.', 'not_found');
    const cp = (await this.db.query('SELECT * FROM competitor_products WHERE id=$1', [l.competitor_product_id])).rows[0];
    const mm = findMismatches({ title: v.name, brand: v.brand, attrs: v.attrs, packQty: v.pack_qty, packUnit: v.pack_unit }, { title: cp.title, brand: cp.brand, attrs: cp.attrs, packQty: cp.attrs?.pack_qty, packUnit: cp.attrs?.pack_unit });
    try {
      await this.db.query(`UPDATE product_links SET variant_id=$2, status='review', mismatches=$3, reviewed_by=NULL, reviewed_at=NULL, updated_at=now() WHERE id=$1`, [id, b.variantId, JSON.stringify(mm)]);
    } catch (e: any) { if (e.code === '23505') throw httpErr(409, 'Bu ürün için bu rakip eşleşmesi zaten var.', 'duplicate'); throw e; }
    await auditFrom(this.db, u, 'link.reassigned', 'link', id, { fromVariant: l.variant_id, toVariant: b.variantId });
    return { ok: true, mismatches: mm };
  }

  /** Eşleşmemiş rakip ürünleri için benzerlik tabanlı öneri üretir. Öneriler yalnızca "önerildi" olur; insan onayı gerekir. */
  @Perm('match:write') @Post('matching/suggest')
  async suggest(@CurrentUser() u: AuthUser) {
    const { rows: cps } = await this.db.query(`SELECT cp.* FROM competitor_products cp WHERE cp.org_id=$1 AND NOT EXISTS (SELECT 1 FROM product_links l WHERE l.competitor_product_id=cp.id)`, [u.orgId]);
    const { rows: vars } = await this.db.query(`SELECT v.id, v.pack_qty, v.pack_unit, p.name, p.brand, p.attrs FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.org_id=$1 AND v.active AND p.active`, [u.orgId]);
    let created = 0;
    for (const cp of cps) {
      const q = cp.attrs?.pack_qty ? { qty: cp.attrs.pack_qty, unit: cp.attrs.pack_unit } : parseQtyFromText(cp.title);
      const scored = vars.map((v) => ({ v, ...similarity({ title: v.name, brand: v.brand, attrs: v.attrs, packQty: v.pack_qty, packUnit: v.pack_unit }, { title: cp.title, brand: cp.brand, attrs: cp.attrs, packQty: q ? String(q.qty) : null, packUnit: q?.unit ?? null }) }))
        .filter((s) => s.score >= 0.35).sort((a, b) => b.score - a.score).slice(0, 3);
      for (const s of scored) {
        const r = await this.db.query(`INSERT INTO product_links(org_id,variant_id,competitor_product_id,status,origin,score,mismatches,created_by) VALUES ($1,$2,$3,'suggested','auto',$4,$5,$6) ON CONFLICT DO NOTHING`, [u.orgId, s.v.id, cp.id, s.score.toFixed(3), JSON.stringify(s.mismatches), u.id]);
        created += r.rowCount ?? 0;
      }
    }
    await auditFrom(this.db, u, 'matching.suggested', 'link', undefined, { created });
    return { created };
  }

  @Perm('catalog:write') @Post('competitor-products')
  async createCp(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ sourceId: z.string().uuid(), title: z.string().min(2), brand: z.string().optional(), url: z.string().optional(), packQty: z.coerce.number().positive().optional(), packUnit: unit.optional() }), body);
    const attrs = b.packQty && b.packUnit ? { pack_qty: String(b.packQty), pack_unit: b.packUnit } : {};
    const r = await this.db.query(`INSERT INTO competitor_products(org_id,source_id,title,brand,url,attrs,discovered_by) SELECT $1,s.id,$3,$4,$5,$6,'import' FROM sources s WHERE s.id=$2 AND s.org_id=$1 RETURNING id`, [u.orgId, b.sourceId, b.title, b.brand ?? null, b.url ?? null, JSON.stringify(attrs)]);
    if (!r.rowCount) throw httpErr(404, 'Kaynak bulunamadı.', 'not_found');
    return { id: r.rows[0].id };
  }
}
