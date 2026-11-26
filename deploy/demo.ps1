# Yerel DEMO başlatıcı (Windows / PowerShell, Docker Desktop). Depoda sabit şifre yoktur:
# .env yoksa rastgele parolalarla bu bilgisayarda üretilir (.env depoya eklenmez, .gitignore'dadır).
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\deploy\demo.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function New-Secret([int]$len = 32) {
  $bytes = New-Object byte[] $len
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '').Substring(0, [Math]::Min($len, 24))
}

if (Test-Path .env) {
  Write-Host ".env zaten var; mevcut değerler kullanılacak (yeniden üretmek için dosyayı silin)." -ForegroundColor Yellow
} else {
  $pg = New-Secret; $redis = New-Secret; $setup = New-Secret
  $lines = @(
    'APP_DOMAIN=http://localhost',
    'TLS_MODE=',
    'ALLOWED_CIDRS=0.0.0.0/0 ::/0',
    "POSTGRES_PASSWORD=$pg",
    "REDIS_PASSWORD=$redis",
    "DATABASE_URL=postgres://ragyu:$pg@db:5432/ragyu",
    "REDIS_URL=redis://:$redis@redis:6379",
    "SETUP_TOKEN=$setup",
    'COOKIE_SECURE=false',
    'TRUST_PROXY=true',
    'SESSION_IDLE_MINUTES=60',
    'SESSION_MAX_HOURS=12',
    'LOGIN_MAX_FAILS=5',
    'SCRAPER_ALLOW_HOSTS=',
    'API_URL=http://api:4000',
    'NODE_ENV=production'
  )
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) '.env'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ".env oluşturuldu (rastgele parolalar)." -ForegroundColor Green
}

docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
if ($LASTEXITCODE -ne 0) { throw "docker compose başarısız oldu; çıktıyı kontrol edin." }

Write-Host "API'nin hazır olması bekleniyor..."
for ($i = 0; $i -lt 60; $i++) {
  $st = docker compose ps api --format '{{.Health}}' 2>$null
  if ($st -match 'healthy') { break }
  Start-Sleep -Seconds 3
}
docker compose exec api node_modules/.bin/tsx apps/sample-site/seed.ts

$token = (Get-Content .env | Where-Object { $_ -like 'SETUP_TOKEN=*' }) -replace '^SETUP_TOKEN=', ''
Write-Host ""
Write-Host "Hazır. Tarayıcıda açın:  http://localhost:8080" -ForegroundColor Green
Write-Host "İlk yönetici kurulum sayfası: http://localhost:8080/kurulum"
Write-Host "Kurulum anahtarı (SETUP_TOKEN): $token"
Write-Host "Yönetici kullanıcı adını ve parolayı (en az 10 karakter, harf+rakam) siz belirlersiniz."
