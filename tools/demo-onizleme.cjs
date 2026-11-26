/**
 * Tek dosyalık, canlı olmayan DEMO ÖNİZLEME üretir (docs/onizleme/ragyu-demo-onizleme.html).
 * Çalışan uygulamanın (demo veriyle) ekranlarını tarayıcıda gezip DOM + CSS'i tek HTML'e gömer; backend gerekmez.
 *   Gerekenler: API + web ayakta (örn. web http://localhost:3100), demo verisi yüklü, `playwright` kurulu.
 *   E2E_USER=demo E2E_PASS=... [E2E_URL=http://localhost:3100] node tools/demo-onizleme.cjs
 * Üretilen dosyada kimlik bilgisi, oturum çerezi veya .env içeriği yoktur; yalnızca ekranlarda görünen örnek veriler vardır.
 */
const fs = require('fs'); const path = require('path');
const { chromium } = require('playwright');
const BASE = process.env.E2E_URL ?? 'http://localhost:3100';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs/onizleme/ragyu-demo-onizleme.html');

const PAGES = [
  { key: 'dash', path: '/', nav: '/' }, { key: 'gunluk', path: '/gunluk', nav: '/gunluk' }, { key: 'urunler', path: '/urunler', nav: '/urunler' },
  { key: 'eslesmeler', path: '/eslesmeler', nav: '/eslesmeler' }, { key: 'raporlar', path: '/raporlar', nav: '/raporlar' }, { key: 'kaynaklar', path: '/kaynaklar', nav: '/kaynaklar' },
  { key: 'ice-aktar', path: '/ice-aktar', nav: '/ice-aktar' }, { key: 'kullanicilar', path: '/kullanicilar', nav: '/kullanicilar' }, { key: 'denetim', path: '/denetim', nav: '/denetim' },
];
const DETAIL_COUNT = 8;

