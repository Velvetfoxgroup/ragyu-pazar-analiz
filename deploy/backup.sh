#!/usr/bin/env bash
# Veritabanı yedeği (sıkıştırılmış dump). Kullanım: ./deploy/backup.sh [hedef-klasör]
set -euo pipefail
DIR="${1:-./backups}"; mkdir -p "$DIR"; chmod 700 "$DIR"
F="$DIR/ragyu-$(date +%Y%m%d-%H%M%S).dump"
docker compose exec -T db pg_dump -U ragyu -d ragyu -Fc > "$F"
chmod 600 "$F"; echo "Yedek alındı: $F ($(du -h "$F" | cut -f1))"
# 30 günden eski yedekleri sil
find "$DIR" -name 'ragyu-*.dump' -mtime +30 -delete
