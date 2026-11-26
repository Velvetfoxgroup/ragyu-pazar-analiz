import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { unitPrice, multiplier, toBase, parsePrice, parseQtyFromText, formatTRY, findMismatches, classifyPosition, validateUrlSyntax, isPrivateIp, safeFetch, can, hashPassword, verifyPassword, passwordProblem, genericHtmlAdapter, ornekMarketAdapter, Decimal } from '@ragyu/core';

describe('birim ve gramaj hesabı', () => {
  it('400 g / 320 TL = 800 TL/kg', () => { expect(unitPrice('320', '400', 'g')!.value.toString()).toBe('800'); });
  it('500 g / 500 TL = 1000 TL/kg, çarpan 2', () => { expect(unitPrice(500, 500, 'g')!.value.toString()).toBe('1000'); expect(multiplier(500, 'g')!.toString()).toBe('2'); });
  it('kayan nokta hatası yok (0,1+0,2 benzeri)', () => { expect(unitPrice('0.3', '0.1', 'kg')!.value.toString()).toBe('3'); expect(unitPrice('19.99', '333', 'g')!.value.toDecimalPlaces(4).toString()).toBe('60.03'); });
  it('adet ürünü kg ile kıyaslanmaz', () => { expect(toBase(3, 'adet')).toBeNull(); expect(unitPrice(100, 3, 'adet')).toBeNull(); });
  it('ml/l yalnızca kendi ailesinde', () => { expect(unitPrice(50, 250, 'ml')).toMatchObject({ per: 'l' }); expect(unitPrice(50, 250, 'ml')!.value.toString()).toBe('200'); });
  it('Türkçe fiyat ayrıştırma', () => {
    expect(parsePrice('1.299,90 ₺')!.toString()).toBe('1299.9'); expect(parsePrice('320 TL')!.toString()).toBe('320'); expect(parsePrice('1.299')!.toString()).toBe('1299');
    expect(parsePrice('12.50', { dotDecimal: true })!.toString()).toBe('12.5'); expect(parsePrice('abc')).toBeNull();
  });
  it('metinden gramaj', () => {
    expect(parseQtyFromText('Dana Kıyma 400 gr')).toMatchObject({ unit: 'g' }); expect(parseQtyFromText('Biftek 1,5 kg')!.qty.toString()).toBe('1.5');
    expect(parseQtyFromText('Köfte 2 x 250 g')!.qty.toString()).toBe('500'); expect(parseQtyFromText('Dana Kıyma')).toBeNull();
  });
  it('TRY Türkçe biçim', () => { expect(formatTRY('2750')).toMatch(/2\.750,00/); });
});

describe('eşleşme uyuşmazlıkları', () => {
  it('tür/işlenme/kemik/donuk/gramaj farkları görünür', () => {
    const m = findMismatches({ title: 'Dana Antrikot Kemiksiz Taze', packQty: 500, packUnit: 'g' }, { title: 'Kuzu Antrikot Kemikli Donuk 400 g', packQty: 400, packUnit: 'g' });
    const f = m.map((x) => x.field);
    expect(f).toEqual(expect.arrayContaining(['Hayvan türü', 'Kemikli/kemiksiz', 'Taze/donuk', 'Paket gramajı']));
  });
  it('kıyma ile dana kıyma ilişkisi: işlenme biçimi çelişkisi', () => {
    expect(findMismatches({ title: 'Dana Kuşbaşı' }, { title: 'Dana Köfte' }).some((x) => x.field === 'İşlenme biçimi')).toBe(true);
  });
});

describe('fiyat konumu formülü', () => {
  const D = (...n: number[]) => n.map((x) => new Decimal(x));
  it('en ucuz / aynı / en pahalı / ortalama', () => {
    expect(classifyPosition(new Decimal(90), D(100, 120)).key).toBe('cheapest');
    expect(classifyPosition(new Decimal(100), D(100, 120)).key).toBe('same');
    expect(classifyPosition(new Decimal(130), D(100, 120)).key).toBe('most_expensive');
    expect(classifyPosition(new Decimal(110), D(100, 120)).key).toBe('avg');
    expect(classifyPosition(new Decimal(105), D(100, 120)).key).toBe('below_avg');
    expect(classifyPosition(new Decimal(115), D(100, 120)).key).toBe('above_avg');
  });
  it('fark ve sıra', () => { const p = classifyPosition(new Decimal(150), D(100, 120, 200)); expect(p.diffAbs).toBe('50'); expect(p.diffPct).toBe('50'); expect(p.rank).toBe(3); });
  it('rakip yoksa kıyas yok', () => { expect(classifyPosition(new Decimal(1), []).key).toBe('none'); });
});