(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1360, height: 900 } }); const p = await ctx.newPage();
  await p.goto(BASE + '/login'); await p.fill('#u', process.env.E2E_USER); await p.fill('#p', process.env.E2E_PASS); await p.click('form button');
  await p.waitForURL((u) => !u.pathname.includes('login'));
  const views = {}; let sidebar = '';

  async function snap(key, nav, tabIdx) {
    const html = await p.evaluate(({ key }) => {
      document.querySelectorAll('input').forEach((i) => { if (i.type === 'checkbox' || i.type === 'radio') { i.checked ? i.setAttribute('checked', '') : i.removeAttribute('checked'); } else i.setAttribute('value', i.value); });
      document.querySelectorAll('select').forEach((s) => { [...s.options].forEach((o, n) => o.selected = n === s.selectedIndex); [...s.options].forEach((o) => o.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected')); });
      const first = document.querySelector('.main .tabs');
      if (first) [...first.querySelectorAll('button')].forEach((bt, i) => bt.setAttribute('data-go', `${key}:${i}`));
      document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
      return document.querySelector('.main').innerHTML;
    }, { key });
    views[`${key}:${tabIdx}`] = { nav, html };
    if (!sidebar) sidebar = await p.evaluate(() => document.querySelector('.side').outerHTML);
  }
  async function settle() { await p.waitForTimeout(1800); await p.waitForFunction(() => !document.body.innerText.includes('Yükleniyor'), null, { timeout: 15000 }).catch(() => {}); }

  async function capturePage(key, urlPath, nav) {
    await p.goto(BASE + urlPath); await p.waitForSelector('.main'); await settle();
    const nTabs = await p.locator('.main .tabs').first().locator('button').count().catch(() => 0);
    if (!nTabs) { await snap(key, nav, 0); return; }
    for (let i = 0; i < nTabs; i++) {
      await p.locator('.main .tabs').first().locator('button').nth(i).click(); await settle();
      if (key === 'raporlar' && i === 2) { const sel = p.locator('.main select').nth(1); if (await sel.count()) { await sel.selectOption({ index: 1 }); await settle(); } }
      await snap(key, nav, i);
    }
  }
  for (const pg of PAGES) { console.log('→', pg.key); await capturePage(pg.key, pg.path, pg.nav); }

  // Ürün detayları: ilk sayfadaki, rakip teklifi olan ürünler
  await p.goto(BASE + '/urunler'); await p.waitForSelector('.main tbody tr', { timeout: 20000 }); await settle();
  const ids = await p.evaluate(() => [...document.querySelectorAll('.main tbody tr')].map((tr) => tr.querySelector('a[href^="/urunler/"]')?.getAttribute('href')).filter(Boolean));
  const detail = [...new Set(ids)].slice(0, DETAIL_COUNT);
  for (const href of detail) { const id = href.split('/').pop(); console.log('→ ürün', id); await capturePage('urun-' + id, href, '/urunler'); }

  // Logo ve CSS
  const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'apps/web/public/ragyu-logo.png')).toString('base64');
  const cssDir = path.join(ROOT, 'apps/web/.next/static/css'); const css = fs.readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8')).join('\n');
  await b.close();

  const pageOf = new Map(PAGES.map((x) => [x.path, x.key]));
  const rewrite = (html) => html
    .replace(/<a\b([^>]*?)\shref="([^"]*)"([^>]*)>/g, (m, a, href, c) => {
      let go = null; const pathOnly = href.split('?')[0];
      if (pageOf.has(pathOnly)) go = pageOf.get(pathOnly) + ':0';
      else { const mm = pathOnly.match(/^\/urunler\/([^/]+)$/); if (mm && views[`urun-${mm[1]}:0`]) go = `urun-${mm[1]}:0`; }
      return go ? `<a${a} data-go="${go}" href="#${go}"${c}>` : `<a${a} data-dead="1"${c}>`;
    })
    .replace(/src="\/ragyu-logo\.png"/g, `src="${logo}"`)
    .replace(/<img[^>]*src="\/api[^>]*>/g, '');
  const nav = (n) => n;
  const sideHtml = rewrite(sidebar).replace(/<button[^>]*>Çıkış<\/button>/, '');
  const sections = Object.entries(views).map(([id, v]) => `<section class="view" data-view="${id}" data-nav="${nav(v.nav)}" hidden><div class="head-spacer"></div>${rewrite(v.html)}</section>`).join('\n');

  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Ragyu Pazar Analiz — Demo Önizleme</title><style>${css}
.preview-bar{position:sticky;top:0;z-index:100;background:#141ed2;color:#fff;padding:8px 16px;font-size:13px;line-height:1.4;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.preview-bar b{background:#fff;color:#141ed2;border-radius:999px;padding:1px 9px;font-size:12px}
.preview-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#000;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px;z-index:200;opacity:0;pointer-events:none;transition:opacity .2s}.preview-toast.on{opacity:.95}
.head-spacer{display:none}[data-dead]{cursor:default}.view[hidden]{display:none}
.shell{min-height:calc(100vh - 38px)}
</style></head><body>
<div class="preview-bar"><b>ÖNİZLEME</b><span>Canlı sistem değildir: örnek (demo) veriyle hazırlanmış statik görüntü. Gezinme ve sekmeler çalışır; kaydet, onayla, “Şimdi kontrol et”, içe aktar gibi düğmeler çalışmaz. Rakip siteler ve rakip fiyatları gerçek değildir (demo).</span></div>
<div class="shell">${sideHtml}<main class="main" id="stage">${sections}</main></div>
<div class="preview-toast" id="toast">Önizlemede bu düğme çalışmaz.</div>
<script>
(function(){
  var views=[].slice.call(document.querySelectorAll('.view')); var stage=document.getElementById('stage'); var toast=document.getElementById('toast'); var tt;
  function show(id){ var f=null; views.forEach(function(v){ var on=v.getAttribute('data-view')===id; v.hidden=!on; if(on) f=v; });
    if(!f){ return; } var nav=f.getAttribute('data-nav');
    [].slice.call(document.querySelectorAll('.side .nav a')).forEach(function(a){ var g=a.getAttribute('data-go')||''; var pg=g.split(':')[0]; var map={'dash':'/','gunluk':'/gunluk','urunler':'/urunler','eslesmeler':'/eslesmeler','raporlar':'/raporlar','kaynaklar':'/kaynaklar','ice-aktar':'/ice-aktar','kullanicilar':'/kullanicilar','denetim':'/denetim'}; a.classList.toggle('on', map[pg]===nav); });
    try{ history.replaceState(null,'','#'+id);}catch(e){} window.scrollTo(0,0); }
  function say(){ toast.classList.add('on'); clearTimeout(tt); tt=setTimeout(function(){toast.classList.remove('on');},2200); }
  document.addEventListener('click',function(e){
    var g=e.target.closest('[data-go]'); if(g){ e.preventDefault(); show(g.getAttribute('data-go')); return; }
    var a=e.target.closest('a'); if(a){ e.preventDefault(); say(); return; }
    var b=e.target.closest('button, input[type=submit], input[type=checkbox], summary'); if(b && b.tagName!=='SUMMARY'){ e.preventDefault(); say(); }
  }, true);
  document.addEventListener('submit',function(e){ e.preventDefault(); say(); }, true);
  var start=(location.hash||'').slice(1); show(document.querySelector('[data-view="'+start+'"]')?start:'dash:0');
})();
</script></body></html>`;
  fs.writeFileSync(OUT, html); console.log('Yazıldı:', OUT, (html.length / 1024).toFixed(0) + ' KB', Object.keys(views).length + ' görünüm');
})().catch((e) => { console.error('HATA', e); process.exit(1); });
