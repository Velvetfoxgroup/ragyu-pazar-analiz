'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { api, downloadUrl } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Shell, useLoad, Err, Loading, PosBadge, Modal, Field, useMe, can } from '@/components/ui';
import { tl, pct, pack } from '@/lib/format';

const POS = ['most_expensive', 'above_avg', 'avg', 'below_avg', 'same', 'cheapest', 'none'];

function AddProduct({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const [f, setF] = useState({ code: '', name: '', category: '', brand: 'Ragyu', sku: '', packQty: '500', packUnit: 'g', price: '' }); const [err, setErr] = useState<string | null>(null);
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <Modal title={t('products.add')} onClose={onClose}><Err msg={err} />
    <form onSubmit={async (e) => { e.preventDefault(); try { const r: any = await api('/products', { method: 'POST', body: { code: f.code, name: f.name, category: f.category || null, brand: f.brand || null, variants: [{ sku: f.sku || f.code, packQty: Number(f.packQty), packUnit: f.packUnit, price: f.price === '' ? null : Number(f.price.replace(',', '.')) }] } }); onDone(r.id); } catch (x: any) { setErr(x.message); } }}>
      <div className="grid g2"><Field label="Ürün kodu"><input value={f.code} onChange={s('code')} required style={{ width: '100%' }} /></Field><Field label="Ürün adı"><input value={f.name} onChange={s('name')} required style={{ width: '100%' }} /></Field>
        <Field label="Kategori"><input value={f.category} onChange={s('category')} style={{ width: '100%' }} /></Field><Field label="Marka"><input value={f.brand} onChange={s('brand')} style={{ width: '100%' }} /></Field>
        <Field label="Varyant SKU (boşsa ürün kodu)"><input value={f.sku} onChange={s('sku')} style={{ width: '100%' }} /></Field><Field label="Satış fiyatı (TRY, paket)"><input value={f.price} onChange={s('price')} inputMode="decimal" style={{ width: '100%' }} /></Field>
        <Field label="Paket miktarı"><input value={f.packQty} onChange={s('packQty')} required inputMode="decimal" style={{ width: '100%' }} /></Field><Field label="Birim"><select value={f.packUnit} onChange={s('packUnit')} style={{ width: '100%' }}>{['g', 'kg', 'ml', 'l', 'adet'].map((u) => <option key={u}>{u}</option>)}</select></Field></div>
      <div className="row"><button className="btn pri">{t('common.save')}</button><button type="button" className="btn" onClick={onClose}>{t('common.cancel')}</button></div></form></Modal>;
}

function Inner() {
  const me = useMe(); const sp = useSearchParams(); const router = useRouter();
  const [q, setQ] = useState(sp.get('q') ?? ''); const [cat, setCat] = useState(''); const [pos, setPos] = useState<string[]>(sp.get('position') ? sp.get('position')!.split(',') : []);
  const [stock, setStock] = useState('in'); const [ship, setShip] = useState(false); const [unm, setUnm] = useState(false); const [page, setPage] = useState(1); const [view, setView] = useState<'table' | 'card'>('table'); const [sort, setSort] = useState('name'); const [dir, setDir] = useState('asc'); const [add, setAdd] = useState(false);
  const query = { q, category: cat, position: pos.join(','), stock, includeShipping: ship ? '1' : '', unmatched: unm ? '1' : '', page, pageSize: view === 'card' ? 24 : 25, sort, dir };
  const { data, error, loading } = useLoad(() => api('/products', { query }), [JSON.stringify(query)]);
  const cats = useLoad(() => api<string[]>('/categories'), []);
  const th = (k: string, label: string, r = false) => <th className={r ? 'r' : ''} style={{ cursor: 'pointer' }} onClick={() => { if (sort === k) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(k); setDir('asc'); } setPage(1); }}>{label}{sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (<>
    {add && <AddProduct onClose={() => setAdd(false)} onDone={(id) => router.push(`/urunler/${id}`)} />}
    <div className="card">
      <div className="row">
        <div><label>Ara (ad, kod, SKU)</label><input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Örn. antrikot" /></div>
        <div><label>Kategori</label><select value={cat} onChange={(e) => { setCat(e.target.value); setPage(1); }}><option value="">Tümü</option>{(cats.data ?? []).map((c) => <option key={c}>{c}</option>)}</select></div>
        <div><label>Rakip stok durumu</label><select value={stock} onChange={(e) => setStock(e.target.value)}><option value="in">Yalnızca stokta olanlar</option><option value="all">Tümü</option><option value="out">Yalnızca stokta olmayanlar</option></select></div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}><input type="checkbox" checked={ship} onChange={(e) => setShip(e.target.checked)} /> Kargo ücretini dahil et</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0 }}><input type="checkbox" checked={unm} onChange={(e) => { setUnm(e.target.checked); setPage(1); }} /> Yalnızca onaylı eşleşmesi olmayanlar</label>
        <div style={{ marginLeft: 'auto' }} className="row">
          <a className="btn" href={downloadUrl('/reports/comparison', { q, category: cat, stock, includeShipping: ship ? '1' : '', format: 'xlsx' })}>{t('common.excel')}</a>
          <button className="btn" onClick={() => setView(view === 'table' ? 'card' : 'table')}>{view === 'table' ? 'Kart görünümü' : 'Tablo görünümü'}</button>
          {can(me, 'catalog:write') && <button className="btn pri" onClick={() => setAdd(true)}>+ {t('products.add')}</button>}</div>
      </div>
      <div className="chips" style={{ marginTop: 12 }}>{POS.map((p) => <button key={p} className={`chip ${pos.includes(p) ? 'on' : ''}`} onClick={() => { setPos(pos.includes(p) ? pos.filter((x) => x !== p) : [...pos, p]); setPage(1); }}>{t('pos.' + p)}</button>)}</div>
    </div>
    <Err msg={error} /><Loading on={loading && !data} />
    {data && <>
      {data.meta.shippingIncluded && <div className="note">Bu görünümde kargo ücreti bilinen rakip tekliflerine <b>dahil edilmiştir</b>. Ragyu fiyatına kargo eklenmez.</div>}
      {view === 'table' ? <div className="card tw"><table><thead><tr><th>Durum</th>{th('name', 'Ürün')}<th>Paket</th>{th('ownUnitPrice', 'Ragyu TL/kg', true)}{th('min', 'En düşük TL/kg', true)}<th className="r">Ortalama</th>{th('diffPct', 'Fark', true)}{th('count', 'Güvenilir rakip', true)}</tr></thead><tbody>
        {data.rows.map((r: any) => <tr key={r.variantId}><td><PosBadge k={r.position.key} />{r.position.rank && <div className="sub">{r.position.rank}. sıra</div>}</td>
          <td><Link href={`/urunler/${r.productId}`}><b>{r.name}</b></Link><div className="sub">{r.code}{r.sku !== r.code ? ` · ${r.sku}` : ''}{r.category ? ` · ${r.category}` : ''}</div></td>
          <td className="nowrap">{pack(r.packQty, r.packUnit)}<div className="sub">{tl(r.ownPrice)}</div></td><td className="r">{r.ownUnitKnown ? tl(r.ownUnitPrice) : <span className="badge b-warn">gramaj yok</span>}</td>
          <td className="r">{tl(r.stats.min)}<div className="sub">{r.stats.minSource ?? ''}</div></td><td className="r">{tl(r.stats.avg)}</td>
          <td className="r" style={{ color: Number(r.position.diffPct) > 0 ? 'var(--bad)' : Number(r.position.diffPct) < 0 ? 'var(--good)' : undefined }}>{pct(r.position.diffPct)}</td>
          <td className="r">{r.eligibleCount}<span className="sub"> / {r.offerCount}</span>{r.pendingCount > 0 && <div><span className="badge b-warn">{r.pendingCount} onay bekliyor</span></div>}</td></tr>)}
        {data.rows.length === 0 && <tr><td colSpan={8} className="muted">{t('common.none')}</td></tr>}</tbody></table></div>
      : <div className="pcard">{data.rows.map((r: any) => <Link key={r.variantId} href={`/urunler/${r.productId}`} className="stat" style={{ color: 'inherit', textDecoration: 'none' }}><div className="row" style={{ justifyContent: 'space-between' }}><PosBadge k={r.position.key} /><span className="sub">{r.eligibleCount} rakip</span></div><b style={{ fontSize: 17 }}>{r.name}</b><span>{pack(r.packQty, r.packUnit)} · {r.code}</span>
        <div className="row" style={{ justifyContent: 'space-between' }}><span>Ragyu <b>{tl(r.ownUnitPrice)}</b>/kg</span><span>En düşük <b>{tl(r.stats.min)}</b></span></div></Link>)}</div>}
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 8 }}><span className="sub">Toplam {data.total} kayıt</span><div className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹</button><span className="sub">{page} / {pages}</span><button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>›</button></div></div>
    </>}
  </>);
}
export default function Page() { return <Shell title={t('products.title')} sub="Fiyatlar kilogram bazında (TL/kg) karşılaştırılır; ayrıntılar ürün sayfasında."><Suspense fallback={null}><Inner /></Suspense></Shell>; }
