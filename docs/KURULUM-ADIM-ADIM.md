# Ragyu Pazar ve Fiyat Analiz Merkezi: Sunucuya Adım Adım Kurulum (A'dan Z'ye)

Bu doküman, teknik bilgisi az olan biri de izleyebilsin diye yazıldı. Her adımda ne yaptığınız, hangi komutu yazacağınız ve doğru çalıştığını nasıl anlayacağınız var. Teknik ayrıntılar için: [KURULUM.md](KURULUM.md).

> **Dürüst not:** Bu adımlar kodu ve yapılandırma dosyalarını inceleyerek hazırlandı. Docker imajları geliştirme ortamında **derlenemedi**, yani bu kurulum gerçek bir şirket sunucusunda **henüz denenmedi**. İlk kurulumda bir adım beklenenden farklı çıkarsa çıktıyı kaydedip bize iletin. Dokümanın sonundaki "Doğrulama" bölümü bunun için var.

---

## 0. Başlamadan önce hazırlayın

| Gereken | Açıklama |
|---|---|
| Linux sunucu | Ubuntu 22.04/24.04 önerilir. En az 2 GB RAM, 20 GB disk. |
| Sunucuya SSH erişimi | IT'nin verdiği kullanıcı (sudo yetkili) ve adres. Windows'tan: PowerShell'de `ssh kullanici@sunucu-adresi` |
| Alan adı | Örn. `fiyat.sirketiniz.com.tr`. DNS kaydı (A kaydı) sunucunun IP'sine işaret etmeli. Yoksa şirket içi ad kullanılır (bölüm 5). |
| Açık portlar | Dışarıya yalnızca 80 ve 443 (ve yönetim için 22). Veritabanı portları zaten dışarı açılmaz. |
| Depo erişimi | `github.com/Velvetfoxgroup/ragyu-pazar-analiz`. Depo özelse GitHub'dan kişisel erişim anahtarı (token) gerekir; olmazsa bölüm 2'deki ZIP yolunu kullanın. |
| Dosyalar | `data/ragyu-katalog.csv` depoda hazırdır. Rakip URL CSV'si (PriceRest "Tüm Satıcı URL'leri") sizde. |

---

## 1. Sunucuyu hazırlama (Docker ve Git)

SSH ile bağlanın, sonra:

```bash
sudo apt update && sudo apt install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh        # Docker Engine + Compose eklentisi
sudo usermod -aG docker $USER                      # sudo'suz docker kullanmak için
```
Oturumu kapatıp tekrar bağlanın (grup değişikliği için), sonra kontrol:
```bash
docker --version
docker compose version        # 2.24 veya üstü olmalı
```
Güvenlik duvarı (Ubuntu `ufw` kullanıyorsanız; IT başka bir yöntem kullanıyorsa onlara aynı kuralı iletin):
```bash
sudo ufw allow 22 && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
```
> `ufw enable` öncesinde 22'nin açık olduğundan emin olun, yoksa bağlantınız kopar.

---

## 2. Uygulamayı sunucuya alma

**Yol A: git (önerilen, güncellemesi kolay)**
```bash
sudo mkdir -p /srv && sudo chown $USER /srv && cd /srv
git clone https://github.com/Velvetfoxgroup/ragyu-pazar-analiz.git
cd ragyu-pazar-analiz
```
Depo özelse parola istenir: GitHub kullanıcı adınız ve parola yerine kişisel erişim anahtarı (token) yazılır.

