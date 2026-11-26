import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { getPool, closePool, migrate, runCheck, claimDue, refreshStaleAlerts, comparison, periodChange, worklist } from '@ragyu/core';
import { createApp } from '../apps/api/src/bootstrap';

const H = { 'X-Requested-With': 'ragyu' };
let app: any; let srv: http.Server; let base: string;
const pages = new Map<string, { status?: number; html: string }>();
const page = (price: string, title: string, extra = '') => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: title, offers: { price, priceCurrency: 'TRY', availability: 'https://schema.org/InStock' } })}</script><h1>${title}</h1>${extra}`;

const agent = () => request.agent(app.getHttpServer());
async function login(username: string, password: string) {
  const a = agent(); const r = await a.post('/api/auth/login').set(H).send({ username, password }); return { a, r };
}
const post = (a: any, url: string, body: any = {}) => a.post(url).set(H).send(body);
const patch = (a: any, url: string, body: any = {}) => a.patch(url).set(H).send(body);

let admin: any; let editor: any; let approver: any; let viewer: any;
let productId: string; let variantId: string;

beforeAll(async () => {
  const db = getPool(); await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db);
  srv = http.createServer((req, res) => { const p = pages.get(req.url ?? ''); if (!p) { res.statusCode = 404; return res.end('yok'); } res.statusCode = p.status ?? 200; res.setHeader('content-type', 'text/html'); res.end(p.html); });
  await new Promise<void>((r) => srv.listen(0, r)); base = `http://localhost:${(srv.address() as any).port}`;
  process.env.SCRAPER_ALLOW_HOSTS = `localhost,localhost:${(srv.address() as any).port}`;
  app = await createApp(); await app.init();
});
afterAll(async () => { await app?.close(); srv?.closeAllConnections?.(); srv?.close(); await closePool(); });

describe('G) Giriş, hesaplar ve yetkiler', () => {
  it('kurulum olmadan kullanıcı yok; yanlış anahtar reddedilir; ilk yönetici güvenli adımla oluşur; ikinci kurulum reddedilir', async () => {
    expect((await request(app.getHttpServer()).get('/api/setup/status')).body.needsSetup).toBe(true);
    expect((await request(app.getHttpServer()).post('/api/auth/login').set(H).send({ username: 'admin', password: 'admin' })).status).toBe(401);
    const bad = await request(app.getHttpServer()).post('/api/setup/admin').set(H).send({ token: 'yanlis-anahtar-yanlis', username: 'yonetici', displayName: 'Yönetici', password: 'Guclu-Parola-12' });
    expect(bad.status).toBe(403);
    const weak = await request(app.getHttpServer()).post('/api/setup/admin').set(H).send({ token: process.env.SETUP_TOKEN, username: 'yonetici', displayName: 'Yönetici', password: 'zayif' });
    expect(weak.status).toBe(400);
    const ok = await request(app.getHttpServer()).post('/api/setup/admin').set(H).send({ token: process.env.SETUP_TOKEN, username: 'yonetici', displayName: 'Yönetici', password: 'Guclu-Parola-12' });
    expect(ok.status).toBe(201);
    expect((await request(app.getHttpServer()).post('/api/setup/admin').set(H).send({ token: process.env.SETUP_TOKEN, username: 'ikinci', displayName: 'İkinci', password: 'Guclu-Parola-12' })).status).toBe(409);
    expect((await request(app.getHttpServer()).get('/api/setup/status')).body.needsSetup).toBe(false);
    const stored = (await getPool().query('SELECT password_hash FROM users')).rows[0].password_hash; expect(stored).not.toContain('Guclu');
    admin = (await login('yonetici', 'Guclu-Parola-12')).a;
  });

  it('API oturumsuz isteği ve CSRF başlığı olmayan değişikliği reddeder', async () => {
    expect((await request(app.getHttpServer()).get('/api/products')).status).toBe(401);
    expect((await admin.post('/api/users').send({})).status).toBe(403); // başlık yok
  });

  it('yönetici çalışanlara ayrı kullanıcı adı/rol tanımlar; ilk girişte şifre değişimi zorunlu', async () => {
    const mk = async (username: string, role: string) => { const r = await post(admin, '/api/users', { username, displayName: username.toUpperCase(), role }); expect(r.status).toBe(201); return r.body; };
    const e = await mk('editor1', 'editor'); const ap = await mk('onay1', 'approver'); const v = await mk('izleyici1', 'viewer');
    expect(e.temporaryPassword).toBeTruthy();
    expect((await post(admin, '/api/users', { username: 'EDITOR1', displayName: 'xx', role: 'viewer' })).status).toBe(409);
    const first = await login('editor1', e.temporaryPassword);
    expect(first.r.body.mustChangePassword).toBe(true);
    expect((await first.a.get('/api/products')).status).toBe(403); // şifre değişmeden kullanılamaz
    expect((await post(first.a, '/api/auth/password', { currentPassword: e.temporaryPassword, newPassword: 'kisa' })).status).toBe(400);
    expect((await post(first.a, '/api/auth/password', { currentPassword: e.temporaryPassword, newPassword: 'Editor-Yeni-Parola1' })).status).toBe(201);
    expect((await first.a.get('/api/products')).status).toBe(200);
    editor = first.a;
    for (const [u, b] of [['onay1', ap], ['izleyici1', v]] as const) { const x = await login(u, b.temporaryPassword); await post(x.a, '/api/auth/password', { currentPassword: b.temporaryPassword, newPassword: 'Yeni-Parola-' + u + '9' }); }
    approver = (await login('onay1', 'Yeni-Parola-onay19')).a; viewer = (await login('izleyici1', 'Yeni-Parola-izleyici19')).a;
  });

  it('başarısız girişlere hız sınırı uygulanır', async () => {
    for (let i = 0; i < 5; i++) expect((await login('editor1', 'yanlis-sifre-' + i)).r.status).toBe(401);
    expect((await login('editor1', 'Editor-Yeni-Parola1')).r.status).toBe(429);
    await getPool().query('DELETE FROM login_attempts');
    expect((await login('editor1', 'Editor-Yeni-Parola1')).r.status).toBe(201);
  });

  it('şifre sıfırlama: geçici şifre, oturumlar kapanır; devre dışı hesap giriş yapamaz; son yönetici korunur', async () => {
    const list = (await admin.get('/api/users')).body.users; const ed = list.find((u: any) => u.username === 'editor1'); const me = list.find((u: any) => u.username === 'yonetici');
    const r = await post(admin, `/api/users/${ed.id}/reset-password`); expect(r.body.temporaryPassword).toBeTruthy();
    expect((await editor.get('/api/products')).status).toBe(401);
    const x = await login('editor1', r.body.temporaryPassword); await post(x.a, '/api/auth/password', { currentPassword: r.body.temporaryPassword, newPassword: 'Editor-Yeni-Parola2' }); editor = x.a;
    expect((await patch(admin, `/api/users/${me.id}`, { active: false })).status).toBe(400);
    expect((await patch(admin, `/api/users/${me.id}`, { role: 'viewer' })).status).toBe(400);
    const tmp = (await post(admin, '/api/users', { username: 'gecici1', displayName: 'Geçici', role: 'viewer' })).body;
    await patch(admin, `/api/users/${tmp.id}`, { active: false });
    expect((await login('gecici1', tmp.temporaryPassword)).r.status).toBe(401);
  });

  it('salt okunur yönetici raporları görür; ürün, URL ve kullanıcı değiştiremez (API reddeder)', async () => {
    for (const p of ['/api/dashboard', '/api/products', '/api/reports/comparison', '/api/worklist', '/api/sources']) expect((await viewer.get(p)).status, p).toBe(200);
    expect((await viewer.get('/api/users')).status).toBe(403);
    expect((await viewer.get('/api/audit')).status).toBe(403);
    expect((await post(viewer, '/api/products', { code: 'X', name: 'X', variants: [{ sku: 'X', packQty: 1, packUnit: 'kg' }] })).status).toBe(403);
    expect((await post(viewer, '/api/variants/00000000-0000-0000-0000-000000000000/urls', { url: 'https://example.com/a' })).status).toBe(403);
    expect((await post(viewer, '/api/users', { username: 'hack', displayName: 'Hack', role: 'admin' })).status).toBe(403);
    expect((await patch(viewer, '/api/variants/00000000-0000-0000-0000-000000000000', { price: 1 })).status).toBe(403);
    expect((await post(viewer, '/api/urls/00000000-0000-0000-0000-000000000000/check-now')).status).toBe(403);
    expect((await post(viewer, '/api/matching/suggest')).status).toBe(403);
  });
});

