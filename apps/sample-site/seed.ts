/**
 * Demo verisi: katalog (data/ornek-katalog.csv), 3 DEMO rakip kaynağı ve izlenen URL'ler.
 * Kullanıcı OLUŞTURMAZ (varsayılan şifre yok). Rakip verileri gerçek değildir; yerel demo sitesinden gelir.
 */
import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import { getPool, migrate, closePool, extractAttrs, parseQtyFromText, runCheck } from '@ragyu/core';
import { SITES, demoCatalog, urlFor } from './server';

export async function seedDemo(opts: { runChecks?: boolean; port?: number; csv?: string } = {}) {
  const db = getPool(); await migrate(db);
  let org = (await db.query('SELECT id FROM organizations ORDER BY created_at LIMIT 1')).rows[0];
  if (!org) org = (await db.query(`INSERT INTO organizations(name,slug) VALUES ('Ragyu Kasap+','ragyu') RETURNING id`)).rows[0];
  const orgId: string = org.id;
  const csv = opts.csv ?? path.resolve(__dirname, '../../data/ornek-katalog.csv');
  const lines = fs.readFileSync(csv, 'utf8').trim().split('\n').slice(1).map((l) => l.split(';'));
  const variantBySku = new Map<string, string>();
  let i = 0;
  for (const [sku, name, brand, price] of lines) {
    const a = extractAttrs(name);
    const category = a.processing && ['sucuk', 'salam', 'sosis', 'pastırma', 'füme', 'kavurma'].includes(a.processing) ? 'Şarküteri' : /köfte|kıyma/i.test(name) ? 'Kıyma & Köfte' : a.species === 'kuzu' || /kuzu/i.test(name) ? 'Kuzu' : /wagyu/i.test(name) ? 'Wagyu' : 'Dana';
    const p = (await db.query(`INSERT INTO products(org_id,code,name,category,brand,attrs,source) VALUES ($1,$2,$3,$4,$5,$6,'demo') ON CONFLICT (org_id, lower(code)) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [orgId, sku, name.trim(), category, brand, JSON.stringify({ species: a.species, cut: a.cut, processing: a.processing, bone: a.bone, state: a.state })])).rows[0];
    // Excel'de gramaj sütunu yok: demo varsayımı — ilk 30 ürün 500 g paket (fiyat/2), diğerleri 1 kg.
    const half = i < 30; const P = Number(price) || 0;
    const v = (await db.query(`INSERT INTO product_variants(org_id,product_id,sku,pack_qty,pack_unit,price,source) VALUES ($1,$2,$3,$4,$5,$6,'demo') ON CONFLICT (org_id, lower(sku)) DO UPDATE SET price=EXCLUDED.price RETURNING id`,
      [orgId, p.id, sku, half ? 500 : 1, half ? 'g' : 'kg', P > 0 ? new Decimal(P).div(half ? 2 : 1).toString() : null])).rows[0];
    if (P > 0) await db.query(`INSERT INTO own_price_history(org_id,variant_id,price,valid_from) SELECT $1,$2,$3, now() - interval '30 days' WHERE NOT EXISTS (SELECT 1 FROM own_price_history WHERE variant_id=$2)`, [orgId, v.id, new Decimal(P).div(half ? 2 : 1).toString()]);
    variantBySku.set(sku, v.id); i++;
  }
  const cat = demoCatalog(csv);
  const trackedIds: string[] = [];
  for (const [host, cfg] of Object.entries(SITES)) {
    let src = (await db.query('SELECT id FROM sources WHERE org_id=$1 AND lower(domain)=$2', [orgId, host])).rows[0];
    if (!src) src = (await db.query(`INSERT INTO sources(org_id,name,domain,adapter_key,min_interval_ms) VALUES ($1,$2,$3,$4,300) RETURNING id`, [orgId, `${cfg.name} (demo)`, host, cfg.style === 'html' ? 'ornek-market' : 'generic-html'])).rows[0];
    let n = 0;
    for (const it of cat[host]) {
      const url = urlFor(host, it.slug, opts.port ?? 4100);
      const ex = (await db.query('SELECT 1 FROM tracked_urls WHERE org_id=$1 AND url=$2', [orgId, url])).rowCount; if (ex) continue;
      const q = parseQtyFromText(it.title);
      const cp = (await db.query(`INSERT INTO competitor_products(org_id,source_id,title,brand,url,attrs,discovered_by) VALUES ($1,$2,$3,$4,$5,$6,'auto') RETURNING id`, [orgId, src.id, it.title, it.brand, url, JSON.stringify(q ? { pack_qty: q.qty.toString(), pack_unit: q.unit } : {})])).rows[0];
      const t = (await db.query(`INSERT INTO tracked_urls(org_id,source_id,competitor_product_id,url,origin) VALUES ($1,$2,$3,$4,'auto') RETURNING id`, [orgId, src.id, cp.id, url])).rows[0];
      trackedIds.push(t.id);
      n++;
      if (n % 9 === 0) continue; // eşleşmemiş rakip ürün: çalışma kuyruğunda görünür
      const status = n % 7 === 0 ? 'suggested' : n % 5 === 0 ? 'review' : 'approved';
      await db.query(`INSERT INTO product_links(org_id,variant_id,competitor_product_id,status,origin,score,note) VALUES ($1,$2,$3,$4,'auto',$5,'Demo verisi') ON CONFLICT DO NOTHING`, [orgId, variantBySku.get(it.sku), cp.id, status, status === 'approved' ? null : 0.62]);
      // geçmiş (DEMO geri doldurma): iki eski gözlem
      if (q) for (const [days, f] of [[10, 1.04], [4, 0.98]] as const) {
        const sale = new Decimal(it.price).mul(f).toDecimalPlaces(2); const base = new Decimal(q.qty).mul(q.unit === 'kg' ? 1000 : 1);
        await db.query(`INSERT INTO price_observations(org_id,tracked_url_id,competitor_product_id,url,observed_at,sale_price,pack_qty,pack_unit,qty_source,base_qty,base_unit,unit_price,in_stock,quality,raw) VALUES ($1,$2,$3,$4, now() - ($5 || ' days')::interval,$6,$7,$8,'page',$9,'g',$10,true,'ok','{"method":"demo-backfill"}')`,
          [orgId, t.id, cp.id, url, String(days), sale.toString(), q.qty.toString(), q.unit, base.toString(), sale.div(base.div(1000)).toString()]);
      }
    }
    console.log(`${cfg.name}: ${n} yeni URL`);
  }
  if (opts.runChecks) for (const id of trackedIds) await runCheck(db, id, { trigger: 'scheduled', skipRateWait: true });
  return { products: lines.length, tracked: trackedIds.length };
}

if (require.main === module) {
  seedDemo({ runChecks: process.env.SEED_RUN_CHECKS === 'true' }).then((r) => { console.log('Demo verisi hazır:', r); return closePool(); }).catch((e) => { console.error(e); process.exit(1); });
}
