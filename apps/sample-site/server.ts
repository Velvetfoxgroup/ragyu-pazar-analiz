/**
 * Yerel demo rakip sitesi — GERÇEK bir rakip değildir. Tarama hattını uçtan uca denemek için kullanılır.
 * Aynı sunucu, Host başlığına göre 3 farklı "rakip" gibi davranır (ornek-et.demo, demo-kasap.demo, lezzet.demo).
 * Yönetim uçları (/__admin/*) yalnızca demo içindir; fiyat değiştirmek veya sayfayı bozmak için kullanılır.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export interface DemoItem { sku: string; slug: string; title: string; brand: string; qty: string | null; price: number; listPrice?: number; stock: boolean; campaign?: string; shipping?: number; broken?: boolean }
export const SITES: Record<string, { name: string; style: 'html' | 'jsonld'; factor: number; gram: number }> = {
  'ornek-et.demo': { name: 'Örnek Et Market', style: 'html', factor: 1.12, gram: 400 },
  'demo-kasap.demo': { name: 'Demo Kasap', style: 'html', factor: 0.93, gram: 500 },
  'lezzet.demo': { name: 'Lezzet Sofrası', style: 'jsonld', factor: 1.05, gram: 1000 },
};

const slugify = (s: string) => s.toLocaleLowerCase('tr-TR').replace(/[ıİ]/g, 'i').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

export function demoCatalog(csvPath = path.resolve(__dirname, '../../data/ornek-katalog.csv'), limit = 30) {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n').slice(1).map((l) => l.split(';'));
  const out: Record<string, DemoItem[]> = {};
  for (const [host, cfg] of Object.entries(SITES)) {
    out[host] = lines.filter(([, , , p]) => Number(p) > 0).slice(0, limit).filter((_, i) => (hash(host + i) % 10) < 8).map(([sku, name, , price]) => {
      const h = hash(host + sku); const perKg = Number(price) * (cfg.factor + ((h % 21) - 10) / 100);
      const gram = h % 17 === 0 ? 0 : cfg.gram; // bazı ürünlerde gramaj hiç yazmıyor
      const p = gram ? (perKg * gram) / 1000 : perKg * 0.5;
      return { sku, slug: slugify(name) + '-' + slugify(sku), title: `${name}${gram ? ` ${gram >= 1000 ? gram / 1000 + ' kg' : gram + ' g'}` : ''}`, brand: 'Demo', qty: gram ? `${gram >= 1000 ? gram / 1000 + ' kg' : gram + ' g'}` : null, price: Math.round(p * 100) / 100, listPrice: h % 5 === 0 ? Math.round(p * 1.15 * 100) / 100 : undefined, stock: h % 13 !== 0, campaign: h % 7 === 0 ? '%10 indirim' : undefined, shipping: host === 'lezzet.demo' ? 59.9 : undefined };
    });
  }
  return out;
}
export const urlFor = (host: string, slug: string, port = 4100) => `http://${host}:${port}/urun/${slug}`;

const tl = (n: number) => n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function render(host: string, it: DemoItem) {
  const style = SITES[host].style;
  if (it.broken) return `<html><body><h1>Sayfa güncelleniyor</h1><p>Yeni tasarımımız yakında.</p></body></html>`;
  if (style === 'jsonld') {
    return `<html><head><title>${it.title}</title><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: it.title, brand: { '@type': 'Brand', name: it.brand }, offers: { '@type': 'Offer', price: it.price.toFixed(2), priceCurrency: 'TRY', availability: it.stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' } })}</script></head><body><h1>${it.title}</h1></body></html>`;
  }
  return `<html><body><div class="urun-detay"><h1>${it.title}</h1><span class="marka">${it.brand}</span>${it.qty ? `<span class="gramaj">${it.qty}</span>` : ''}
  ${it.listPrice ? `<span class="fiyat-eski">${tl(it.listPrice)} TL</span>` : ''}<span class="fiyat-guncel">${tl(it.price)} TL</span><span class="stok">${it.stock ? 'Stokta var' : 'Tükendi'}</span>
  ${it.campaign ? `<span class="kampanya">${it.campaign}</span>` : ''}${it.shipping !== undefined ? `<span class="kargo">Kargo: ${tl(it.shipping)} TL</span>` : ''}</div></body></html>`;
}

export function startSampleSite(port = Number(process.env.SAMPLE_PORT ?? 4100), csvPath?: string) {
  const data = demoCatalog(csvPath);
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host ?? '').split(':')[0];
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname.startsWith('/__admin/')) {
      const site = u.searchParams.get('site') ?? host; const it = data[site]?.find((x) => x.slug === u.searchParams.get('slug'));
      if (u.pathname === '/__admin/state') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(data)); }
      if (!it) { res.statusCode = 404; return res.end('yok'); }
      if (u.pathname === '/__admin/price') it.price = Number(u.searchParams.get('price'));
      if (u.pathname === '/__admin/break') it.broken = u.searchParams.get('on') !== '0';
      if (u.pathname === '/__admin/stock') it.stock = u.searchParams.get('on') !== '0';
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(it));
    }
    const m = u.pathname.match(/^\/urun\/(.+)$/);
    const it = m && data[host]?.find((x) => x.slug === m[1]);
    if (u.pathname === '/redirect-internal') { res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/'); return res.end(); }
    if (!it) { res.statusCode = 404; return res.end('<html><body>Ürün bulunamadı</body></html>'); }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(render(host, it));
  });
  return new Promise<{ server: http.Server; port: number; data: typeof data }>((resolve) => server.listen(port, () => resolve({ server, port: (server.address() as any).port, data })));
}

if (require.main === module) startSampleSite().then(({ port }) => console.log(`Demo rakip sitesi: http://localhost:${port} (Host: ${Object.keys(SITES).join(', ')})`));