describe('A-D) Katalog, manuel URL, gramaj kıyası', () => {
  it('ürün + varyant oluşturur (Ragyu 500 g, 500 TL → 1000 TL/kg)', async () => {
    const r = await post(editor, '/api/products', { code: 'RGY-1', name: 'Dana Kıyma', category: 'Dana', brand: 'Ragyu', variants: [{ sku: 'RGY-1-500', packQty: 500, packUnit: 'g', price: 500 }, { sku: 'RGY-1-1000', packQty: 1, packUnit: 'kg', price: 950 }] });
    expect(r.status).toBe(201); productId = r.body.id;
    const d = (await editor.get(`/api/products/${productId}`)).body; expect(d.variants).toHaveLength(2);
    variantId = d.variants.find((v: any) => v.variant.sku === 'RGY-1-500').variant.id;
    expect((await post(editor, '/api/products', { code: 'rgy-1', name: 'x', variants: [{ sku: 'a', packQty: 1, packUnit: 'kg' }] })).status).toBe(409);
  });

  let trackedId: string; let linkId: string; const url1 = () => `${base}/dana-kiyma-400`;

  it('URL güvenliği: yerel/dahili adresler ve geçersiz şemalar API tarafından reddedilir', async () => {
    for (const url of ['http://127.0.0.1/a', 'http://169.254.169.254/latest', 'http://10.0.0.1/', 'file:///etc/passwd', 'ftp://example.com/x', 'http://intranet/']) {
      const prev = process.env.SCRAPER_ALLOW_HOSTS; process.env.SCRAPER_ALLOW_HOSTS = '';
      const r = await post(editor, `/api/variants/${variantId}/urls`, { url }); process.env.SCRAPER_ALLOW_HOSTS = prev;
      expect(r.status, url).toBe(400);
    }
  });

  it('rakip ürün otomatik bulunamayınca URL elle eklenir; editör eklemesi onay bekler; şimdi kontrol et sonucu görünür', async () => {
    pages.set('/dana-kiyma-400', { html: page('320.00', 'Dana Kıyma 400 g') });
    const r = await post(editor, `/api/variants/${variantId}/urls`, { url: url1(), title: 'Dana Kıyma 400 g' });
    expect(r.status).toBe(201); expect(r.body.linkStatus).toBe('review'); trackedId = r.body.trackedUrlId; linkId = r.body.linkId;
    expect((await post(editor, `/api/variants/${variantId}/urls`, { url: url1() })).status).toBe(409);
    const c = await post(editor, `/api/urls/${trackedId}/check-now`);
    expect(c.status).toBe(201); expect(c.body.status).toBe('ok');
    expect(c.body.extracted).toMatchObject({ title: 'Dana Kıyma 400 g', salePrice: '320', packQty: '400', packUnit: 'g', inStock: true });
    expect(c.body.checkedAt).toBeTruthy(); expect(c.body.unitPrice.value).toBe('800'); // 400 g, 320 TL = 800 TL/kg
  });

  it('onaysız eşleşme güvenilir kıyasa ve "en ucuz" sıralamasına girmez; dışlama nedeni görünür', async () => {
    const rep = await comparison(getPool(), (await getPool().query('SELECT org_id FROM users LIMIT 1')).rows[0].org_id, { variantId });
    const o = rep.rows[0].offers[0]; expect(o.eligible).toBe(false); expect(o.excluded).toBe('match_unapproved'); expect(rep.rows[0].stats.count).toBe(0); expect(rep.rows[0].position.key).toBe('none');
    const ch = (await editor.get('/api/reports/cheapest')).body; expect(ch.rows.find((r: any) => r.variantId === variantId).top).toHaveLength(0);
  });

  it('editör onaylayamaz; onay yetkilisi onaylar; 500 g Ragyu ↔ 400 g rakip doğru TL/kg kıyası verir', async () => {
    expect((await post(editor, `/api/links/${linkId}/status`, { status: 'approved' })).status).toBe(403);
    const ap = await post(approver, `/api/links/${linkId}/status`, { status: 'approved', note: 'Gramaj farkı bilinçli: TL/kg ile kıyaslanıyor' });
    expect(ap.status).toBe(201);
    const row = (await viewer.get('/api/reports/comparison').query({ q: 'RGY-1-500' })).body.rows.find((r: any) => r.variantId === variantId);
    expect(row.ownUnitPrice).toBe('1000'); expect(row.offers[0].unitPrice).toBe('800'); expect(row.offers[0].eligible).toBe(true);
    expect(row.stats.min).toBe('800'); expect(row.position.key).toBe('most_expensive'); expect(row.position.diffAbs).toBe('200'); expect(row.position.diffPct).toBe('25');
  });

  it('uyuşmazlık görünen eşleşmeyi gerekçesiz onaylamak engellenir', async () => {
    const r = await post(editor, `/api/variants/${variantId}/urls`, { url: `${base}/kuzu-kiyma`, title: 'Kuzu Köfte Donuk 400 g', expectedQty: 400, expectedUnit: 'g' });
    expect(r.body.mismatches.length).toBeGreaterThan(0);
    expect((await post(approver, `/api/links/${r.body.linkId}/status`, { status: 'approved' })).status).toBe(400);
    await post(editor, `/api/links/${r.body.linkId}/status`, { status: 'rejected', note: 'farklı ürün' });
    await patch(editor, `/api/urls/${r.body.trackedUrlId}`, { active: false });
  });

  it('planlı tarama: manuel URL zamanı gelince yeniden kontrol edilir (tek seferlik değil)', async () => {
    const db = getPool(); const before = Number((await db.query('SELECT count(*) n FROM scrape_runs WHERE tracked_url_id=$1', [trackedId])).rows[0].n);
    pages.set('/dana-kiyma-400', { html: page('336.00', 'Dana Kıyma 400 g') });
    await db.query('UPDATE tracked_urls SET next_check_at = now() - interval \'1 minute\' WHERE id=$1', [trackedId]);
    const due = await claimDue(db); expect(due.map((d) => d.id)).toContain(trackedId);
    expect((await claimDue(db)).map((d) => d.id)).not.toContain(trackedId); // kira: çift kuyruklama yok
    const res = await runCheck(db, trackedId, { trigger: 'scheduled', skipRateWait: true });
    expect(res.status).toBe('ok');
    expect(Number((await db.query('SELECT count(*) n FROM scrape_runs WHERE tracked_url_id=$1', [trackedId])).rows[0].n)).toBe(before + 1);
    expect(Number((await db.query(`SELECT count(*) n FROM scrape_runs WHERE tracked_url_id=$1 AND trigger='scheduled'`, [trackedId])).rows[0].n)).toBe(1);
  });

  it('URL değişince eski fiyat geçmişi silinmez; her gözlem hangi URL/tarama/tarihten geldiğini gösterir', async () => {
    const db = getPool(); pages.set('/dana-kiyma-400-yeni', { html: page('340.00', 'Dana Kıyma 400 g') });
    const r = await patch(editor, `/api/urls/${trackedId}`, { url: `${base}/dana-kiyma-400-yeni` }); expect(r.status).toBe(200); const newId = r.body.trackedUrlId; expect(newId).not.toBe(trackedId);
    const old = (await db.query('SELECT * FROM tracked_urls WHERE id=$1', [trackedId])).rows[0]; expect(old.active).toBe(false); expect(old.replaced_by).toBe(newId);
    await post(editor, `/api/urls/${newId}/check-now`);
    const h = (await editor.get(`/api/urls/${newId}/history`)).body;
    const urls = new Set(h.observations.map((o: any) => o.url)); expect(urls).toEqual(new Set([url1(), `${base}/dana-kiyma-400-yeni`]));
    for (const o of h.observations) { expect(o.scrape_run_id).toBeTruthy(); expect(o.observed_at).toBeTruthy(); }
    trackedId = newId;
  });

  it('rakip sayfa bozulunca hata ve son başarılı kontrol görünür; eski fiyat yeni gözlem gibi sunulmaz', async () => {
    const db = getPool(); const orgId = (await db.query('SELECT org_id FROM users LIMIT 1')).rows[0].org_id;
    const obsBefore = Number((await db.query('SELECT count(*) n FROM price_observations WHERE tracked_url_id=$1', [trackedId])).rows[0].n);
    pages.set('/dana-kiyma-400-yeni', { html: '<h1>Bakımdayız</h1>' });
    const r = await post(editor, `/api/urls/${trackedId}/check-now`);
    expect(r.body.status).toBe('error'); expect(r.body.error).toMatch(/yapısı değişmiş|bulunamadı/);
    const t = (await db.query('SELECT * FROM tracked_urls WHERE id=$1', [trackedId])).rows[0];
    expect(t.last_status).toBe('error'); expect(t.last_success_at).toBeTruthy(); expect(t.last_error).toBeTruthy(); expect(t.consecutive_failures).toBe(1);
    expect(Number((await db.query('SELECT count(*) n FROM price_observations WHERE tracked_url_id=$1', [trackedId])).rows[0].n)).toBe(obsBefore); // yeni gözlem yok
    const wl = await worklist(db, orgId); expect(wl.failedScrapes.some((f: any) => f.id === trackedId)).toBe(true);
    expect((await editor.get('/api/alerts')).body.some((a: any) => a.type === 'scrape_failing' && a.ref_id === trackedId)).toBe(true);
    // 3 gün sonra o eski veri güncel sayılmaz
    const later = await comparison(db, orgId, { variantId, asOf: new Date(Date.now() + 3 * 86400_000) });
    expect(later.rows[0].offers[0].excluded).toBe('stale');
    pages.set('/dana-kiyma-400-yeni', { html: page('340.00', 'Dana Kıyma 400 g') });
    expect((await post(editor, `/api/urls/${trackedId}/check-now`)).body.status).toBe('ok');
    expect((await editor.get('/api/alerts')).body.some((a: any) => a.type === 'scrape_failing' && a.ref_id === trackedId)).toBe(false);
  });

  it('gramajı belirsiz teklif en ucuz sıralamasına girmez, silinmez, inceleme listesinde görünür; onaylı düzeltme ile girer', async () => {
    const db = getPool(); const orgId = (await db.query('SELECT org_id FROM users LIMIT 1')).rows[0].org_id;
    pages.set('/gramajsiz', { html: page('100.00', 'Dana Kıyma') });
    const r = await post(admin, `/api/variants/${variantId}/urls`, { url: `${base}/gramajsiz`, title: 'Dana Kıyma' }); expect(r.body.linkStatus).toBe('approved');
    const c = await post(approver, `/api/urls/${r.body.trackedUrlId}/check-now`); expect(c.body.status).toBe('review'); expect(c.body.reasons.map((x: any) => x.code)).toContain('qty_unknown');
    let rep = await comparison(db, orgId, { variantId }); const o = rep.rows[0].offers.find((x) => x.linkId === r.body.linkId)!; expect(o.eligible).toBe(false); expect(o.excluded).toBe('qty_unknown'); expect(rep.rows[0].stats.min).toBe('850');
    expect((await db.query('SELECT count(*) n FROM price_observations WHERE tracked_url_id=$1', [r.body.trackedUrlId])).rows[0].n).toBe('1');
    expect((await worklist(db, orgId)).qtyDoubts.some((q: any) => q.tracked_url_id === r.body.trackedUrlId)).toBe(true);
    // editör gramaj düzeltmesi önerir → onay bekler (henüz uygulanmaz); onay yetkilisi onaylayınca sonraki taramada uygulanır
    const ov = await post(editor, `/api/urls/${r.body.trackedUrlId}/qty-override`, { packQty: 250, packUnit: 'g', reason: 'Ürün sayfasında gramaj yazmıyor, paket üzerinden doğrulandı' });
    expect(ov.body.status).toBe('pending');
    await post(approver, `/api/urls/${r.body.trackedUrlId}/check-now`); rep = await comparison(db, orgId, { variantId }); expect(rep.rows[0].offers.find((x) => x.linkId === r.body.linkId)!.eligible).toBe(false);
    expect((await post(editor, `/api/qty-overrides/${ov.body.id}/approve`)).status).toBe(403);
    expect((await post(approver, `/api/qty-overrides/${ov.body.id}/approve`)).status).toBe(201);
    const c2 = await post(approver, `/api/urls/${r.body.trackedUrlId}/check-now`); expect(c2.body.status).toBe('ok'); expect(c2.body.unitPrice.value).toBe('400'); // 250 g, 100 TL
    rep = await comparison(db, orgId, { variantId }); expect(rep.rows[0].stats.min).toBe('400'); expect(rep.rows[0].position.key).toBe('most_expensive');
    await patch(editor, `/api/urls/${r.body.trackedUrlId}`, { active: false });
  });

  it('sayfadaki gramaj kayıtlı eşleşmeyle çelişirse sessizce kabul edilmez; fiyat sıçraması incelemeye düşer', async () => {
    const db = getPool();
    pages.set('/dana-kiyma-400-yeni', { html: page('340.00', 'Dana Kıyma 800 g') });
    const c = await post(editor, `/api/urls/${trackedId}/check-now`); expect(c.body.status).toBe('review'); expect(c.body.reasons.map((x: any) => x.code)).toContain('qty_conflict');
    pages.set('/dana-kiyma-400-yeni', { html: page('1200.00', 'Dana Kıyma 400 g') });
    const j = await post(editor, `/api/urls/${trackedId}/check-now`); expect(j.body.reasons.map((x: any) => x.code)).toContain('price_jump');
    pages.set('/dana-kiyma-400-yeni', { html: page('340.00', 'Dana Kıyma 400 g') });
    expect((await post(editor, `/api/urls/${trackedId}/check-now`)).body.status).toBe('ok');
    void db;
  });
});