**Yol B: ZIP (git kullanmak istemezseniz)**
GitHub'da depo sayfası → Code → Download ZIP. Windows'tan sunucuya kopyalayın (WinSCP ya da `scp ragyu.zip kullanici@sunucu:/srv/`), sonra:
```bash
cd /srv && sudo apt install -y unzip && unzip ragyu.zip
mv ragyu-pazar-analiz-main ragyu-pazar-analiz && cd ragyu-pazar-analiz
```
(ZIP ile kurarsanız güncelleme için yeni ZIP'i aynı şekilde açmanız gerekir.)

Bundan sonraki tüm komutlar `/srv/ragyu-pazar-analiz` klasöründe çalıştırılır.

---

## 3. Şifreler ve `.env` dosyası

Uygulamanın tüm gizli ayarları `.env` dosyasındadır. **Bu dosya depoya konmaz ve kimseyle paylaşılmaz.**

```bash
cp .env.example .env && chmod 600 .env
```
Üç rastgele şifre üretin (her biri için komutu ayrı çalıştırıp çıktıyı not edin):
```bash
openssl rand -hex 24
```
Dosyayı açın: `nano .env`. Şunları değiştirin (nano'da kaydet: `Ctrl+O`, Enter; çık: `Ctrl+X`):

| Satır | Ne yazılacak |
|---|---|
| `APP_DOMAIN` | Alan adınız, örn. `fiyat.sirketiniz.com.tr` |
| `POSTGRES_PASSWORD` | 1. rastgele şifre |
| `REDIS_PASSWORD` | 2. rastgele şifre |
| `DATABASE_URL` | `postgres://ragyu:` **1. şifre** `@db:5432/ragyu` (şifre aynen aynı olmalı) |
| `REDIS_URL` | `redis://:` **2. şifre** `@redis:6379` |
| `SETUP_TOKEN` | 3. rastgele şifre (en az 16 karakter; ilk yönetici kurulumunda gerekir) |

Dokunmayın: `SCRAPER_ALLOW_HOSTS` boş kalmalı, `COOKIE_SECURE=true`, `TRUST_PROXY=true`.
Şifreleri güvenli bir yerde (şirketin şifre yöneticisi) saklayın.

---

## 4. Erişimi sınırlama (önerilir)

Varsayılan olarak adres internetten herkese açıktır (giriş yine şifrelidir). Yalnızca şirket ağı/VPN girsin istiyorsanız `.env` içinde:
```
ALLOWED_CIDRS=10.0.0.0/8 192.168.0.0/16
```
Kendi ofis/VPN IP aralığınızı IT'den öğrenin. Yanlış yazarsanız kendinizi dışarıda bırakırsınız; emin değilseniz önce varsayılanla kurup sonra daraltın.

---

## 5. HTTPS (güvenli bağlantı)

- **Genel alan adı** (internetten erişilen): Ek iş yok. Uygulama sertifikayı kendisi alır (Let's Encrypt). 80 ve 443 internetten erişilebilir olmalı, DNS kaydı doğru olmalı.
- **Yalnızca şirket içi ad** (internetten erişilmeyen): `.env` içine `TLS_MODE=tls internal` ekleyin. Tarayıcılar ilk girişte "güvenli değil" uyarısı verir; IT'nin kök sertifikayı çalışan bilgisayarlarına eklemesi gerekir (ayrıntı KURULUM.md bölüm 4).

---

## 6. Başlatma

```bash
docker compose up -d --build
```
İlk seferde birkaç dakika sürer (imajlar derlenir). Sonra:
```bash
docker compose ps
```
Beklenen: `db`, `redis`, `api` (healthy), `worker`, `web`, `proxy` hepsi "running". Birkaç dakika bekleyip tekrar bakın. Bir servis sürekli yeniden başlıyorsa: `docker compose logs --tail 50 <servis>` çıktısını bize gönderin.

Tarayıcıda `https://APP_DOMAIN` açın; giriş ekranı gelmeli.

Sunucu yeniden başlarsa servisler kendiliğinden kalkar (`restart: unless-stopped`).

---

## 7. İlk yönetici hesabı

Tarayıcıda `https://APP_DOMAIN/kurulum` adresine gidin: `.env`'deki `SETUP_TOKEN`, kendi kullanıcı adınız, adınız ve şifreniz (en az 10 karakter, harf+rakam). Hesap açılınca bu sayfa kapanır.

Tarayıcı kullanmak istemezseniz: `docker compose exec -it api node packages/core/dist/cli/create-admin.js`

Kurulumdan sonra `.env`'den `SETUP_TOKEN` satırını silip `docker compose up -d` çalıştırabilirsiniz.

---

## 8. Veriyi nasıl dolduracaksınız? İki seçenek

### Seçenek 1: Temiz başlangıç (önerilen)
Bugünkü bilgisayardaki (localhost) demo verisini taşımazsınız; gerçek veriyi sıfırdan yüklersiniz. Demo kaynakları ve sahte rakipler hiç gelmez.

1. **Katalog:** Giriş yapın → İçe / dışa aktar → katalog içe aktarma → `data/ragyu-katalog.csv` (depoda; kendi bilgisayarınıza indirip yükleyin). Türetilmiş gramajları ürün sorumlusuna doğrulatın.
2. **Rakip URL'leri:** İçe / dışa aktar → "Rakip URL'lerini toplu içe aktar" → PriceRest "Tüm Satıcı URL'leri" CSV'si. Kaynaklar kendiliğinden oluşur, URL'ler pasiftir.
3. **Öneriler (isteğe bağlı):** "Rakip ürün önerilerini içe aktar".
4. Bölüm 10 (adaptör doğrulama) ve 11 (etkinleştirme) ile devam edin.

Artı: temiz, demo kalıntısı yok. Eksi: yaptığınız onaylar/düzeltmeler yeniden yapılır; localhost'ta yaptıklarınız gelmez.

### Seçenek 2: Bugünkü localhost verisini sunucuya taşıma
Localhost'taki kullanıcılar, 268 URL, onaylar, düzeltmeler aynen gelir. Dikkat: içinde **demo kaynakları** da vardır (sonra temizlenir) ve localhost'taki **kullanıcı hesapları/şifre özetleri** gelir.

**a) Localhost'ta (Windows, proje klasöründe PowerShell) yedek alın.** `>` ile dosyaya yönlendirmeyin: PowerShell ikili dosyayı bozar. Şu yolu kullanın:
```powershell
docker compose -f docker-compose.yml -f docker-compose.demo.yml exec -T db pg_dump -U ragyu -d ragyu -Fc -f /tmp/tasima.dump
docker compose -f docker-compose.yml -f docker-compose.demo.yml cp db:/tmp/tasima.dump .\tasima.dump
```
`tasima.dump` dosyası proje klasöründe oluşur (`.gitignore`'dadır; depoya girmez). Bu dosya kullanıcı bilgisi içerir, güvenli taşıyın.

**b) Sunucuya kopyalayın:**
```powershell
scp .\tasima.dump kullanici@sunucu:/srv/
```
**c) Sunucuda, bölüm 6'ya kadar kurulum bitmişken (`docker compose ps` yeşil) geri yükleyin:**
```bash
cd /srv/ragyu-pazar-analiz
./deploy/restore.sh /srv/tasima.dump        # "evet" yazın
```
> Bu işlem sunucudaki veritabanının üzerine yazar. Bölüm 7'de açtığınız yönetici hesabı gider; localhost'taki hesaplarla giriş yaparsınız. Sunucuda yeni veri varsa önce `./deploy/backup.sh /srv/yedekler` alın.

**d) Demo kalıntısını temizleyin** (önce sayar, sonra siler; geri alınamaz):
```bash
docker compose exec api node_modules/.bin/tsx packages/core/src/cli/demo-temizle.ts
docker compose exec api node_modules/.bin/tsx packages/core/src/cli/demo-temizle.ts --onayla
```
**e)** Giriş yapıp ürünlerin ve Kaynaklar sayfasının geldiğini kontrol edin. Sonra `./deploy/dogrula.sh https://APP_DOMAIN` (bölüm 13).