describe('URL güvenliği (SSRF)', () => {
  it('yerel ve dahili adresleri reddeder', () => {
    for (const u of ['http://127.0.0.1/x', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://localhost/', 'http://intranet/', 'http://db.internal/', 'ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'https://example.com:8443/', 'javascript:alert(1)'])
      expect(() => validateUrlSyntax(u, []), u).toThrow();
    expect(() => validateUrlSyntax('https://www.example.com.tr/urun/1', [])).not.toThrow();
  });
  it('özel IP aralıkları', () => { for (const ip of ['10.1.1.1', '172.16.0.1', '172.31.255.255', '100.64.0.1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1']) expect(isPrivateIp(ip), ip).toBe(true); expect(isPrivateIp('8.8.8.8')).toBe(false); });
  it('yönlendirme ile dahili adrese geçiş engellenir; boyut ve zaman aşımı sınırı', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/redir') { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); return res.end(); }
      if (req.url === '/big') { res.write('x'.repeat(3 * 1024 * 1024)); return res.end(); }
      if (req.url === '/slow') return; // yanıt vermez
      res.end('ok');
    });
    await new Promise<void>((r) => srv.listen(0, r)); const port = (srv.address() as any).port;
    const allow = ['localhost', `localhost:${port}`];
    expect((await safeFetch(`http://localhost:${port}/`, { allow })).body).toBe('ok');
    await expect(safeFetch(`http://localhost:${port}/redir`, { allow })).rejects.toThrow(/engellendi|Yerel/);
    await expect(safeFetch(`http://localhost:${port}/big`, { allow })).rejects.toThrow();
    await expect(safeFetch(`http://localhost:${port}/slow`, { allow, timeoutMs: 300 })).rejects.toThrow(/zaman/);
    await expect(safeFetch(`http://localhost:${port}/`, { allow: [] })).rejects.toThrow();
    srv.closeAllConnections?.(); srv.close();
  });
});

describe('yetki matrisi ve şifre', () => {
  it('roller', () => {
    expect(can('viewer', 'read')).toBe(true); for (const p of ['catalog:write', 'url:write', 'user:manage', 'match:approve'] as const) expect(can('viewer', p)).toBe(false);
    expect(can('editor', 'url:write')).toBe(true); expect(can('editor', 'match:approve')).toBe(false); expect(can('editor', 'user:manage')).toBe(false);
    expect(can('approver', 'match:approve')).toBe(true); expect(can('approver', 'catalog:write')).toBe(false); expect(can('admin', 'user:manage')).toBe(true);
  });
  it('şifre özeti düz metin değil ve doğrulanır', async () => {
    const h = await hashPassword('Gizli-Parola-123'); expect(h).not.toContain('Gizli'); expect(await verifyPassword('Gizli-Parola-123', h)).toBe(true); expect(await verifyPassword('yanlis', h)).toBe(false);
    expect(passwordProblem('kisa1')).toBeTruthy(); expect(passwordProblem('sadeceharflerburada')).toBeTruthy(); expect(passwordProblem('Yeterince1Uzun')).toBeNull();
  });
});

describe('adaptörler', () => {
  it('JSON-LD', () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Dana Kıyma 400 g","offers":{"price":"320.00","priceCurrency":"TRY","availability":"https://schema.org/InStock"}}</script>`;
    const r = genericHtmlAdapter.extract(html, {}); expect(r.salePrice).toBe('320'); expect(r.packQty).toBe('400'); expect(r.packUnit).toBe('g'); expect(r.inStock).toBe(true);
  });
  it('yapılandırılmış veri yoksa fiyat null (sessiz tahmin yok)', () => { expect(genericHtmlAdapter.extract('<h1>Bakımda</h1>', {}).salePrice).toBeNull(); expect(ornekMarketAdapter.extract('<h1>x</h1>', {}).salePrice).toBeNull(); });
  it('seçici yapılandırması', () => {
    const r = genericHtmlAdapter.extract('<h1>Kuzu Pirzola</h1><b class="p">1.250,50 ₺</b><i class="q">500 gr</i>', { selectors: { price: '.p', qty: '.q', title: 'h1' } });
    expect(r.salePrice).toBe('1250.5'); expect(r.packQty).toBe('500');
  });
});
