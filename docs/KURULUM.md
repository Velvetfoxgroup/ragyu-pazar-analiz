# Sunucu kurulumu

> Durum notu: Docker Compose dosyaları sözdizimi olarak doğrulandı (`docker compose config`), ancak geliştirme ortamında Docker daemon olmadığından imajlar **derlenip çalıştırılmadı**. Uygulama bileşenleri (API, işçi, web, PostgreSQL, Redis) Docker dışında çalıştırılarak uçtan uca doğrulandı. İlk kurulumda `docker compose up --build` çıktısını kontrol edin.

## 1. Gereksinimler
Linux sunucu, Docker Engine + Compose eklentisi, en az 2 GB RAM, bir alan adı (DNS kaydı sunucuya işaret etmeli).

## 2. Yapılandırma
```bash
git clone https://github.com/velvetfoxgroup/ragyu-pazar-analiz.git && cd ragyu-pazar-analiz
cp .env.example .env && chmod 600 .env
```
`.env` içinde: `APP_DOMAIN`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD` (aynı parolaları `DATABASE_URL` ve `REDIS_URL` içine de yazın), `SETUP_TOKEN` (≥16 karakter). Rastgele değer: `openssl rand -base64 32`. **`.env` depoya eklenmez** (.gitignore'dadır). `SCRAPER_ALLOW_HOSTS` canlıda boş kalmalıdır.

## 3. Başlatma
```bash
docker compose up -d --build
docker compose ps                      # db, redis, api (healthy), worker, web, proxy
curl -k https://APP_DOMAIN/api/health  # {"status":"ok",...}
```
Veritabanı geçişleri API açılırken otomatik uygulanır (`migrations/`). Yalnızca `proxy` servisi 80/443 portlarını açar; **PostgreSQL ve Redis hiçbir porta yayınlanmaz**, yalnızca Docker iç ağından erişilir. Güvenlik duvarında yalnızca 80/443 (ve yönetim için SSH) açık olmalıdır.

## 4. HTTPS ve erişim sınırlama
- Genel alan adı: Caddy, Let's Encrypt sertifikasını otomatik alır/yeniler (80 ve 443 internetten erişilebilir olmalı).
- Şirket içi alan adı: `.env` → `TLS_MODE=tls internal` (Caddy'nin iç CA'sı; kök sertifikayı çalışan bilgisayarlarına güvenilir olarak ekleyin) veya `deploy/Caddyfile` içinde kendi sertifikanızı `tls /yol/cert.pem /yol/key.pem` ile tanımlayın.
- Erişimi yalnızca şirket ağı/VPN ile sınırlamak için `.env` → `ALLOWED_CIDRS="10.0.0.0/8 192.168.0.0/16"` (VPN çıkış adresleri dahil). Yetki verilmiş dış kullanıcılar için kendi sabit IP'lerini listeye ekleyin. Varsayılan herkese açıktır; **canlıda daraltın**. Ek katman olarak sunucu güvenlik duvarında da aynı kısıtı uygulayın.
- `COOKIE_SECURE=true` ve `TRUST_PROXY=true` canlıda açıktır.

## 5. İlk yönetici
Varsayılan kullanıcı veya şifre yoktur. Sistemde hiç kullanıcı yokken iki yoldan biri:
1. Tarayıcıda `https://APP_DOMAIN/kurulum` → `.env`'deki `SETUP_TOKEN`, kullanıcı adı, ad, şifre (≥10 karakter, harf+rakam). Kullanıcı oluştuktan sonra bu uç kapanır (409).
2. Komut satırı: `docker compose exec -it api node packages/core/dist/cli/create-admin.js` (şifre ekrana yazılmaz). Ortam değişkeniyle de verilebilir: `ADMIN_USERNAME`, `ADMIN_DISPLAY_NAME`, `ADMIN_PASSWORD`.
Kurulumdan sonra `SETUP_TOKEN` satırını `.env`'den silip `docker compose up -d` çalıştırabilirsiniz.

## 6. Çalışan hesabı açma
Yönetici → **Çalışan hesapları → Çalışan hesabı aç**: kullanıcı adı, ad soyad, rol. Sistem güvenli bir geçici şifre üretir ve **bir kez** gösterir; çalışana güvenli kanaldan iletin. Çalışan ilk girişte şifresini değiştirmek zorundadır. Her çalışanın ayrı hesabı olmalıdır; herkese açık kayıt yoktur.