Bu yöntem sunucuda denenmedi; ilk kez yapıyorsanız önce taşıma öncesi localhost'tan ikinci bir yedek tutun (aynı komut).

| | Temiz başlangıç | Localhost'u taşı |
|---|---|---|
| Hız | Orta (CSV yükleme) | Hızlı |
| Demo kalıntısı | Yok | Temizlemek gerekir |
| Önceki onaylar/düzeltmeler | Yeniden | Korunur |
| Risk | Düşük | Orta (restore üzerine yazar) |

---

## 9. Çalışan hesapları ve roller

Yönetici → **Çalışan hesapları → Çalışan hesabı aç**: kullanıcı adı, ad soyad, rol. Sistem geçici şifreyi **bir kez** gösterir; çalışana güvenli kanaldan iletin. İlk girişte şifreyi değiştirmek zorundadır. Her çalışanın ayrı hesabı olmalı.

| Rol | Ne yapabilir |
|---|---|
| Sistem yöneticisi | Hesaplar, kaynaklar, ayarlar, tüm veriler, denetim |
| E-ticaret editörü | Ürünler, rakip URL'leri, eşleşme önerisi/reddi, raporlar |
| Onay yetkilisi | Eşleşme ve gramaj onayları, "şimdi kontrol et" |
| Salt okunur yönetici | Panel ve raporları görür, değiştiremez |

Şifre unutulursa: Çalışan hesapları → Şifre sıfırla.

---

## 10. Rakip sitelerde ilk deneme (adaptör doğrulama)

Rakip site adaptörleri kayıtlı sayfalarla yazıldı; **canlı sitelerde sizin sunucunuzdan doğrulanmalı**. Tek ürün için, veritabanına yazmadan:
```bash
docker compose exec api node_modules/.bin/tsx packages/core/src/cli/adapter-test.ts "https://www.etineniyisi.com/ornek-urun-adresi"
```
Fiyat ve ürün adı çıkıyorsa tamam. "Fiyat bulunamadı" çıkarsa çıktıyı (`--dump` ile sayfa kaydı) bize gönderin. 404, 508 gibi hatalar sitenin kendi sorunu olabilir; tarayıcıda elle kontrol edin.

---

## 11. Rakip takibini açma

