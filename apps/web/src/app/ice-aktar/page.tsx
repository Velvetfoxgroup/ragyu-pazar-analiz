'use client';
import { useState } from 'react';
import { Shell, Err } from '@/components/ui';
import { downloadUrl } from '@/lib/api';

function Inner() {
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [defPack, setDefPack] = useState('');
  return <>
    <div className="card"><h3>Şablon ve dışa aktarım</h3><div className="row"><a className="btn" href={downloadUrl('/catalog/template.xlsx')}>Excel şablonu</a><a className="btn" href={downloadUrl('/catalog/template.csv')}>CSV şablonu</a><a className="btn" href={downloadUrl('/catalog/export.xlsx')}>Mevcut kataloğu Excel’e aktar</a></div>
      <p className="sub">Aynı ürün kodu birden fazla satırda ise her satır ayrı varyant (gramaj) olur. Başlık adları esnektir: Ürün Adı, SKU, Fiyat, Marka, Kategori gibi başka sistemlerin dışa aktarımları da okunur.</p></div>
    <div className="card"><h3>Katalog içe aktar (CSV / Excel)</h3><Err msg={err} />
      <form onSubmit={async (e) => { e.preventDefault(); setErr(null); setRes(null); const file = (e.currentTarget.elements.namedItem('file') as HTMLInputElement).files?.[0]; if (!file) return; setBusy(true);
        try { const fd = new FormData(); fd.append('file', file); const r = await fetch('/api/catalog/import' + (defPack ? `?defaultPack=${encodeURIComponent(defPack)}` : ''), { method: 'POST', body: fd, headers: { 'X-Requested-With': 'ragyu' } }); const j = await r.json(); if (!r.ok) throw new Error(j.message); setRes(j); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } }}>
        <div className="row"><div><label>Dosya</label><input type="file" name="file" accept=".csv,.xlsx" required /></div><div><label>Gramajı olmayan satırlar için varsayılan paket (örn. 1 kg)</label><input value={defPack} onChange={(e) => setDefPack(e.target.value)} placeholder="boş = hata ver" /></div><button className="btn pri" disabled={busy}>İçe aktar</button></div></form>
      {res && <div style={{ marginTop: 12 }}><div className={res.errorCount ? 'warnbox' : 'ok'}>{res.total} satır: <b>{res.ok}</b> başarılı, <b>{res.errorCount}</b> hatalı.{res.errorCount > 0 && <> <a href={`/api/catalog/import/${res.id}/errors.csv`}>Hata raporunu indir</a></>}</div>{(res.warnings ?? []).map((w: string) => <div key={w} className="note">{w}</div>)}
        {res.errors.length > 0 && <div className="tw"><table><thead><tr><th>Satır</th><th>Hata</th></tr></thead><tbody>{res.errors.slice(0, 100).map((e: any) => <tr key={e.row}><td>{e.row}</td><td>{e.message}</td></tr>)}</tbody></table></div>}</div>}</div>
    <div className="card"><h3>Ticimax</h3><p className="sub">Ticimax katalog bağlantısı henüz yapılandırılmadı; erişim bilgileri sağlanınca ayrı bir adaptör olarak eklenecek. Şimdilik katalog CSV/Excel ile yönetilir.</p></div>
  </>;
}
export default function Page() { return <Shell title="İçe / dışa aktar" sub="Toplu katalog yükleme, satır bazında hata raporu"><Inner /></Shell>; }
