import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { z } from 'zod';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import Decimal from 'decimal.js';
import type { Pool } from 'pg';
import { comparison, toXlsx, tx, UNITS, parsePrice, normalizeUnitToken, listAdapters, ROLE_LABELS, ROLES, POSITION_LABEL } from '@ragyu/core';
import { DB, Perm, CurrentUser, AuthUser, parse, httpErr, auditFrom } from './infra';
import { parseFilters } from './reports.controller';

const unit = z.enum(['g', 'kg', 'ml', 'l', 'adet']);
const attrs = z.object({ species: z.string().optional(), cut: z.string().optional(), processing: z.string().optional(), bone: z.enum(['kemikli', 'kemiksiz']).optional(), state: z.enum(['taze', 'donuk']).optional() }).partial();
const variantIn = z.object({ sku: z.string().min(1).max(60), packQty: z.coerce.number().positive(), packUnit: unit, price: z.coerce.number().nonnegative().nullable().optional(), barcode: z.string().max(40).nullable().optional() });
const productIn = z.object({ code: z.string().min(1).max(60), name: z.string().min(1).max(200), category: z.string().max(80).nullable().optional(), subcategory: z.string().max(80).nullable().optional(), brand: z.string().max(80).nullable().optional(), imageUrl: z.string().url().nullable().optional().or(z.literal('')), active: z.boolean().default(true), attrs: attrs.optional(), variants: z.array(variantIn).min(1) });

export async function setOwnPrice(db: any, orgId: string, variantId: string, price: Decimal.Value | null) {
  if (price === null) return;
  const cur = (await db.query('SELECT price FROM product_variants WHERE id=$1', [variantId])).rows[0];
  if (cur?.price !== null && cur?.price !== undefined && new Decimal(cur.price).eq(price)) return;
  await db.query('UPDATE product_variants SET price=$2, updated_at=now() WHERE id=$1', [variantId, new Decimal(price).toString()]);
  await db.query('INSERT INTO own_price_history(org_id,variant_id,price) VALUES ($1,$2,$3)', [orgId, variantId, new Decimal(price).toString()]);
}