Kaynaklar sayfası → kaynak bazında **"N pasif URL'yi etkinleştir"**. Önce bir iki kaynakla başlayıp sonuçları izleyin. Eşleşmeler sayfasında onay yetkilisi önerileri onaylar; onaysız eşleşmeler karşılaştırmaya girmez. Hatalı işler Kaynaklar sayfasında görünür; Raporlar sekmelerinden sonuçlar izlenir.

---

## 12. Yedekleme ve geri yükleme

Elle yedek:
```bash
./deploy/backup.sh /srv/yedekler
```
Her gece 03:00 otomatik yedek: `crontab -e` açıp şu satırı ekleyin:
```
0 3 * * * cd /srv/ragyu-pazar-analiz && ./deploy/backup.sh /srv/yedekler
```
30 günden eski yedekler otomatik silinir. Yedekleri başka bir makineye/diske de kopyalayın (aynı sunucuda kalan yedek, sunucu bozulursa kaybolur). Yedekte kullanıcı bilgileri vardır, erişimi kısıtlayın.

Geri yükleme (mevcut veritabanının üzerine yazar):
```bash
./deploy/restore.sh /srv/yedekler/ragyu-YYYYMMDD-HHMMSS.dump
```
Geri yükleme betiğini gerçek veri girmeden önce bir kez deneyin: yedek al, bir ürün ekle, geri yükle, eklediğin ürün kaybolmalı.

---

## 13. Doğrulama

```bash
./deploy/dogrula.sh https://APP_DOMAIN
```
Servislerin çalıştığını, veritabanı/Redis'in dışarı kapalı olduğunu, `.env` izinlerini, HTTPS'i, oturumsuz isteğin reddedildiğini ve yedeğin alınabildiğini kontrol eder. Hepsi **[OK]** olmalı. `[HATA]` satırlarını bize iletin.

---

## 14. Güncelleme

Yeni sürüm geldiğinde (git ile kurulduysa):
```bash
cd /srv/ragyu-pazar-analiz
./deploy/backup.sh /srv/yedekler        # önce yedek
git pull
docker compose up -d --build
docker compose ps
```
Veritabanı değişiklikleri açılışta kendiliğinden uygulanır. Veriler korunur (Docker birimlerinde durur). `.env` dosyası `git pull` ile değişmez.

---

## 15. Sık karşılaşılan sorunlar

| Belirti | Olası neden / çözüm |
|---|---|
| Site açılmıyor | `docker compose ps` ile servisleri kontrol edin; DNS kaydı ve 80/443 portları açık mı? |
| HTTPS sertifikası alınamıyor | DNS sunucuya işaret etmiyor ya da 80/443 dışarıdan kapalı. `docker compose logs proxy` |
| Tarayıcıda "güvenli değil" | `TLS_MODE=tls internal` kullanıyorsanız beklenen; kök sertifikayı ekleyin |
| `api` "unhealthy" | `.env` şifreleri `DATABASE_URL`/`REDIS_URL` ile aynı mı? `docker compose logs api` |
| Şifreyi değiştirdim, bağlanamıyor | Veritabanı şifresi ilk kurulumda belirlenir; sonradan yalnızca `.env`'i değiştirmek yetmez. Yeni şifre gerekiyorsa yardım isteyin |
| Kurulum sayfası "409" | Yönetici zaten var; normal giriş sayfasını kullanın |
| Yönetici şifresini unuttum | `docker compose exec -it api node packages/core/dist/cli/create-admin.js` ile yeni yönetici açın |
| Bir rakip site "Fiyat bulunamadı" | Bölüm 10; sitenin kendisi de hata veriyor olabilir (404/508) |
| Disk doluyor | `docker system prune -f` (kullanılmayan imajlar); eski yedekleri kontrol edin |
| Tüm servisleri durdurma/başlatma | `docker compose stop` / `docker compose start` (veriler silinmez). `docker compose down -v` **veriyi siler**, asla kullanmayın |

---

## Kısa kontrol listesi

- [ ] Sunucu, alan adı, portlar hazır
- [ ] Docker ve git kuruldu
- [ ] Depo alındı, `.env` dolduruldu (`chmod 600`)
- [ ] `docker compose up -d --build`, tüm servisler running
- [ ] `/kurulum` ile yönetici açıldı
- [ ] Veri: temiz başlangıç **ya da** localhost yedeği geri yüklendi (+ demo temizlendi)
- [ ] `dogrula.sh` hepsi [OK]
- [ ] Gece yedeği (cron) kuruldu, bir test geri yüklemesi yapıldı
- [ ] Çalışan hesapları açıldı
