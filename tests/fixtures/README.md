# Rakip sayfa örnekleri

Bu dosyalar, rakip sitelerden elle kaydedilmiş ürün sayfalarının **küçültülmüş** kopyalarıdır (betikler, stiller ve
görseller çıkarıldı; ürün verisi — JSON-LD/microdata/meta/ürün kutusu — olduğu gibi bırakıldı). Yalnızca adaptör
testleri içindir; gerçek sitelerle doğrulama anlamına **gelmez**. Sitelerin şablonu değişirse yeni sayfa kaydedip
dosyayı yenileyin. Uzantı `.htm`'dir çünkü `.gitignore` `*.html` dosyalarını dışlar.

| Dosya | Site / altyapı | Beklenen (test) |
|---|---|---|
| etineniyisi.htm | etineniyisi.com (Ticimax) | 1.105 TL / 400 g |
| nebyandogal.htm | nebyandogal.com | 358,50 TL / 100 g |
| organikasap.htm | organikasap.com (Shopify, varyantlı) | seçili varyant 1 kg = 1.840 TL (meta etiketi 920 TL gösterir: tuzak) |
| tazedirekt.htm | tazedirekt.com (Migros altyapısı) | 1.026,87 TL / 630 g |
| macrocenter.htm | macrocenter.com.tr (Migros altyapısı) | 2.069,95 TL / kg |
| migros.htm | migros.com.tr | 899,95 TL/kg (JSON-LD teklifi; meta etiketi "null") |
| fumeci-*.htm | fumeci.com (IdeaSoft) | 1.600 TL/kg, 2.700 TL/kg |
| dilekgurme.htm | dilekgurme.net | 2.200 TL (KDV dahil) / 1 kg |
| amasya.htm | market.amasyaeturunleri.com.tr (WooCommerce) | 649 TL / 500 g |