| Rol | Yetki |
|---|---|
| Sistem yöneticisi | Hesaplar, kaynaklar, sistem ayarları, tüm veriler, denetim |
| E-ticaret editörü | Ürünler, rakip URL'leri, eşleşme önerisi/reddi, gramaj düzeltmesi önerisi, raporlar |
| Onay yetkilisi | Eşleşme ve gramaj düzeltmesi onayları, denetim kaydı okuma, "şimdi kontrol et" |
| Salt okunur yönetici | Panel ve raporlar; veri değiştiremez |

Yetkiler API'de her istekte denetlenir (arayüzde menü gizlemek tek başına yeterli sayılmaz).

## 7. Şifre sıfırlama
E-posta altyapısı yoktur. Yönetici → Çalışan hesapları → **Şifre sıfırla**: yeni geçici şifre üretilir, çalışanın açık oturumları kapanır, ilk girişte değişim zorunlu olur. Yönetici şifresini unutursa: `docker compose exec -it api node packages/core/dist/cli/create-admin.js` ile yeni bir yönetici açın (sunucuya erişim yetkisi gerektirir).

## 8. Yedekleme ve geri yükleme
```bash
./deploy/backup.sh /srv/yedekler      # pg_dump (-Fc), 30 günden eskileri siler
# cron örneği (her gece 03:00):  0 3 * * * cd /srv/ragyu-pazar-analiz && ./deploy/backup.sh /srv/yedekler
./deploy/restore.sh /srv/yedekler/ragyu-YYYYMMDD-HHMMSS.dump   # mevcut veritabanının üzerine yazar
```
Yedek dosyaları kullanıcı bilgisi (şifre özeti) içerir: şifreli diske/erişimi kısıtlı bir yere koyun ve **depoya eklemeyin**. Düzenli olarak bir test geri yüklemesi yapın. Redis yalnızca iş kuyruğudur; kaybı veri kaybı değildir (zamanlayıcı işleri yeniden kuyruğa alır).

## 9. İşletim
- Veri toplama işçisi API'den bağımsızdır: `docker compose restart worker`.
- Günlükler: `docker compose logs -f api worker`.
- Güncelleme: `git pull && docker compose up -d --build` (geçişler otomatik).
- Kaynak başına hız sınırı (`min_interval_ms`), zaman aşımı (10 sn), yanıt boyutu (2 MB), en çok 3 yönlendirme; yerel/dahili adresler ve bunlara yönlendirmeler engellenir.

## 10. Demo
`docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build` ardından `docker compose exec api node_modules/.bin/tsx apps/sample-site/seed.ts`. Demo, yerel sahte rakip sitelerini tarar; geçmiş fiyat gözlemleri örnek amaçlı üretilmiştir (`raw.method = demo-backfill`). Gerçek rakip sitelerde doğrulama yapılmamıştır.

## 11. Gerçek katalog ve rakip URL'lerini yükleme (önerilen sıra)
1. **Katalog:** İçe aktar → `data/ragyu-katalog.csv` (PriceRest raporlarından: gerçek ürün kodları aynen, Ragyu paket fiyatı). Gramaj kaynağı sütunu (`gramaj_kaynagi`): ürün adında yazıyorsa o; yoksa Ragyu paket fiyatı ÷ kg fiyatı oranından **türetilmiştir** (16 satır "standart dışı, doğrulayın" etiketli, 3 satır gramajsız → `adet`, kg kıyasına girmez). Türetilmiş gramajları ürün sorumlusuna doğrulatın.
2. **Rakip URL'leri:** İçe aktar → "Rakip URL'lerini toplu içe aktar" (PriceRest "Tüm Satıcı URL'leri" CSV). Kayıtlar *inceleme bekliyor*, URL'ler *pasif* açılır. Ragyu'nun kendi sitesi (`OWN_DOMAINS`, varsayılan ragyu.com.tr) atlanır.
3. **Öneriler (isteğe bağlı):** "Rakip ürün önerilerini içe aktar" (PriceRest product_suggestions). Dosyadaki puana güvenilmez, yeniden hesaplanır; zayıflar alınmaz; hepsi *önerildi*.
4. **Adaptör doğrulama:** Şirket sunucusundan `npm run adapter:test -- <rakip ürün URL'si>` ile tek istekle ayrıştırmayı deneyin (veritabanına yazmaz). Fiyat bulunamazsa kaynak için `config.selectors` tanımlayın (Kaynaklar sayfası / API).
5. **Etkinleştirme:** Kaynaklar → "N pasif URL'yi etkinleştir" (kaynak bazında; ilk kontroller kaynağın istek aralığıyla kademelendirilir). Eşleşmeleri onay yetkilisi Eşleşmeler sayfasından onaylar; onaysızlar kıyasa girmez.
