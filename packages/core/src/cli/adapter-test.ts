/**
 * Kuru deneme: bir rakip sayfasını güvenli çekici ile alır, adaptörle ayrıştırır ve sonucu YAZDIRIR (veritabanına dokunmaz).
 * Yeni bir kaynak adaptörünü etkinleştirmeden önce şirket sunucusundan çalıştırın:
 *   npm run adapter:test -- https://www.ornek.com/urun [adaptör-anahtarı] [--dump]
 * Dikkat: gerçek siteye TEK istek gider. Sitenin kullanım şartlarına ve robots.txt kurallarına uyun.
 */
import fs from 'node:fs';
import { safeFetch } from '../ssrf';
import { getAdapter } from '../extract';

async function main() {
  const [url, key = 'generic-html'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!url) { console.error('Kullanım: adapter-test <url> [adaptör] [--dump]'); process.exit(1); }
  const res = await safeFetch(url);
  console.log(`HTTP ${res.status} · ${res.body.length} bayt · ${res.contentType}`);
  if (process.argv.includes('--dump')) { fs.writeFileSync('adapter-test-sayfa.html', res.body); console.log('Sayfa adapter-test-sayfa.html dosyasına yazıldı (depoya eklemeyin).'); }
  const out = getAdapter(key).extract(res.body, {});
  console.log(JSON.stringify(out, null, 2));
  if (!out.salePrice) { console.error('\nFiyat bulunamadı: bu kaynak için seçici/adaptör yapılandırması gerekir.'); process.exit(2); }
}
main().catch((e) => { console.error('Hata:', e.message); process.exit(1); });