describe('Raporlar: tarihsel doğruluk, kargo, Excel, satış', () => {
  it('haftalık rapor: gözlem tarihine göre o anda geçerli fiyatı kullanır, bugünkü fiyatı geçmişe uygulamaz', async () => {
    const db = getPool(); const orgId = (await db.query('SELECT org_id FROM users LIMIT 1')).rows[0].org_id;
    const p = (await post(editor, '/api/products', { code: 'H-1', name: 'Haftalık Test Biftek', variants: [{ sku: 'H-1-K', packQty: 1, packUnit: 'kg', price: 1000 }] })).body.id;
    const v = (await editor.get(`/api/products/${p}`)).body.variants[0].variant.id;
    pages.set('/haftalik', { html: page('900.00', 'Haftalık Test Biftek 1 kg') });
    const r = await post(admin, `/api/variants/${v}/urls`, { url: `${base}/haftalik`, title: 'Haftalık Test Biftek 1 kg' });
    const cp = (await db.query('SELECT competitor_product_id FROM tracked_urls WHERE id=$1', [r.body.trackedUrlId])).rows[0].competitor_product_id;
    const ins = (days: number, price: number) => db.query(`INSERT INTO price_observations(org_id,tracked_url_id,competitor_product_id,url,observed_at,sale_price,pack_qty,pack_unit,base_qty,base_unit,unit_price,in_stock,quality) VALUES ($1,$2,$3,$4, now() - ($5 || ' days')::interval,$6,1,'kg',1000,'g',$6,true,'ok')`, [orgId, r.body.trackedUrlId, cp, `${base}/haftalik`, String(days), price]);
    await ins(10, 1100); await ins(6, 1000); await ins(2, 900);
    await db.query(`UPDATE sources SET stale_after_hours=24*30`);
    const now = new Date(); const w = await periodChange(db, orgId, { variantId: v }, new Date(now.getTime() - 7 * 86400_000), now);
    const ch = w.rows[0].changes[0]; expect(ch.startUnitPrice).toBe('1100'); expect(ch.endUnitPrice).toBe('900'); expect(ch.changePct).toBe('-18.2');
    const asOfOld = await comparison(db, orgId, { variantId: v, asOf: new Date(now.getTime() - 8 * 86400_000) });
    expect(asOfOld.rows[0].offers[0].unitPrice).toBe('1100'); // bugünkü 900 geçmişe uygulanmadı
    const xl = await editor.get('/api/reports/weekly').query({ variantId: v, format: 'xlsx' }).buffer().parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(xl.headers['content-type']).toContain('spreadsheetml'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xl.body); expect(wb.worksheets[0].rowCount).toBeGreaterThan(3);
  });

  it('kargo dahil karşılaştırma raporda açıkça belirtilir', async () => {
    const db = getPool(); const orgId = (await db.query('SELECT org_id FROM users LIMIT 1')).rows[0].org_id;
    const a = (await viewer.get('/api/reports/comparison').query({ includeShipping: '1' })).body; expect(a.meta.shippingIncluded).toBe(true);
    expect((await viewer.get('/api/reports/comparison')).body.meta.shippingIncluded).toBe(false);
    void db; void orgId;
  });

  it('satış performansı: satış verisi yokken uydurma sayı üretilmez', async () => {
    const r = (await viewer.get('/api/reports/sales-performance')).body; expect(r.available).toBe(false); expect(r.message).toMatch(/entegrasyon/);
  });

  it('panel ve günlük çalışma listesi çalışır', async () => {
    const d = (await viewer.get('/api/dashboard')).body; expect(d.totals.products).toBeGreaterThan(0); expect(d.distribution).toBeTruthy();
    const w = (await editor.get('/api/worklist')).body; expect(Array.isArray(w.pendingLinks)).toBe(true);
    const u = (await editor.get('/api/unmatched')).body; expect(Array.isArray(u.variants)).toBe(true);
  });
});

