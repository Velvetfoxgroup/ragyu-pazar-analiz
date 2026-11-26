import * as cheerio from 'cheerio';
import { parsePrice, parseQtyFromText, Unit } from './units';

export interface Extracted {
  title: string | null;
  brand: string | null;
  listPrice: string | null;
  salePrice: string | null;
  currency: string | null;
  packQty: string | null;
  packUnit: Unit | null;
  inStock: boolean | null;
  campaign: string | null;
  shippingFee: string | null;
  multibuyMin: number | null;
  method: string;
}

export interface ExtractConfig {
  selectors?: { title?: string; price?: string; listPrice?: string; stock?: string; qty?: string; campaign?: string; shipping?: string; brand?: string };
  inStockText?: string; outOfStockText?: string;
}

/** Veri toplama adaptörü: her kaynak kendi çıkarma mantığını taşır. */
export interface SourceAdapter {
  key: string;
  label: string;
  extract(html: string, cfg: ExtractConfig): Extracted;
}

export const empty = (method: string): Extracted => ({ title: null, brand: null, listPrice: null, salePrice: null, currency: null, packQty: null, packUnit: null, inStock: null, campaign: null, shippingFee: null, multibuyMin: null, method });
export const txt = (s?: string | null) => (s ? s.replace(/\s+/g, ' ').trim() : null) || null;

function fromJsonLd($: cheerio.CheerioAPI): Partial<Extracted> | null {
  let found: any = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const arr = Array.isArray(data) ? data : data['@graph'] ?? [data];
      for (const n of arr) if (n && (n['@type'] === 'Product' || (Array.isArray(n['@type']) && n['@type'].includes('Product')))) { found = n; return false; }
    } catch { /* bozuk JSON-LD yok sayılır */ }
  });
  if (!found) return null;
  const offer = Array.isArray(found.offers) ? found.offers[0] : found.offers;
  const price = offer?.price ?? offer?.lowPrice;
  const p = parsePrice(price === undefined ? null : String(price), { dotDecimal: true });
  const avail = String(offer?.availability ?? '');
  return {
    title: txt(found.name), brand: txt(typeof found.brand === 'object' ? found.brand?.name : found.brand),
    salePrice: p ? p.toString() : null, currency: offer?.priceCurrency ?? null,
    inStock: avail ? /InStock|LimitedAvailability/i.test(avail) : null,
  };
}

function fromSelectors($: cheerio.CheerioAPI, cfg: ExtractConfig): Partial<Extracted> {
  const s = cfg.selectors ?? {};
  const get = (sel?: string) => (sel ? txt($(sel).first().attr('content') ?? $(sel).first().text()) : null);
  const out: Partial<Extracted> = {};
  if (s.title) out.title = get(s.title);
  if (s.brand) out.brand = get(s.brand);
  if (s.price) { const p = parsePrice(get(s.price)); out.salePrice = p ? p.toString() : null; }
  if (s.listPrice) { const p = parsePrice(get(s.listPrice)); out.listPrice = p ? p.toString() : null; }
  if (s.campaign) out.campaign = get(s.campaign);
  if (s.shipping) { const p = parsePrice(get(s.shipping)); out.shippingFee = p ? p.toString() : (get(s.shipping) ? '0' : null); }
  if (s.stock) {
    const t = (get(s.stock) ?? '').toLowerCase();
    if (t) out.inStock = cfg.outOfStockText ? !t.includes(cfg.outOfStockText.toLowerCase()) : !/tükendi|stokta yok|yok/.test(t);
  }
  if (s.qty) { const q = parseQtyFromText(get(s.qty)); if (q) { out.packQty = q.qty.toString(); out.packUnit = q.unit; } }
  return out;
}

export function merge(method: string, ...parts: (Partial<Extracted> | null)[]): Extracted {
  const out = empty(method);
  for (const p of parts) if (p) for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined && (out as any)[k] === null) (out as any)[k] = v;
  if (!out.packQty) {
    const q = parseQtyFromText(out.title);
    if (q) { out.packQty = q.qty.toString(); out.packUnit = q.unit; }
  }
  if (out.salePrice && !out.currency) out.currency = 'TRY';
  return out;
}

/** JSON-LD (schema.org Product) → Open Graph/meta → yapılandırılmış seçiciler. */
export const genericHtmlAdapter: SourceAdapter = {
  key: 'generic-html', label: 'Genel HTML (JSON-LD / seçici)',
  extract(html, cfg) {
    const $ = cheerio.load(html);
    const sel = fromSelectors($, cfg);
    const ld = fromJsonLd($);
    const metaPrice = parsePrice($('meta[property="product:price:amount"]').attr('content') ?? null, { dotDecimal: true });
    const meta: Partial<Extracted> = {
      title: txt($('meta[property="og:title"]').attr('content')) ?? txt($('h1').first().text()),
      salePrice: metaPrice ? metaPrice.toString() : null,
      currency: $('meta[property="product:price:currency"]').attr('content') ?? null,
    };
    const method = ld ? 'json-ld' : Object.keys(sel).length ? 'selector' : 'meta';
    return merge(method, sel, ld, meta);
  },
};

/** Örnek kaynak adaptörü: yapılandırılmış veri olmayan, class tabanlı bir ürün sayfası (demo sitesi). */
export const ornekMarketAdapter: SourceAdapter = {
  key: 'ornek-market', label: 'Örnek Market (demo HTML)',
  extract(html) {
    const $ = cheerio.load(html);
    const root = $('.urun-detay').first();
    if (!root.length) return empty('ornek-market');
    const p = parsePrice(root.find('.fiyat-guncel').first().text());
    const l = parsePrice(root.find('.fiyat-eski').first().text());
    const stock = txt(root.find('.stok').first().text())?.toLowerCase() ?? '';
    const ship = root.find('.kargo').first().text();
    const shipP = parsePrice(ship);
    return merge('ornek-market', {
      title: txt(root.find('h1').first().text()), brand: txt(root.find('.marka').first().text()),
      salePrice: p ? p.toString() : null, listPrice: l ? l.toString() : null, currency: 'TRY',
      inStock: stock ? !/tükendi|yok/.test(stock) : null,
      campaign: txt(root.find('.kampanya').first().text()),
      shippingFee: shipP ? shipP.toString() : /ücretsiz/i.test(ship) ? '0' : null,
      packQty: null,
    }, (() => { const q = parseQtyFromText(root.find('.gramaj').first().text()); return q ? { packQty: q.qty.toString(), packUnit: q.unit } : null; })());
  },
};

const REGISTRY = new Map<string, SourceAdapter>([[genericHtmlAdapter.key, genericHtmlAdapter], [ornekMarketAdapter.key, ornekMarketAdapter]]);
export const registerAdapter = (a: SourceAdapter) => REGISTRY.set(a.key, a);
export const getAdapter = (key: string): SourceAdapter => REGISTRY.get(key) ?? genericHtmlAdapter;
export const listAdapters = () => [...REGISTRY.values()].map((a) => ({ key: a.key, label: a.label }));
