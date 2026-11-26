# Mimari ve gereksinim özeti

## 1. Ekran görüntülerinden çıkarılan iş akışları (PriceRest referansı; arayüz/kod kopyalanmadı)
- **Gösterge paneli:** "N üründen M tanesinde en ucuzsun"; konum dağılımı (En ucuz, Aynı, Ortalamadan ucuz, Ortalama, Ortalamadan pahalı, En pahalı); dikkat kartları (eşleşme bekleyen, stok dışı, rakipsiz ürün); en ucuz/benden ucuz satıcı sıralamaları; rakip site kapsama tablosu. → `GET /api/dashboard`, `/`.
- **Ürünler (tablo/kart):** konum rozeti, stok, kendi fiyat, rakip min/ort/maks, rakip sayısı, filtre çipleri. → `/urunler`; geniş yatay tablo yerine temel karar sütunları + ürün detayında ayrıntı.
- **Fiyat karşılaştırma / 5 en ucuz / seçilen satıcı / özet / haftalık:** `/raporlar` (hepsi Excel'e aktarılır; "liste fiyatı", "kargo dahil" seçenekleri raporda açıkça etiketlenir).
- **Satış performansı:** gerçek satış verisi gerektirir; entegrasyon yoksa uydurma sayı üretilmez, açıklama gösterilir.
- **Fiyatlama kuralları** (ekranda boş) ve **kampanyalar**: ilk sürümde yok; boş menü olarak da gösterilmedi. Fiyat öneri motoru sonraki aşama.
- Ekran görüntülerindeki çok sayıda *eşleşmeyen ürün* → `/eslesmeler` çalışma kuyruğu.
- Görünen rakipler: fumeci.com, macrocenter.com.tr, market.amasyaeturunleri.com.tr, nebyandogal.com, organikasap.com, tazedirekt.com, etineniyisi.com (+ panelde dilekgurme.com, migros.com.tr). **Bunlara karşı hiçbir doğrulama yapılmadı;** adaptörleri (kaynak başına) gerçek sayfalar incelenerek yazılmalıdır.

## 2. Modül haritası
```
packages/core   domain + veri erişimi (TypeScript)
  units.ts      gramaj/birim normalizasyonu, TL/kg (decimal.js), fiyat ayrıştırma, TRY biçimi
  matching.ts   et nitelikleri çıkarımı, uyuşmazlık tespiti, benzerlik önerisi
  ssrf.ts       URL doğrulama, güvenli çekici (DNS doğrulama, yönlendirme kontrolü, zaman aşımı, boyut sınırı)
  extract.ts    kaynak adaptörleri (generic-html: JSON-LD/meta/seçici; ornek-market) + kayıt defteri
  scrape.ts     tek URL kontrolü (runCheck), kalite kuralları, uyarılar, zamanlayıcı seçimi (claimDue)
  reports.ts    karşılaştırma, en ucuz, satıcı kıyası, özet, dönemsel değişim, panel, çalışma listesi, Excel
  auth.ts, db.ts, queue.ts
apps/api        NestJS: auth, users, catalog, competitors (kaynak/URL/eşleşme/gramaj), reports, misc
apps/worker     BullMQ işçisi + dakikalık zamanlayıcı + bakım (bağımsız süreç)
apps/web        Next.js arayüz (Türkçe; metinler messages/tr.ts, lib/i18n.ts → İngilizce eklemek için en.ts)
apps/sample-site  yerel DEMO rakip sitesi + demo verisi (seed.ts)
migrations/     SQL geçişleri (schema_migrations ile izlenir)
```

## 3. Veri akışı
`Ragyu varyantı ⇄ eşleşme (product_links) ⇄ rakip ürünü (competitor_products) ⇄ izlenen URL (tracked_urls) → tarama (scrape_runs) → fiyat gözlemi (price_observations)`.
1. Zamanlayıcı zamanı gelen URL'leri seçer (`FOR UPDATE SKIP LOCKED` + 10 dk kira) ve kuyruğa atar; "Şimdi kontrol et" aynı kuyruğa öncelikli iş atar ve sonucu bekler.
2. İşçi sayfayı güvenli çeker, kaynağın adaptörüyle ayrıştırır, gramajı belirler (onaylı düzeltme > sayfa > elle girilen beklenen paket), kalite kurallarını uygular, gözlemi **her zaman ham haliyle** saklar; kaliteli ise `ok`, şüpheli ise `review`.
3. Hata veya sayfa yapısı değişikliğinde **gözlem yazılmaz**, `last_error`/hata sayacı güncellenir (üstel geri çekilme), 3 ardışık hatada (veya yapı bozulmasında) uyarı açılır. Eski fiyat "yeni gözlem" olmaz; raporlar gözlemin zamanını gösterir ve kaynağın `stale_after_hours` süresini aşan veriyi dışlar.
4. Raporlar, istenen anda geçerli son gözlemi kullanır (`observed_at <= asOf`).

## 4. Veri modeli (özet)
`organizations` · `users`(rol) · `sessions` · `login_attempts` · `audit_log` · `products` (nitelikler `attrs`) · `product_variants` (paket miktarı/birimi, TRY `numeric`) · `own_price_history` · `sources` (site, adaptör, aralık, güncellik eşiği) · `sellers` · `competitor_products` · `product_links` (öneri/inceleme/onay/red/geçersiz + uyuşmazlıklar) · `tracked_urls` (`replaced_by` ile URL değişim zinciri) · `scrape_runs` · `qty_overrides` (kim, onaylayan, geçerlilik aralığı) · `price_observations` (ham fiyat, liste/satış, kargo, kampanya, çoklu alım, stok, gözlemin URL'si ve tarama kimliği, kalite + gerekçe) · `alerts` · `import_runs`. Parasal ve miktar alanları `numeric`; uygulamada `decimal.js` (kayan nokta yok).

**Çok kiracılılık:** her iş tablosu `org_id` taşır, her API sorgusu oturumun `org_id` değeriyle sınırlanır (testle doğrulandı). Yetki rol matrisi `auth.ts`'dedir. *Sınır:* ayrım şu an uygulama katmanındadır; grup şirketleri aşamasında PostgreSQL satır düzeyi güvenlik (RLS) ve ayrı uygulama rolü eklenmelidir.

## 5. Formüller
- **Birim fiyat (TL/kg)** = paket fiyatı ÷ (gramaj_g ÷ 1000). 400 g / 320 TL → 800 TL/kg. Gramaj çarpanı = 1000 ÷ gramaj_g. ml/l yalnızca kendi ailesinde (TL/l). Adet bazlı ve gramajı bilinmeyen teklifler kg ile kıyaslanmaz.
- **Güvenilir teklif:** onaylı eşleşme ∧ Ragyu'nun kendi ilanı değil ∧ kalite `ok` ∧ gramaj biliniyor ∧ birim ailesi uyumlu ∧ veri güncel ∧ çoklu alım şartı yok ∧ stok filtresi (varsayılan: stokta olanlar). Dışlanan teklif silinmez; neden etiketiyle ürün detayında ve raporda görülür.
- **Konum:** R = Ragyu TL/kg; c = güvenilir rakip TL/kg. R<min → En ucuz; R=min → Aynı; R>maks → En pahalı; |R−ort| ≤ %2·ort → Ortalama; R<ort → Ortalamadan ucuz; aksi Ortalamadan pahalı. Fark TL = R−min; Fark % = (R−min)/min·100; sıra = 1 + #{c<R}.
- **Kargo dahil:** yalnızca kargo ücreti bilinen tekliflere eklenir; açıkça rapor başlığında ve Excel'de "Kargo ücreti dahil: EVET/HAYIR" yazar. Ragyu fiyatına kargo eklenmez.
- **Dönemsel değişim:** başlangıç ve bitiş anındaki geçerli güvenilir gözlemler karşılaştırılır; bugünkü fiyat geçmişe uygulanmaz. Ragyu'nun geçmiş fiyatı `own_price_history`'den okunur.
- **Fiyat sıçraması:** önceki güvenilir gözleme göre birim fiyat farkı > %40 (`PRICE_JUMP_THRESHOLD`) → `review` + uyarı; yetkili kullanıcı uyarıdan "Fiyatı kabul et" ile onaylayabilir.

## 6. Güvenlik özeti
scrypt şifre özeti · parola politikası · giriş hız sınırı (kullanıcı+IP) · sunucu tarafı oturum (HttpOnly, SameSite=Strict, boşta/mutlak süre) · CSRF için özel başlık · API'de rol denetimi · SSRF koruması (şema, port, DNS çözümlemesi, özel IP aralıkları, yönlendirmeler) · denetim kaydı · PostgreSQL/Redis dış ağa kapalı.

## 7. Varsayımlar
1. Excel'deki "Fiyat" değerleri paket fiyatı kabul edildi; Excel'de gramaj yok → **demoda** ilk 30 ürün 500 g (fiyat/2), kalanı 1 kg. Gerçek gramajlar içe aktarma ile girilmelidir.
2. Editörün elle eklediği URL eşleşmesi "inceleme bekliyor" olur; onay yetkilisi/yönetici eklerse doğrudan onaylı olur.
3. Uyuşmazlık görünen eşleşmeyi onaylamak gerekçe ister.
4. Tek şirket (Ragyu); `org_id` ileriye dönük.
5. Zamanlama: kaynak başına varsayılan 360 dk; güncellik eşiği 48 saat; kaynağa istekler arası ≥2 sn.

## 8. Doğrulananlar / doğrulanmayanlar
Çalışıyor (test + yerel çalıştırma): giriş/roller/API yetkisi, katalog, içe aktarma hata raporu, manuel URL, şimdi kontrol et, planlı yeniden kontrol, URL değişiminde geçmiş, bozuk sayfa davranışı, gramaj belirsizliği, 500 g↔400 g TL/kg, haftalık rapor, Excel dışa aktarım, denetim kaydı, demo kaynaklarla tarama.
**Bekliyor / doğrulanmadı:** gerçek rakip siteleri (kaynak başına adaptör), Ticimax katalog/fiyat bağlantısı, satış verisi, Docker imajlarının gerçek ortamda derlenmesi, e-posta ile şifre sıfırlama (bilinçli olarak yok).

## 9. Sonraki aşamalar
Fiyat öneri motoru (maliyet, hedef marj, onay akışı, Ticimax'e yazma) · gelişmiş/AI destekli ürün keşfi ve eşleştirme (öneri → insan onayı akışı hazır) · grup şirketleri (RLS, şirket bazlı roller) · kampanya ve satış performansı (satış verisi entegrasyonuyla) · İngilizce arayüz.