const HEAD = ['kod', 'ad', 'kategori', 'alt_kategori', 'marka', 'gorsel_url', 'aktif', 'sku', 'paket_miktari', 'birim', 'fiyat_try', 'barkod'];
const ALIAS: Record<string, string[]> = {
  kod: ['kod', 'urun_kodu', 'urun_kod', 'code'], ad: ['ad', 'urun_adi', 'name', 'urun_ad'], kategori: ['kategori', 'category'], alt_kategori: ['alt_kategori', 'altkategori'],
  marka: ['marka', 'brand'], gorsel_url: ['gorsel_url', 'resim', 'gorsel'], aktif: ['aktif', 'durum'], sku: ['sku', 'varyant_sku'], paket_miktari: ['paket_miktari', 'gramaj', 'miktar'],
  birim: ['birim', 'paket_birimi', 'miktar_birimi'], fiyat_try: ['fiyat_try', 'fiyat', 'price', 'satis_fiyati'], barkod: ['barkod', 'gtin', 'barcode'],
};
const norm = (s: string) => String(s).toLocaleLowerCase('tr-TR').replace(/ı/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

async function readRows(file: { buffer: Buffer; originalname: string }): Promise<Record<string, any>[]> {
  let raw: any[][];
  if (/\.xlsx$/i.test(file.originalname)) {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(file.buffer as any);
    const ws = wb.worksheets[0];
    raw = []; ws.eachRow({ includeEmpty: false }, (row) => raw.push((row.values as any[]).slice(1).map((v) => (v && typeof v === 'object' && 'result' in v ? v.result : v && typeof v === 'object' && 'text' in v ? v.text : v))));
  } else {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    const delim = (text.split('\n')[0].match(/;/g)?.length ?? 0) > (text.split('\n')[0].match(/,/g)?.length ?? 0) ? ';' : ',';
    raw = parseCsv(text, { delimiter: delim, relax_column_count: true, skip_empty_lines: true });
  }
  if (!raw.length) return [];
  const headers = raw[0].map((h) => norm(String(h ?? '')));
  const map: Record<string, number> = {};
  for (const [k, aliases] of Object.entries(ALIAS)) { const i = headers.findIndex((h) => aliases.includes(h)); if (i >= 0) map[k] = i; }
  return raw.slice(1).map((r, idx) => { const o: Record<string, any> = { __row: idx + 2 }; for (const [k, i] of Object.entries(map)) o[k] = r[i] === undefined || r[i] === null ? '' : r[i]; return o; });
}

@Controller('api')
export class CatalogController {
  constructor(@Inject(DB) private db: Pool) {}

  @Get('meta')
  meta(@CurrentUser() u: AuthUser) {
    return { units: UNITS, adapters: listAdapters(), roles: ROLES.map((k) => ({ key: k, label: ROLE_LABELS[k] })), positions: POSITION_LABEL, me: u.role };
  }

  @Get('categories')
  async categories(@CurrentUser() u: AuthUser) {
    return (await this.db.query(`SELECT DISTINCT category FROM products WHERE org_id=$1 AND category IS NOT NULL AND category<>'' ORDER BY 1`, [u.orgId])).rows.map((r) => r.category);
  }

  @Get('products')
  async list(@CurrentUser() u: AuthUser, @Query() q: Record<string, string>) {
    const rep = await comparison(this.db, u.orgId, parseFilters(q));
    let rows = rep.rows;
    if (q.position) { const set = new Set(q.position.split(',')); rows = rows.filter((r) => set.has(r.position.key)); }
    if (q.unmatched === '1') rows = rows.filter((r) => !r.offers.some((o) => o.linkStatus === 'approved'));
    const sort = q.sort ?? 'name'; const dir = q.dir === 'desc' ? -1 : 1;
    const key = (r: (typeof rows)[number]) => sort === 'ownUnitPrice' ? Number(r.ownUnitPrice ?? -1) : sort === 'min' ? Number(r.stats.min ?? 1e12) : sort === 'count' ? r.stats.count : sort === 'diffPct' ? Number(r.position.diffPct ?? -1e9) : r.name.toLocaleLowerCase('tr-TR');
    rows = [...rows].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    const page = Math.max(1, Number(q.page ?? 1)); const size = Math.min(200, Math.max(1, Number(q.pageSize ?? 25)));
    return { meta: rep.meta, total: rows.length, page, pageSize: size,
      rows: rows.slice((page - 1) * size, page * size).map((r) => ({ ...r, offers: undefined, offerCount: r.offers.length, eligibleCount: r.stats.count, pendingCount: r.offers.filter((o) => o.linkStatus !== 'approved').length })) };
  }

  @Get('products/:id')
  async detail(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const p = (await this.db.query('SELECT * FROM products WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!p) throw httpErr(404, 'Ürün bulunamadı.', 'not_found');
    const variants = (await this.db.query('SELECT * FROM product_variants WHERE product_id=$1 ORDER BY pack_qty', [id])).rows;
    const out = [];
    for (const v of variants) {
      const rep = await comparison(this.db, u.orgId, { variantId: v.id, stock: 'all' });
      const row = rep.rows[0];
      const urls = (await this.db.query(
        `SELECT t.*, s.name AS source_name, l.id AS link_id, l.status AS link_status,
                (SELECT json_agg(q ORDER BY q.created_at DESC) FROM (SELECT o.id, o.pack_qty, o.pack_unit, o.status, o.reason, o.valid_from, o.valid_to, o.created_at, cu.display_name AS created_by_name, au.display_name AS approved_by_name
                    FROM qty_overrides o LEFT JOIN users cu ON cu.id=o.created_by LEFT JOIN users au ON au.id=o.approved_by WHERE o.tracked_url_id=t.id) q) AS overrides
           FROM tracked_urls t JOIN sources s ON s.id=t.source_id
           JOIN product_links l ON l.competitor_product_id=t.competitor_product_id AND l.variant_id=$1 WHERE t.org_id=$2 ORDER BY t.active DESC, t.created_at DESC`, [v.id, u.orgId])).rows;
      const history = (await this.db.query(
        `SELECT o.id, o.observed_at, o.sale_price, o.unit_price, o.in_stock, o.quality, o.quality_reasons, o.url, o.scrape_run_id, o.tracked_url_id, o.pack_qty, o.pack_unit, o.qty_source, s.name AS source_name, cp.id AS competitor_product_id
           FROM price_observations o JOIN competitor_products cp ON cp.id=o.competitor_product_id JOIN sources s ON s.id=cp.source_id
          WHERE o.competitor_product_id IN (SELECT competitor_product_id FROM product_links WHERE variant_id=$1 AND status<>'rejected') ORDER BY o.observed_at DESC LIMIT 400`, [v.id])).rows;
      const own = (await this.db.query('SELECT price, valid_from FROM own_price_history WHERE variant_id=$1 ORDER BY valid_from DESC LIMIT 100', [v.id])).rows;
      out.push({ variant: v, comparison: row, urls, history, ownHistory: own });
    }
    return { product: p, variants: out };
  }

  @Perm('catalog:write') @Post('products')
  async create(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const b = parse(productIn, body);
    const id = await tx(this.db, async (c) => {
      const dup = await c.query('SELECT 1 FROM products WHERE org_id=$1 AND lower(code)=lower($2)', [u.orgId, b.code]);
      if (dup.rowCount) throw httpErr(409, 'Bu ürün kodu zaten var.', 'duplicate');
      const p = (await c.query(`INSERT INTO products(org_id,code,name,category,subcategory,brand,image_url,active,attrs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [u.orgId, b.code, b.name, b.category ?? null, b.subcategory ?? null, b.brand ?? null, b.imageUrl || null, b.active, JSON.stringify(b.attrs ?? {})])).rows[0];
      for (const v of b.variants) {
        const r = await c.query(`INSERT INTO product_variants(org_id,product_id,sku,pack_qty,pack_unit,barcode) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [u.orgId, p.id, v.sku, v.packQty, v.packUnit, v.barcode ?? null]);
        if (v.price !== undefined && v.price !== null) await setOwnPrice(c, u.orgId, r.rows[0].id, v.price);
      }
      return p.id;
    });
    await auditFrom(this.db, u, 'product.created', 'product', id, { code: b.code });
    return { id };
  }

  @Perm('catalog:write') @Patch('products/:id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(productIn.omit({ variants: true }).partial(), body);
    const r = await this.db.query(`UPDATE products SET name=COALESCE($3,name), category=COALESCE($4,category), subcategory=COALESCE($5,subcategory), brand=COALESCE($6,brand), image_url=COALESCE($7,image_url), active=COALESCE($8,active), attrs=COALESCE($9::jsonb,attrs), updated_at=now()
      WHERE id=$1 AND org_id=$2 RETURNING id`, [id, u.orgId, b.name ?? null, b.category ?? null, b.subcategory ?? null, b.brand ?? null, b.imageUrl || null, b.active ?? null, b.attrs ? JSON.stringify(b.attrs) : null]);
    if (!r.rowCount) throw httpErr(404, 'Ürün bulunamadı.', 'not_found');
    await auditFrom(this.db, u, 'product.updated', 'product', id, b);
    return { ok: true };
  }

  @Perm('catalog:write') @Post('products/:id/variants')
  async addVariant(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const v = parse(variantIn, body);
    const ok = await this.db.query('SELECT 1 FROM products WHERE id=$1 AND org_id=$2', [id, u.orgId]); if (!ok.rowCount) throw httpErr(404, 'Ürün bulunamadı.', 'not_found');
    const dup = await this.db.query('SELECT 1 FROM product_variants WHERE org_id=$1 AND lower(sku)=lower($2)', [u.orgId, v.sku]); if (dup.rowCount) throw httpErr(409, 'Bu SKU zaten var.', 'duplicate');
    const r = await this.db.query(`INSERT INTO product_variants(org_id,product_id,sku,pack_qty,pack_unit,barcode) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [u.orgId, id, v.sku, v.packQty, v.packUnit, v.barcode ?? null]);
    if (v.price !== undefined && v.price !== null) await setOwnPrice(this.db, u.orgId, r.rows[0].id, v.price);
    await auditFrom(this.db, u, 'variant.created', 'variant', r.rows[0].id, v);
    return { id: r.rows[0].id };
  }

  @Perm('catalog:write') @Patch('variants/:id')
  async updateVariant(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(variantIn.partial().extend({ active: z.boolean().optional() }), body);
    const cur = (await this.db.query('SELECT * FROM product_variants WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!cur) throw httpErr(404, 'Varyant bulunamadı.', 'not_found');
    await this.db.query(`UPDATE product_variants SET pack_qty=COALESCE($2,pack_qty), pack_unit=COALESCE($3,pack_unit), barcode=COALESCE($4,barcode), active=COALESCE($5,active), updated_at=now() WHERE id=$1`, [id, b.packQty ?? null, b.packUnit ?? null, b.barcode ?? null, b.active ?? null]);
    if (b.price !== undefined && b.price !== null) await setOwnPrice(this.db, u.orgId, id, b.price);
    await auditFrom(this.db, u, 'variant.updated', 'variant', id, b);
    return { ok: true };
  }

  // ---------------------------------------------------------------- içe/dışa aktarma
  @Get('catalog/template.:fmt')
  async template(@Param('fmt') fmt: string, @Res() res: any) {
    const sample = [
      ['RGY-001', 'Dana Antrikot', 'Dana', 'Biftek', 'Ragyu', '', 'evet', 'RGY-001-500', 500, 'g', '1375,00', ''],
      ['RGY-001', 'Dana Antrikot', 'Dana', 'Biftek', 'Ragyu', '', 'evet', 'RGY-001-1000', 1, 'kg', '2700,00', ''],
    ];
    if (fmt === 'xlsx') {
      const buf = await toXlsx('Katalog şablonu', ['Aynı ürün kodu birden fazla satırda ise her satır ayrı varyant (gramaj) olur.'], HEAD.map((h) => ({ header: h, key: h, width: 18 })), sample.map((r) => Object.fromEntries(HEAD.map((h, i) => [h, r[i]]))));
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="katalog-sablonu.xlsx"' }); return res.send(buf);
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="katalog-sablonu.csv"' });
    return res.send('﻿' + [HEAD, ...sample].map((r) => r.join(';')).join('\n'));
  }

  @Perm('catalog:write') @Post('catalog/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async import(@CurrentUser() u: AuthUser, @UploadedFile() file: any, @Query('defaultPack') defaultPack?: string, @Query('source') source = 'import') {
    if (!file) throw httpErr(400, 'Dosya yüklenmedi.', 'no_file');
    let rows: Record<string, any>[];
    try { rows = await readRows(file); } catch (e: any) { throw httpErr(400, `Dosya okunamadı: ${e.message}`, 'bad_file'); }
    const dp = defaultPack ? (() => { const m = defaultPack.match(/^([\d.,]+)\s*([a-zA-Z]+)$/); return m ? { qty: new Decimal(m[1].replace(',', '.')), unit: normalizeUnitToken(m[2]) } : null; })() : null;
    const errors: { row: number; message: string }[] = []; let ok = 0; const warnings: string[] = [];
    for (const r of rows) {
      try {
        const code = String(r.kod ?? r.sku ?? '').trim() || String(r.sku ?? '').trim(); const sku = String(r.sku ?? r.kod ?? '').trim();
        const name = String(r.ad ?? '').trim();
        if (!code) throw new Error('Ürün kodu (kod/SKU) boş.');
        if (!name) throw new Error('Ürün adı boş.');
        let qty: Decimal | null = null; let un = normalizeUnitToken(String(r.birim ?? ''));
        if (r.paket_miktari !== undefined && String(r.paket_miktari).trim() !== '') { qty = parsePrice(String(r.paket_miktari), { dotDecimal: true }); if (!qty || qty.lte(0)) throw new Error(`Paket miktarı geçersiz: "${r.paket_miktari}"`); if (!un) throw new Error('Birim boş veya tanınmıyor (g, kg, ml, l, adet).'); }
        else if (dp && dp.unit) { qty = dp.qty; un = dp.unit; if (!warnings.length) warnings.push(`Paket miktarı olmayan satırlar için varsayılan ${defaultPack} uygulandı. Gerçek gramajları doğrulayın.`); }
        else throw new Error('Paket miktarı boş (varsayılan gramaj da verilmedi).');
        let price: Decimal | null = null;
        if (r.fiyat_try !== undefined && String(r.fiyat_try).trim() !== '') { price = parsePrice(typeof r.fiyat_try === 'number' ? r.fiyat_try : String(r.fiyat_try)); if (!price || price.lt(0)) throw new Error(`Fiyat geçersiz: "${r.fiyat_try}"`); }
        const aktif = r.aktif === undefined || r.aktif === '' ? true : !/^(hayir|hayır|pasif|0|false|no)$/i.test(String(r.aktif).trim());
        await tx(this.db, async (c) => {
          let p = (await c.query('SELECT id FROM products WHERE org_id=$1 AND lower(code)=lower($2)', [u.orgId, code])).rows[0];
          if (p) await c.query(`UPDATE products SET name=$2, category=COALESCE(NULLIF($3,''),category), subcategory=COALESCE(NULLIF($4,''),subcategory), brand=COALESCE(NULLIF($5,''),brand), image_url=COALESCE(NULLIF($6,''),image_url), active=$7, updated_at=now() WHERE id=$1`,
            [p.id, name, r.kategori ?? '', r.alt_kategori ?? '', r.marka ?? '', r.gorsel_url ?? '', aktif]);
          else p = (await c.query(`INSERT INTO products(org_id,code,name,category,subcategory,brand,image_url,active,source) VALUES ($1,$2,$3,NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),NULLIF($7,''),$8,$9) RETURNING id`,
            [u.orgId, code, name, r.kategori ?? '', r.alt_kategori ?? '', r.marka ?? '', r.gorsel_url ?? '', aktif, source])).rows[0];
          let v = (await c.query('SELECT id FROM product_variants WHERE org_id=$1 AND lower(sku)=lower($2)', [u.orgId, sku])).rows[0];
          if (v) await c.query('UPDATE product_variants SET product_id=$2, pack_qty=$3, pack_unit=$4, barcode=COALESCE(NULLIF($5,\'\'),barcode), updated_at=now() WHERE id=$1', [v.id, p.id, qty!.toString(), un, String(r.barkod ?? '')]);
          else v = (await c.query(`INSERT INTO product_variants(org_id,product_id,sku,pack_qty,pack_unit,barcode,source) VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7) RETURNING id`, [u.orgId, p.id, sku, qty!.toString(), un, String(r.barkod ?? ''), source])).rows[0];
          if (price) await setOwnPrice(c, u.orgId, v.id, price);
        });
        ok++;
      } catch (e: any) { errors.push({ row: r.__row, message: e.message }); }
    }
    const run = (await this.db.query(`INSERT INTO import_runs(org_id,kind,file_name,total_rows,ok_rows,error_rows,errors,created_by) VALUES ($1,'products',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [u.orgId, file.originalname, rows.length, ok, errors.length, JSON.stringify(errors), u.id])).rows[0];
    await auditFrom(this.db, u, 'catalog.imported', 'import', run.id, { file: file.originalname, total: rows.length, ok, errors: errors.length });
    return { id: run.id, total: rows.length, ok, errorCount: errors.length, errors, warnings };
  }

  @Get('catalog/import/:id/errors.csv')
  async errorsCsv(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res() res: any) {
    const r = (await this.db.query('SELECT errors FROM import_runs WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!r) throw httpErr(404, 'İçe aktarma kaydı bulunamadı.', 'not_found');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="hata-raporu.csv"' });
    res.send('﻿satir;hata\n' + (r.errors as any[]).map((e) => `${e.row};"${String(e.message).replace(/"/g, '""')}"`).join('\n'));
  }

  @Get('catalog/export.xlsx')
  async export(@CurrentUser() u: AuthUser, @Res() res: any) {
    const { rows } = await this.db.query(`SELECT p.code, p.name, p.category, p.subcategory, p.brand, p.image_url, p.active, p.source, v.sku, v.pack_qty, v.pack_unit, v.price, v.barcode FROM products p JOIN product_variants v ON v.product_id=p.id WHERE p.org_id=$1 ORDER BY p.name, v.pack_qty`, [u.orgId]);
    const buf = await toXlsx('Katalog', [`Dışa aktarım: ${new Date().toLocaleString('tr-TR')}`], [
      { header: 'Kod', key: 'code' }, { header: 'Ad', key: 'name', width: 34 }, { header: 'Kategori', key: 'category' }, { header: 'Alt kategori', key: 'subcategory' }, { header: 'Marka', key: 'brand' }, { header: 'SKU', key: 'sku', width: 18 },
      { header: 'Paket miktarı', key: 'pack_qty' }, { header: 'Birim', key: 'pack_unit' }, { header: 'Fiyat (TRY)', key: 'price', fmt: 'try' }, { header: 'Barkod', key: 'barcode' }, { header: 'Aktif', key: 'active' }, { header: 'Kaynak', key: 'source' }], rows);
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="katalog.xlsx"' }); res.send(buf);
  }
}