describe('Katalog içe aktarma', () => {
  it('satır bazında hata raporu üretir; geçerli satırlar yüklenir; fiyat geçmişi tutulur', async () => {
    const csv = 'kod;ad;kategori;marka;sku;paket_miktari;birim;fiyat_try\nIMP-1;İçe Aktarılan Biftek;Dana;Ragyu;IMP-1-A;500;g;1.250,50\nIMP-2;;Dana;Ragyu;IMP-2-A;500;g;100\nIMP-3;Hatalı Birim;Dana;Ragyu;IMP-3-A;500;xyz;100\nIMP-4;Gramajsız;Dana;Ragyu;IMP-4-A;;;100\n';
    const r = await editor.post('/api/catalog/import').set(H).attach('file', Buffer.from(csv), 'katalog.csv');
    expect(r.status).toBe(201); expect(r.body.total).toBe(4); expect(r.body.ok).toBe(1); expect(r.body.errors.map((e: any) => e.row)).toEqual([3, 4, 5]);
    const e = await editor.get(`/api/catalog/import/${r.body.id}/errors.csv`); expect(e.text).toContain('Ürün adı boş');
    const v = (await getPool().query(`SELECT price FROM product_variants WHERE sku='IMP-1-A'`)).rows[0]; expect(v.price).toBe('1250.5000');
    expect((await viewer.post('/api/catalog/import').set(H).attach('file', Buffer.from(csv), 'k.csv')).status).toBe(403);
    expect((await viewer.get('/api/catalog/template.xlsx')).status).toBe(200);
  });
});

