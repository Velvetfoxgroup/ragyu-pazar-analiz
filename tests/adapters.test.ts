/**
 * Rakip site adaptörleri — fixture testleri.
 * UYARI: Fixture'lar elle kaydedilmiş (ve boyutu küçültülmüş) sayfa kopyalarıdır; adaptörler CANLI sitelerle doğrulanmadı.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getAdapter, unitPrice, adapterKeyForHost, listAdapters } from '../packages/core/src';

const load = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', `${n}.htm`), 'utf8');
const run = (key: string, fx: string) => getAdapter(key).extract(load(fx), {});
const perKg = (e: ReturnType<typeof run>) => (e.salePrice && e.packQty && e.packUnit ? unitPrice(e.salePrice, e.packQty, e.packUnit)!.value.toFixed(2) : null);

describe('site adaptörleri (kayıtlı sayfa örnekleri)', () => {
  it('hepsi kayıt defterinde', () => {
    const keys = listAdapters().map((a) => a.key);
    for (const k of ['etineniyisi', 'nebyandogal', 'organikasap', 'tazedirekt', 'macrocenter', 'fumeci', 'dilekgurme', 'amasya', 'migros']) expect(keys).toContain(k);
  });

  it('etineniyisi (Ticimax): 1.105 TL / 400 gr → 2.762,50 TL/kg', () => {
    const e = run('etineniyisi', 'etineniyisi');
    expect(e.title).toBe('Marine Kuzu Küşleme Şiş');
    expect(e.salePrice).toBe('1105'); expect(e.packQty).toBe('400'); expect(e.packUnit).toBe('g');
    expect(e.inStock).toBe(true); expect(perKg(e)).toBe('2762.50');
  });

  it('nebyandogal: fiyat 100 g içindir → 3.585 TL/kg', () => {
    const e = run('nebyandogal', 'nebyandogal');
    expect(e.title).toBe('Antrikot Füme');
    expect(e.salePrice).toBe('358.5'); expect(e.packQty).toBe('100'); expect(e.packUnit).toBe('g');
    expect(perKg(e)).toBe('3585.00');
  });

  it('organikasap (Shopify): meta etiketi 920 (500 g) gösterir ama seçili varyant 1 kg / 1.840 TL', () => {
    const html = load('organikasap');
    expect(html).toContain('og:price:amount'); // tuzak: meta başka varyantın fiyatını taşıyor
    const e = run('organikasap', 'organikasap');
    expect(e.salePrice).toBe('1840'); expect(e.packQty).toBe('1'); expect(e.packUnit).toBe('kg');
    expect(perKg(e)).toBe('1840.00');
    // genel adaptör bu sayfada fiyatı doğru bulamaz — özel adaptör gerekçesi
    expect(getAdapter('generic-html').extract(html, {}).salePrice).not.toBe('1840');
  });

  it('organikasap: seçili varyant 500 g ise 920 TL / 500 g okunur', () => {
    const html = load('organikasap').replace(/(name="id"[^>]*value=")46700649644217/, '$146700649611449');
    const e = getAdapter('organikasap').extract(html, {});
    expect(e.salePrice).toBe('920'); expect(e.packQty).toBe('500'); expect(e.packUnit).toBe('g');
  });

  it('organikasap: seçili varyant belirlenemezse fiyat uydurmaz', () => {
    const html = load('organikasap').replace(/name="id"/g, 'name="x"');
    expect(getAdapter('organikasap').extract(html, {}).salePrice).toBeNull();
  });

  it('tazedirekt: og:price Türkçe biçimli (1.026,87), gramaj başlıktan (630 g), URL’deki "500-g" yok sayılır', () => {
    const e = run('tazedirekt', 'tazedirekt');
    expect(e.salePrice).toBe('1026.87'); expect(e.packQty).toBe('630'); expect(e.packUnit).toBe('g');
    expect(perKg(e)).toBe('1629.95');
  });

  it('macrocenter: "… Kg" ürünü, fiyat 1 kg için (benzer ürün kartları kullanılmaz)', () => {
    const e = run('macrocenter', 'macrocenter');
    expect(e.title).toBe('Kuzu But Kemiksiz Trakya Kıvırcık Kg');
    expect(e.salePrice).toBe('2069.95'); expect(e.packQty).toBe('1'); expect(e.packUnit).toBe('kg');
  });

  it('migros: fiyat sayfada yüklenmemiş (meta "null") → fiyat yok, uydurma yok', () => {
    const e = run('migros', 'migros');
    expect(e.title).toBe('Dana Kuyruk (Pöç) Kg');
    expect(e.salePrice).toBeNull();
  });

  it('fumeci: microdata fiyatı ve kg birimi (2 sayfa)', () => {
    const g = run('fumeci', 'fumeci-kuzu-gerdan');
    expect(g.title).toBe('KUZU GERDAN KG.'); expect(g.salePrice).toBe('1600'); expect(g.packQty).toBe('1'); expect(g.packUnit).toBe('kg'); expect(g.inStock).toBe(true);
    const b = run('fumeci', 'fumeci-dana-bonfile');
    expect(b.salePrice).toBe('2700'); expect(b.packUnit).toBe('kg'); expect(perKg(b)).toBe('2700.00');
  });

  it('dilekgurme: KDV dahil 2.200 TL (KDV hariç 2.178,22 alınmaz), gramaj addan 1 kg', () => {
    const e = run('dilekgurme', 'dilekgurme');
    expect(e.salePrice).toBe('2200'); expect(e.packQty).toBe('1'); expect(e.packUnit).toBe('kg'); expect(e.inStock).toBe(true);
  });

  it('amasya: 649 TL / 500 g = sitenin kendi "Kg Fiyatı" 1.298 TL', () => {
    const e = run('amasya', 'amasya');
    expect(e.salePrice).toBe('649'); expect(e.packQty).toBe('500'); expect(e.packUnit).toBe('g');
    expect(perKg(e)).toBe('1298.00');
    expect(load('amasya')).toContain('1.298,00');
  });

  it('bozuk/boş sayfada hiçbir adaptör fiyat uydurmaz', () => {
    for (const k of ['etineniyisi', 'nebyandogal', 'organikasap', 'tazedirekt', 'macrocenter', 'fumeci', 'dilekgurme', 'amasya', 'migros'])
      expect(getAdapter(k).extract('<html><body><h1>Hata</h1></body></html>', {}).salePrice).toBeNull();
  });

  it('alan adından adaptör anahtarı', () => {
    expect(adapterKeyForHost('www.etineniyisi.com')).toBe('etineniyisi');
    expect(adapterKeyForHost('market.amasyaeturunleri.com.tr')).toBe('amasya');
    expect(adapterKeyForHost('www.macrocenter.com.tr')).toBe('macrocenter');
    expect(adapterKeyForHost('baska-site.com')).toBe('generic-html');
  });
});
