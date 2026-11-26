#!/usr/bin/env bash
# Sunucuda kurulumdan sonra çalıştırın: ./deploy/dogrula.sh https://APP_DOMAIN
# Docker imajları geliştirme ortamında derlenemediği için bu kontroller ilk kurulumda sizin sunucunuzda yapılmalıdır.
set -u
URL="${1:-}"; ok=0; bad=0
chk() { if eval "$2" >/dev/null 2>&1; then echo "  [OK]   $1"; ok=$((ok+1)); else echo "  [HATA] $1"; bad=$((bad+1)); fi; }
echo "Servisler:"
for s in db redis api worker web proxy; do chk "$s çalışıyor" "docker compose ps --status running --services | grep -qx $s"; done
chk "api sağlıklı" "docker compose ps api | grep -q healthy"
echo "Ağ güvenliği:"
chk "db portu host'a yayınlanmıyor" "! docker compose port db 5432 2>/dev/null | grep -q ."
chk "redis portu host'a yayınlanmıyor" "! docker compose port redis 6379 2>/dev/null | grep -q ."
chk ".env dosya izni 600" "[ \"\$(stat -c %a .env)\" = 600 ]"
chk "SCRAPER_ALLOW_HOSTS boş" "! grep -E '^SCRAPER_ALLOW_HOSTS=.+' .env"
chk "COOKIE_SECURE=true" "grep -qE '^COOKIE_SECURE=true' .env"
if [ -n "$URL" ]; then
  echo "Uygulama ($URL):"
  chk "HTTPS yanıt veriyor, /api/health ok" "curl -fsS --max-time 15 $URL/api/health | grep -q ok"
  chk "HTTP, HTTPS'e yönleniyor" "curl -s -o /dev/null -w '%{http_code}' --max-time 15 ${URL/https:/http:} | grep -qE '30[1278]'"
  chk "oturumsuz API isteği 401" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 $URL/api/products)\" = 401 ]"
  chk "varsayılan admin/admin girişi reddediliyor" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H 'X-Requested-With: ragyu' -H 'Content-Type: application/json' -d '{\"username\":\"admin\",\"password\":\"admin\"}' $URL/api/auth/login)\" = 401 ]"
fi
echo "Yedekleme:"
chk "yedek alınabiliyor (/tmp/ragyu-dogrula)" "mkdir -p /tmp/ragyu-dogrula && ./deploy/backup.sh /tmp/ragyu-dogrula && ls /tmp/ragyu-dogrula/*.dump"
echo; echo "Sonuç: $ok başarılı, $bad hata"; [ "$bad" -eq 0 ]