describe('Toplu rakip URL içe aktarma (PriceRest CSV)', () => {
  it('ürün koduyla eşler, kendi siteyi atlar, onaysız ve pasif ekler; hata ve tekrarları raporlar; kaynak bazında etkinleştirilir', async () => {
    const db = getPool();
    const csv = 'ID,Product Code,Product Name,Seller Name,Seller URL\n' +
      'x,IMP-1-A,İçe Aktarılan Biftek,ragyu.com.tr,https://www.ragyu.com.tr/ice-aktarilan-biftek\n' +
      'x,IMP-1-A,İçe Aktarılan Biftek,www.etineniyisi.com,https://www.etineniyisi.com/ice-aktarilan-biftek\n' +
      'x,IMP-1-A,İçe Aktarılan Biftek,macrocenter.com.tr,https://www.macrocenter.com.tr/biftek-p-1\n' +
      'x,IMP-1-A,İçe Aktarılan Biftek,macrocenter.com.tr,https://www.macrocenter.com.tr/biftek-p-2\n' +
      'x,YOK-123,Olmayan,etineniyisi.com,https://www.etineniyisi.com/x\n' +
      'x,IMP-1-A,Biftek,x,http://127.0.0.1/gizli\n';
    const r = await editor.post('/api/catalog/import-urls').set(H).attach('file', Buffer.from(csv), 'urller.csv');
    expect(r.status).toBe(201); expect(r.body.created).toBe(3);
    expect(r.body.skipped[0].message).toMatch(/kendi sitesi/);
    expect(r.body.errors.map((e: any) => e.row).sort()).toEqual([6, 7]);
    const again = await editor.post('/api/catalog/import-urls').set(H).attach('file', Buffer.from(csv), 'urller.csv');
    expect(again.body.created).toBe(0); expect(again.body.skipped.length).toBe(4);
    const rows = (await db.query(`SELECT l.status, t.active, s.domain FROM tracked_urls t JOIN product_links l ON l.competitor_product_id=t.competitor_product_id JOIN sources s ON s.id=t.source_id WHERE t.url LIKE '%ice-aktarilan%' OR t.url LIKE '%biftek-p-%'`)).rows;
    expect(rows).toHaveLength(3); expect(rows.every((x: any) => x.status === 'review' && x.active === false)).toBe(true);
    expect(rows.map((x: any) => x.domain).sort()).toEqual(['etineniyisi.com', 'macrocenter.com.tr', 'macrocenter.com.tr']);
    // Alan adı bilinen kaynaklar otomatik olarak kendi adaptörüyle oluşur
    const ad = (await db.query(`SELECT domain, adapter_key FROM sources WHERE domain IN ('etineniyisi.com','macrocenter.com.tr') ORDER BY domain`)).rows;
    expect(ad.map((x: any) => x.adapter_key)).toEqual(['etineniyisi', 'macrocenter']);
    // Genel adaptörde kalmış kaynağa toplu atama (yalnız yönetici)
    await db.query(`UPDATE sources SET adapter_key='generic-html' WHERE domain='etineniyisi.com'`);
    expect((await editor.post('/api/sources/assign-adapters').set(H)).status).toBe(403);
    expect((await post(admin, '/api/sources/assign-adapters')).body.changed).toEqual([{ domain: 'etineniyisi.com', adapter: 'etineniyisi' }]);
    expect((await viewer.post('/api/catalog/import-urls').set(H).attach('file', Buffer.from(csv), 'u.csv')).status).toBe(403);
    expect((await editor.post('/api/sources/' + (await db.query(`SELECT id FROM sources WHERE domain='etineniyisi.com'`)).rows[0].id + '/activate-urls').set(H)).status).toBe(403);
    const sid = (await db.query(`SELECT id FROM sources WHERE domain='macrocenter.com.tr'`)).rows[0].id;
    expect((await post(admin, `/api/sources/${sid}/activate-urls`)).body.activated).toBe(2);
    const t = (await db.query(`SELECT count(*) n FROM tracked_urls WHERE source_id=$1 AND active AND next_check_at > now()`, [sid])).rows[0].n; expect(t).toBe('2'); // kademelendirilmiş
  });
  it('PriceRest öneri dosyası: önerildi olarak alınır, güvenilmez puan yeniden hesaplanır, çakışanlar tekilleştirilir', async () => {
    const db = getPool();
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('s');
    ws.addRow(['Product Code', 'SKU', 'Product Name', 'Suggestion Website', 'Suggestion Name', 'Matching Score', 'Suggestion URL']);
    ws.addRow([null, 'IMP-1-A', 'İçe Aktarılan Biftek', 'etineniyisi.com', 'Marine Kuzu Kıyma Şiş', 100, 'https://www.etineniyisi.com/kuzu-kiyma-sis']); // alakasız ama "100" puanlı
    ws.addRow([null, 'IMP-1-A', 'İçe Aktarılan Biftek', 'tazedirekt.com', 'İçe Aktarılan Biftek 500 g', 100, 'https://www.tazedirekt.com/ice-aktarilan-biftek-500-g']);
    ws.addRow([null, 'IMP-1-A', 'İçe Aktarılan Biftek', 'etineniyisi.com', 'İçe Aktarılan Biftek', 100, 'https://etineniyisi.com/ice-aktarilan-biftek/']); // CSV ile çakışır (www/sondaki / farkı)
    ws.addRow([null, 'YOK-9', 'x', 'a.com', 'x y z', 100, 'https://a.com/x']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = await editor.post('/api/catalog/import-suggestions').set(H).attach('file', buf, 'oneriler.xlsx');
    expect(r.status).toBe(201); expect(r.body.created).toBe(1); expect(r.body.belowThreshold).toBe(1); expect(r.body.duplicates).toBe(1); expect(r.body.errors).toHaveLength(1);
    const l = (await db.query(`SELECT l.status, l.origin, t.active FROM product_links l JOIN tracked_urls t ON t.competitor_product_id=l.competitor_product_id WHERE t.url LIKE '%tazedirekt.com/ice-aktarilan%'`)).rows[0];
    expect(l).toEqual({ status: 'suggested', origin: 'auto', active: false });
    expect((await viewer.post('/api/catalog/import-suggestions').set(H).attach('file', buf, 'o.xlsx')).status).toBe(403);
  });
  it('ürün kodu iş anahtarıdır: büyük/küçük harf ve baştaki/sondaki boşluk aynı kodu verir', async () => {
    expect((await post(editor, '/api/products', { code: '  imp-1  ', name: 'Tekrar', variants: [{ sku: 'T-1', packQty: 1, packUnit: 'kg' }] })).status).toBe(409);
    const r = await post(editor, '/api/products', { code: '  PRE2023-77  ', name: ' Boşluklu Ad ', variants: [{ sku: ' PRE2023-77 ', packQty: 1, packUnit: 'kg' }] });
    expect(r.status).toBe(201);
    const p = (await getPool().query(`SELECT code, name FROM products WHERE id=$1`, [r.body.id])).rows[0]; expect(p).toEqual({ code: 'PRE2023-77', name: 'Boşluklu Ad' });
  });
});

describe('Denetim kayıtları', () => {
  it('onay, URL ekleme/değiştirme, gramaj düzeltmesi, kullanıcı ve rol değişiklikleri kim/ne zaman ile kaydedilir', async () => {
    const list = (await admin.get('/api/audit').query({ limit: 500 })).body;
    const actions = new Set(list.map((a: any) => a.action));
    for (const a of ['setup.first_admin', 'user.created', 'user.password_reset', 'user.deactivated', 'url.added', 'url.changed', 'link.approved', 'qty_override.created', 'qty_override.approved', 'url.check_now', 'product.created', 'catalog.imported']) expect(actions.has(a), a).toBe(true);
    const appr = list.find((a: any) => a.action === 'link.approved'); expect(appr.actor_name).toContain('onay1'); expect(appr.at).toBeTruthy();
    const me = (await admin.get('/api/users')).body.users.find((u: any) => u.username === 'izleyici1');
    await patch(admin, `/api/users/${me.id}`, { role: 'editor' }); await patch(admin, `/api/users/${me.id}`, { role: 'viewer' });
    const l2 = (await admin.get('/api/audit').query({ action: 'user.role_changed' })).body; expect(l2[0].details).toMatchObject({ from: 'editor', to: 'viewer' });
    expect((await approver.get('/api/audit')).status).toBe(200); expect((await editor.get('/api/audit')).status).toBe(403);
  });

  it('oturum çıkışı oturumu kapatır; sağlık kontrolü açık', async () => {
    const x = await login('izleyici1', 'Yeni-Parola-izleyici19'); expect((await post(x.a, '/api/auth/logout')).status).toBe(201);
    expect((await x.a.get('/api/auth/me')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/health')).body.status).toBe('ok');
  });

  it('çok kiracılı ayrım: başka şirketin verisi API tarafından görülmez', async () => {
    const db = getPool(); const o2 = (await db.query(`INSERT INTO organizations(name,slug) VALUES ('Diğer Şirket','diger') RETURNING id`)).rows[0].id;
    const p2 = (await db.query(`INSERT INTO products(org_id,code,name) VALUES ($1,'D-1','Diğer Ürün') RETURNING id`, [o2])).rows[0].id;
    expect((await editor.get(`/api/products/${p2}`)).status).toBe(404);
    expect((await editor.get('/api/products').query({ pageSize: 200 })).body.rows.some((r: any) => r.productId === p2)).toBe(false);
    expect((await patch(editor, `/api/products/${p2}`, { name: 'ele geçirildi' })).status).toBe(404);
  });
});

describe('Gerçek site adaptörleri uçtan uca (kayıtlı sayfalarla; canlı ağ yok)', () => {
  const fx = (n: string) => require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', `${n}.htm`), 'utf8');
  const bodies: Record<string, string> = { 'etineniyisi.com': fx('etineniyisi'), 'amasyaeturunleri.com.tr': fx('amasya'), 'macrocenter.com.tr': fx('macrocenter') };
  let failing = false;
  const fetcher = async (url: string) => {
    const host = new URL(url).hostname.replace(/^(www|market)\./, '');
    if (failing) return { status: 503, body: 'bakımda', finalUrl: url, contentType: 'text/html' };
    return { status: 200, body: bodies[host] ?? '', finalUrl: url, contentType: 'text/html' };
  };

  it('CSV ile gelen URL’ler kendi adaptörleriyle kaynak olur; planlı taramada gözlemler doğru TL/kg ile yazılır', async () => {
    const db = getPool(); const orgId = (await db.query('SELECT org_id FROM users LIMIT 1')).rows[0].org_id;
    const pr = await post(editor, '/api/products', { code: 'E2E-1', name: 'Kuzu Test Ürünü', variants: [{ sku: 'E2E-1', packQty: 1, packUnit: 'kg', price: 2000 }] }); expect(pr.status).toBe(201);
    const vId = (await db.query(`SELECT id FROM product_variants WHERE sku='E2E-1'`)).rows[0].id;
    const csv = 'ID,Product Code,Product Name,Seller Name,Seller URL\n' +
      'x,E2E-1,T,etineniyisi.com,https://www.etineniyisi.com/marine-kuzu-kusleme-sis\n' +
      'x,E2E-1,T,amasya,https://market.amasyaeturunleri.com.tr/urun/dana-straganof-500g/\n' +
      'x,E2E-1,T,macrocenter.com.tr,https://www.macrocenter.com.tr/kuzu-but-kemiksiz-trakya-kivircik-kg-p-16e5e62\n';
    expect((await editor.post('/api/catalog/import-urls').set(H).attach('file', Buffer.from(csv), 'u.csv')).body.created).toBe(3);
    const keys = (await db.query(`SELECT domain, adapter_key FROM sources WHERE domain IN ('etineniyisi.com','market.amasyaeturunleri.com.tr','macrocenter.com.tr') ORDER BY domain`)).rows;
    expect(Object.fromEntries(keys.map((k: any) => [k.domain, k.adapter_key]))).toEqual({ 'etineniyisi.com': 'etineniyisi', 'market.amasyaeturunleri.com.tr': 'amasya', 'macrocenter.com.tr': 'macrocenter' });
    // eşleşmeleri onayla, kaynakları etkinleştir, hepsini vadesi gelmiş yap
    for (const l of (await db.query(`SELECT l.id FROM product_links l JOIN tracked_urls t ON t.competitor_product_id=l.competitor_product_id JOIN sources s ON s.id=t.source_id WHERE s.domain IN ('etineniyisi.com','market.amasyaeturunleri.com.tr') AND t.url LIKE '%kusleme-sis%' OR t.url LIKE '%straganof%' OR t.url LIKE '%kivircik%'`)).rows) await post(approver, `/api/links/${l.id}/status`, { status: 'approved' });
    for (const s of (await db.query(`SELECT id FROM sources WHERE domain IN ('etineniyisi.com','market.amasyaeturunleri.com.tr','macrocenter.com.tr')`)).rows) await post(admin, `/api/sources/${s.id}/activate-urls`);
    await db.query(`UPDATE tracked_urls SET next_check_at=now() - interval '1 minute' WHERE url LIKE '%kusleme-sis%' OR url LIKE '%straganof%' OR url LIKE '%kivircik%'`);
    const due = (await claimDue(db, 100)).map((d) => d.id);
    const mine = (await db.query(`SELECT id, url FROM tracked_urls WHERE url LIKE '%kusleme-sis%' OR url LIKE '%straganof%' OR url LIKE '%kivircik%'`)).rows;
    for (const m of mine) expect(due).toContain(m.id);
    const res: Record<string, any> = {};
    for (const m of mine) res[new URL(m.url).hostname] = await runCheck(db, m.id, { trigger: 'scheduled', fetcher, skipRateWait: true });
    expect(res['www.etineniyisi.com'].status).toBe('ok'); expect(res['www.etineniyisi.com'].unitPrice.value).toBe('2762.5'); // 1.105 TL / 400 g
    expect(res['market.amasyaeturunleri.com.tr'].status).toBe('ok'); expect(res['market.amasyaeturunleri.com.tr'].unitPrice.value).toBe('1298'); // 649 TL / 500 g
    expect(res['www.macrocenter.com.tr'].status).toBe('ok'); expect(res['www.macrocenter.com.tr'].unitPrice.value).toBe('2069.95'); // kg ürünü
    const rep = await comparison(db, orgId, { variantId: vId });
    expect(rep.rows[0].offers.filter((o) => o.eligible)).toHaveLength(3);
    expect(rep.rows[0].stats.min).toBe('1298');
  });

  it('site hata verince son başarılı veri korunur, hata görünür, deneme aralığı uzar; kaynak bayatlayınca uyarı çıkar', async () => {
    const db = getPool(); failing = true;
    const t = (await db.query(`SELECT id FROM tracked_urls WHERE url LIKE '%straganof%'`)).rows[0];
    const before = (await db.query('SELECT count(*) n FROM price_observations WHERE tracked_url_id=$1', [t.id])).rows[0].n;
    const r = await runCheck(db, t.id, { trigger: 'scheduled', fetcher, skipRateWait: true });
    expect(r.status).toBe('error'); expect(r.error).toMatch(/503|HTTP/);
    const row = (await db.query('SELECT last_status, consecutive_failures, last_success_at, next_check_at FROM tracked_urls WHERE id=$1', [t.id])).rows[0];
    expect(row.last_status).toBe('error'); expect(row.consecutive_failures).toBe(1); expect(row.last_success_at).not.toBeNull(); expect(new Date(row.next_check_at).getTime()).toBeGreaterThan(Date.now());
    expect((await db.query('SELECT count(*) n FROM price_observations WHERE tracked_url_id=$1', [t.id])).rows[0].n).toBe(before); // hata yeni fiyat gibi yazılmaz
    await db.query(`UPDATE sources SET last_success_at = now() - interval '5 days', stale_after_hours = 24 WHERE domain='market.amasyaeturunleri.com.tr'`);
    await refreshStaleAlerts(db);
    const a = (await db.query(`SELECT count(*) n FROM alerts a JOIN sources s ON s.id=a.ref_id WHERE a.type='stale_source' AND s.domain='market.amasyaeturunleri.com.tr' AND a.status='open'`)).rows[0].n;
    expect(Number(a)).toBeGreaterThan(0); failing = false;
  });
});
