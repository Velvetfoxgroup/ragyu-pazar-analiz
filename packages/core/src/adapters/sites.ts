/**
 * Rakip site adaptörleri.
 *
 * DİKKAT — DOĞRULAMA DURUMU: Bu adaptörler yalnızca elle kaydedilmiş sayfa örnekleriyle (tests/fixtures) yazıldı ve
 * test edildi. Gerçek sitelere erişim bu ortamdan mümkün olmadığı için CANLI SİTE İLE DOĞRULANMADI. Etkinleştirmeden önce
 * şirket sunucusunda `npm run adapter:test -- <url> <adaptör>` ile kontrol edin; sitenin şablonu değişirse adaptör
 * fiyat bulamaz (sayfa "geçersiz" olarak işaretlenir, yanlış fiyat yazılmaz).
 *
 * Genel ilkeler:
 *  - Önce ürünün KENDİ yapılandırılmış verisi (JSON-LD / microdata / seçili varyant) okunur; sayfadaki benzer-ürün
 *    kartlarındaki fiyatlara asla bakılmaz.
 *  - Gramaj sayfadan kanıtlanabiliyorsa doldurulur (başlık, varyant adı, birim etiketi); bulunamazsa boş bırakılır —
 *    uygulama o teklifi "gramaj bilinmiyor" diye güvenilir karşılaştırmadan çıkarır.
 *  - Fiyat okunamazsa null döner (tahmin yok).
 */
import * as cheerio from 'cheerio';
import Decimal from 'decimal.js';
import { Extracted, SourceAdapter, empty, merge, registerAdapter, txt } from '../extract';
import { parsePrice, parseQtyFromText } from '../units';

type Part = Partial<Extracted>;
const dec = (v: string | number | null | undefined, dotDecimal = false) => { const p = parsePrice(v === undefined || v === null ? null : String(v), { dotDecimal }); return p ? p.toString() : null; };
const qtyPart = (text: string | null | undefined): Part | null => { const q = parseQtyFromText(text); return q ? { packQty: q.qty.toString(), packUnit: q.unit } : null; };
const stockFromSchema = (v: unknown): boolean | null => { const a = String(v ?? ''); return a ? /InStock|LimitedAvailability|PreOrder/i.test(a) : null; };

function jsonLdNodes($: cheerio.CheerioAPI): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    out.push(n);
    if (n['@graph']) walk(n['@graph']);
  };
  $('script[type="application/ld+json"]').each((_, el) => { try { walk(JSON.parse($(el).contents().text())); } catch { /* bozuk JSON-LD yok sayılır */ } });
  return out;
}
const isType = (n: any, t: string) => n && (n['@type'] === t || (Array.isArray(n['@type']) && n['@type'].includes(t)));
const firstOffer = (n: any) => (Array.isArray(n?.offers) ? n.offers[0] : n?.offers);

// ───────────────────────── Etin En İyisi (Ticimax) ─────────────────────────
/** Ticimax: JSON-LD Product (KDV dahil satış fiyatı); gramaj sepet kutusundaki satış birimi etiketinde ("400 gr"). */
export const etinEnIyisiAdapter: SourceAdapter = {
  key: 'etineniyisi', label: 'Etin En İyisi (Ticimax)',
  extract(html) {
    const $ = cheerio.load(html);
    const p = jsonLdNodes($).find((n) => isType(n, 'Product'));
    if (!p) return empty('etineniyisi');
    const offer = firstOffer(p);
    // Ticimax sayfasındaki gömülü ürün verisi: piyasa fiyatı (liste) ve indirimli fiyat.
    const market = dec($('script').toArray().map((e) => $(e).html() ?? '').join('\n').match(/"piyasaFiyatiStr":"([^"]*)"/)?.[1]);
    const sale = dec(offer?.price, true);
    const list = market && sale && new Decimal(market).gt(sale) ? market : null;
    const unit = txt($('.pSatisBirimi').first().text());
    return merge('etineniyisi:json-ld', {
      title: txt(p.name), brand: txt(p.brand?.name), salePrice: sale, listPrice: list, currency: offer?.priceCurrency ?? 'TRY',
      inStock: stockFromSchema(offer?.availability),
    }, qtyPart(unit));
  },
};

// ───────────────────────── Nebyan Doğal (Sorsware) ─────────────────────────
/** Fiyat birim miktarı İÇİN yazılır ("₺358,50 / 100 g"): adaptör bu miktarı paket miktarı olarak döndürür. */
export const nebyanAdapter: SourceAdapter = {
  key: 'nebyandogal', label: 'Nebyan Doğal',
  extract(html) {
    const $ = cheerio.load(html);
    const product = jsonLdNodes($).find((n) => isType(n, 'Product'));
    const offer = firstOffer(product);
    const wrap = $('.product-price-wrapper .amount-wrapper').first();
    const price = dec(offer?.price, true) ?? dec(wrap.find('.sale-price').first().text());
    const oldPrice = dec($('.product-price-wrapper .old-price, .product-price-wrapper .list-price').first().text());
    const unitTxt = txt(wrap.find('span').not('.Price').first().text());
    const addBtn = $('button.js-shop-button').length > 0;
    return merge('nebyandogal:' + (offer ? 'json-ld' : 'html'), {
      title: txt($('h1.product-name').first().text()) ?? txt(product?.name), brand: null,
      salePrice: price, listPrice: oldPrice && price && new Decimal(oldPrice).gt(price) ? oldPrice : null, currency: 'TRY',
      inStock: offer?.availability ? stockFromSchema(offer.availability) : addBtn ? true : null,
    }, qtyPart(unitTxt));
  },
};

