/**
 * Demo rakip verisini temizler: adı "(demo)" ile biten veya alan adı ".demo" olan kaynakları; bunlara bağlı rakip ürünleri,
 * eşleşmeleri, izlenen URL'leri, taramaları, gramaj düzeltmelerini, fiyat gözlemlerini ve uyarıları siler.
 * Katalog (ürünler, varyantlar, kendi fiyatlarınız), kullanıcılar ve gerçek kaynaklar DOKUNULMAZ.
 *   npm run demo:temizle              → ne silineceğini sayar (silmez)
 *   npm run demo:temizle -- --onayla  → siler (geri alınamaz; önce yedek alın)
 */
import { getPool, closePool, tx } from '../db';

async function main() {
  const db = getPool(); const confirm = process.argv.includes('--onayla');
  const demo = (await db.query(`SELECT id, name, domain FROM sources WHERE name ILIKE '% (demo)' OR domain ILIKE '%.demo'`)).rows;
  if (!demo.length) { console.log('Demo kaynağı yok; yapılacak bir şey yok.'); return closePool(); }
  const ids = demo.map((d: any) => d.id);
  const count = async (sql: string) => Number((await db.query(sql, [ids])).rows[0].n);
  const counts = {
    kaynak: demo.length,
    izlenenUrl: await count(`SELECT count(*) n FROM tracked_urls WHERE source_id = ANY($1)`),
    rakipUrun: await count(`SELECT count(*) n FROM competitor_products WHERE source_id = ANY($1)`),
    gozlem: await count(`SELECT count(*) n FROM price_observations WHERE competitor_product_id IN (SELECT id FROM competitor_products WHERE source_id = ANY($1))`),
  };
  console.log('Demo kaynakları:', demo.map((d: any) => d.domain).join(', ')); console.log('Silinecek kayıtlar:', counts);
  if (!confirm) { console.log('\nSilmek için: npm run demo:temizle -- --onayla'); return closePool(); }
  await tx(db, async (c) => {
    await c.query(`DELETE FROM alerts WHERE ref_id = ANY($1) OR ref_id IN (SELECT id FROM tracked_urls WHERE source_id = ANY($1)) OR ref_id IN (SELECT l.id FROM product_links l JOIN competitor_products cp ON cp.id=l.competitor_product_id WHERE cp.source_id = ANY($1)) OR ref_id IN (SELECT id FROM competitor_products WHERE source_id = ANY($1))`, [ids]);
    await c.query(`DELETE FROM price_observations WHERE competitor_product_id IN (SELECT id FROM competitor_products WHERE source_id = ANY($1))`, [ids]);
    await c.query(`UPDATE tracked_urls SET replaced_by = NULL WHERE source_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM competitor_products WHERE source_id = ANY($1)`, [ids]); // eşleşme, izlenen URL, tarama, gramaj düzeltmesi zincirleme silinir
    await c.query(`DELETE FROM sellers WHERE source_id = ANY($1)`, [ids]);
    await c.query(`DELETE FROM sources WHERE id = ANY($1)`, [ids]);
  });
  console.log('Demo verisi silindi.'); await closePool();
}
main().catch((e) => { console.error('Hata:', e.message); process.exit(1); });
