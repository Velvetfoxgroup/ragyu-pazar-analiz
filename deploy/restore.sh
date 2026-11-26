#!/usr/bin/env bash
# Yedekten geri yükleme. DİKKAT: mevcut veritabanının üzerine yazar. Kullanım: ./deploy/restore.sh yedek.dump
set -euo pipefail
[ -f "${1:-}" ] || { echo "Kullanım: $0 yedek.dump"; exit 1; }
read -r -p "Mevcut veritabanı SİLİNİP '$1' yüklenecek. Devam? (evet yazın) " a; [ "$a" = "evet" ] || exit 1
docker compose stop api worker web
docker compose exec -T db psql -U ragyu -d postgres -c "DROP DATABASE IF EXISTS ragyu WITH (FORCE);" -c "CREATE DATABASE ragyu;"
docker compose exec -T db pg_restore -U ragyu -d ragyu --no-owner < "$1"
docker compose start api worker web
echo "Geri yükleme tamamlandı."