// ───────────────────────── Organikasap (Shopify) ─────────────────────────
/**
 * Shopify çok varyantlı ürün: sayfa meta etiketi (og:price) SEÇİLİ varyantı değil başka bir varyantı gösterebilir.
 * Doğru kaynak: sepet formundaki seçili varyant kimliği (input[name=id]) → JSON-LD ProductGroup.hasVariant eşleşmesi.
 */
export const organikasapAdapter: SourceAdapter = {
  key: 'organikasap', label: 'Organikasap (Shopify)',
  extract(html) {
    const $ = cheerio.load(html);
    const nodes = jsonLdNodes($);
    const group = nodes.find((n) => isType(n, 'ProductGroup'));
    const selectedId = $('form[data-type="add-to-cart-form"] input[name="id"]').first().attr('value') ?? $('input[name="id"][ref="variantId"]').first().attr('value');
    const variants: any[] = group?.hasVariant ?? [];
    const sel = variants.find((v) => selectedId && String(v['@id'] ?? '').includes(`variant=${selectedId}`)) ?? (variants.length === 1 ? variants[0] : null);
    if (!sel) return empty('organikasap'); // seçili varyant belirlenemedi: tahmin yok
    const offer = firstOffer(sel);
    const base = txt(nodes.find((n) => n['@type'] === 'Product')?.name) ?? txt(group?.name);
    return merge('organikasap:variant', {
      title: txt(sel.name) ?? base, brand: txt(group?.brand?.name),
      salePrice: dec(offer?.price, true), currency: offer?.priceCurrency ?? 'TRY', inStock: stockFromSchema(offer?.availability),
    }, qtyPart(String(sel.name ?? '')));
  },
};

// ───────────────────────── Migros grubu (Tazedirekt / Macroonline / Migros) ─────────────────────────
/**
 * Bu üç site aynı Angular altyapısını kullanır; fiyat sayfa HTML'inde değil, tarayıcıda sonradan yüklenir.
 * Sunucu çıktısında yalnızca og:price:amount meta etiketi bulunur (Türkçe biçim: "1.026,87"). Sayfadaki diğer TL
 * değerleri "benzer ürünler" kartlarıdır ve KULLANILMAZ. Fiyat yüklenmemişse meta "null" olur → fiyat yok.
 * Gramaj başlıktan alınır ("630 g"); başlık "… Kg" ile bitiyorsa ürün kilo ile satılır, fiyat 1 kg içindir.
 */
function migrosGroupExtract(key: string): SourceAdapter['extract'] {
  return (html) => {
    const $ = cheerio.load(html);
    const h1 = txt($('h1').first().text());
    const title = h1 ?? txt($('meta[property="og:title"]').attr('content'));
    const price = dec($('meta[property="og:price:amount"]').attr('content'));
    const titleClean = (title ?? '').replace(/\s*[|–-]\s*(Tazedirekt|Macroonline|Migros)\s*$/i, '');
    const perKg = /(^|\s)kg\.?\s*$/i.test(titleClean) && !parseQtyFromText(titleClean);
    const brand = txt($('fe-product-brand a, a#product-detail-brand-name').first().text());
    return merge(`${key}:og-meta`, {
      title: titleClean || null, brand, salePrice: price, currency: price ? 'TRY' : null, inStock: null,
    }, perKg ? { packQty: '1', packUnit: 'kg' as const } : qtyPart(titleClean));
  };
}
export const tazedirektAdapter: SourceAdapter = { key: 'tazedirekt', label: 'Tazedirekt (Migros altyapısı)', extract: migrosGroupExtract('tazedirekt') };
export const macrocenterAdapter: SourceAdapter = { key: 'macrocenter', label: 'Macroonline / Macrocenter (Migros altyapısı)', extract: migrosGroupExtract('macrocenter') };
export const migrosAdapter: SourceAdapter = { key: 'migros', label: 'Migros Sanal Market', extract: migrosGroupExtract('migros') };

