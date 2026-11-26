# Ragyu Pazar ve Fiyat Analiz Merkezi

Ragyu Kasap+ için şirket sunucusunda çalışan rakip fiyat ve pazar analiz uygulaması.
Next.js (arayüz) · NestJS (API) · PostgreSQL · Redis/BullMQ (iş kuyruğu) · bağımsız veri toplama işçisi.

- Kurulum (sunucu, HTTPS, ilk yönetici, çalışan hesabı, şifre sıfırlama, yedekleme): [docs/KURULUM.md](docs/KURULUM.md)
- Gereksinimler, modül haritası, veri akışı, veri modeli, formüller, varsayımlar: [docs/MIMARI.md](docs/MIMARI.md)

## Hızlı başlangıç (yerel demo, Docker Compose)
**Windows (PowerShell, Docker Desktop):**
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\deploy\demo.ps1
```
Betik `.env` yoksa rastgele parolalarla üretir (depoda sabit şifre yok), demoyu başlatır, örnek veriyi yükler ve kurulum anahtarını yazdırır. Demo yalnızca bu bilgisayardan açılır: **http://localhost:8080** (ilk yönetici: http://localhost:8080/kurulum).

**Linux/macOS:** `cp .env.example .env`, değerleri doldurun (`APP_DOMAIN=http://localhost`, `COOKIE_SECURE=false`), sonra:
```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
docker compose exec api node_modules/.bin/tsx apps/sample-site/seed.ts   # katalog + DEMO rakipler
```
Demo verisi **gerçek rakip verisi değildir**; yerel bir sahte rakip sitesinden gelir. Varsayılan kullanıcı/şifre yoktur; ilk yönetici için docs/KURULUM.md.

## Geliştirme
```bash
npm install && npm run build -w @ragyu/core
npm run migrate && npm run dev:api & npm run dev:worker & npm run dev:web
npm test      # TEST_DATABASE_URL (PostgreSQL) gerekir; QUEUE_MODE=inline ile Redis'siz çalışır
```
