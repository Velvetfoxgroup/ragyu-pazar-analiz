// Tarayıcı testi: Raporlar sayfasının tüm sekmeleri hatasız açılmalı (sekme geçişinde eski veriyle çökme hatasının regresyon testi).
// Çalıştırma: web (3100) ve API ayakta, demo verisi yüklü iken:  E2E_USER=... E2E_PASS=... node tests/e2e/raporlar-sekmeleri.cjs  (playwright gerekir)
const { chromium } = require('playwright');
const BASE = process.env.E2E_URL ?? 'http://localhost:3100';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 900 } }); const errs=[]; p.on('pageerror', e=>errs.push(e.message));
  await p.goto(BASE + '/login'); await p.fill('#u',process.env.E2E_USER); await p.fill('#p',process.env.E2E_PASS); await p.click('form button'); await p.waitForURL(u=>!u.pathname.includes('login'));
  await p.goto(BASE + '/raporlar'); await p.waitForSelector('table');
  // hızlı ardışık sekme geçişleri
  for (const t of ['En ucuz satıcılar','Fiyat özeti','Dönemsel fiyat değişimi','Seçilen satıcıyla kıyas','Satış performansı','Ürün karşılaştırma','Fiyat özeti']) await p.click(`text="${t}"`);
  await p.waitForTimeout(3000); console.log('hızlı geçiş sonrası hata:', errs.length, 'tablo satır:', await p.locator('tbody tr').count());
  await p.click('text="Seçilen satıcıyla kıyas"'); await p.waitForTimeout(500); console.log('satıcı seçilmeden:', (await p.innerText('body')).includes('bir satıcı seçin'));
  const sel = p.locator('select').nth(1); await sel.selectOption({ index: 1 }); await p.waitForTimeout(2500); console.log('satıcı seçildi, satır:', await p.locator('tbody tr').count());
  await p.click('text="Dönemsel fiyat değişimi"'); await p.waitForTimeout(2500); console.log('dönemsel satır:', await p.locator('tbody tr').count());
  await p.click('text="Satış performansı"'); await p.waitForTimeout(1500); console.log('satış uyarısı:', (await p.innerText('.warnbox')).slice(0,160));
  await p.screenshot({ path: '/tmp/sales.png' }); console.log('toplam pageerror:', errs.length, errs.join('|')); if (errs.length) process.exit(1);
  await b.close();
})().catch(e=>{console.error('FAIL',e.message);process.exit(1)});