// ───────────────────────── Fümeci (IdeaSoft) ─────────────────────────
/** IdeaSoft: gizli schema.org microdata bloğu ürünün kendi fiyatıdır; birim, ana ürün miktar kutusundan ("kg"/"Piece"). */
export const fumeciAdapter: SourceAdapter = {
  key: 'fumeci', label: 'Fümeci (IdeaSoft)',
  extract(html) {
    const $ = cheerio.load(html);
    const root = $('[itemscope][itemtype$="schema.org/Product"]').first();
    if (!root.length) return empty('fumeci');
    const price = dec(root.find('meta[itemprop="price"]').first().attr('content'), true);
    const avail = root.find('link[itemprop="availability"]').first().attr('href');
    const title = txt(root.find('[itemprop="name"]').first().text()) ?? txt($('h1').first().text());
    const input = $('input[data-selector="qty"][data-context="detail"]').first();
    const stype = (input.attr('data-stocktype') ?? '').toLowerCase();
    const stock = Number(input.attr('data-stockamount') ?? '');
    let unit: Part | null = null;
    if (stype === 'kg') unit = { packQty: '1', packUnit: 'kg' };
    else if (stype === 'piece') unit = qtyPart(title) ?? null; // adet satılan ürün: gramaj yalnızca addan alınır
    const oldP = dec($('.product-price .product-price-old').first().text());
    const newP = dec($('.product-price .product-price-new').first().text());
    return merge('fumeci:microdata', {
      title, brand: null, salePrice: price ?? newP ?? oldP, listPrice: newP && oldP && new Decimal(oldP).gt(newP) ? oldP : null, currency: root.find('meta[itemprop="priceCurrency"]').attr('content') ?? 'TRY',
      inStock: avail ? stockFromSchema(avail) && (Number.isFinite(stock) && input.length ? stock > 0 : true) : null,
    }, unit);
  },
};

// ───────────────────────── Dilek Gurme ─────────────────────────
/** JSON-LD Product fiyatı KDV dahil tüketici fiyatıdır (sayfada "KDV hariç + KDV dahil" birlikte yazar); gramaj ad içindedir. */
export const dilekGurmeAdapter: SourceAdapter = {
  key: 'dilekgurme', label: 'Dilek Gurme',
  extract(html) {
    const $ = cheerio.load(html);
    const p = jsonLdNodes($).find((n) => isType(n, 'Product'));
    if (!p) return empty('dilekgurme');
    const offer = firstOffer(p);
    return merge('dilekgurme:json-ld', {
      title: txt(p.name), brand: txt(p.brand?.name), salePrice: dec(offer?.price, true), currency: offer?.priceCurrency ?? 'TRY', inStock: stockFromSchema(offer?.availability),
    });
  },
};

// ───────────────────────── Amasya Et Ürünleri (WooCommerce) ─────────────────────────
/** İlk JSON-LD Product; gramaj ad içinde ("500g"). Sayfadaki "Kg Fiyatı" sitenin kendi hesabıdır, çapraz kontrol için okunur. */
export const amasyaAdapter: SourceAdapter = {
  key: 'amasya', label: 'Amasya Et Ürünleri Market (WooCommerce)',
  extract(html) {
    const $ = cheerio.load(html);
    const p = jsonLdNodes($).find((n) => isType(n, 'Product') && firstOffer(n)?.price !== undefined)
      ?? jsonLdNodes($).find((n) => isType(n, 'Product'));
    const offerPrice = (n: any) => { const o = firstOffer(n); return o?.price ?? o?.priceSpecification?.[0]?.price; };
    const price = dec(offerPrice(p), true) ?? dec($('.summary .price .amount, p.price .amount').first().text());
    if (!price) return empty('amasya');
    const o = firstOffer(p);
    return merge('amasya:json-ld', {
      title: txt(p?.name) ?? txt($('h1').first().text()), brand: txt(p?.brand?.name), salePrice: price, currency: o?.priceCurrency ?? 'TRY', inStock: stockFromSchema(o?.availability),
    });
  },
};

/** Alan adından adaptör anahtarı (kaynak otomatik oluşturulurken kullanılır). Bilinmeyen alan adı: genel adaptör. */
export function adapterKeyForHost(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, '');
  const map: [RegExp, string][] = [
    [/(^|\.)etineniyisi\.com$/, 'etineniyisi'], [/(^|\.)nebyandogal\.com$/, 'nebyandogal'], [/(^|\.)organikasap\.com$/, 'organikasap'],
    [/(^|\.)tazedirekt\.com$/, 'tazedirekt'], [/(^|\.)macrocenter\.com\.tr$/, 'macrocenter'], [/(^|\.)migros\.com\.tr$/, 'migros'],
    [/(^|\.)fumeci\.com$/, 'fumeci'], [/(^|\.)dilekgurme\.(net|com)$/, 'dilekgurme'], [/(^|\.)amasyaeturunleri\.com\.tr$/, 'amasya'],
  ];
  return map.find(([re]) => re.test(h))?.[1] ?? 'generic-html';
}

export const SITE_ADAPTERS = [etinEnIyisiAdapter, nebyanAdapter, organikasapAdapter, tazedirektAdapter, macrocenterAdapter, fumeciAdapter, dilekGurmeAdapter, amasyaAdapter, migrosAdapter];
for (const a of SITE_ADAPTERS) registerAdapter(a);
