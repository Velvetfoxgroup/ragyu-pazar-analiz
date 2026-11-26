'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Shell, useLoad, Err, Loading, Tabs, LinkBadge, Modal, Field, useMe, can } from '@/components/ui';
import { tl, pack } from '@/lib/format';

function Mismatches({ m }: { m: any[] }) { return m?.length ? <ul style={{ margin: 0, paddingLeft: 16 }}>{m.map((x, i) => <li key={i} style={{ color: x.severity === 'high' ? 'var(--bad)' : 'var(--warn)' }}>{x.field}: {x.ours} ≠ {x.theirs}</li>)}</ul> : <span className="muted">Çelişki yok</span>; }

function Inner() {
  const me = useMe(); const sp = useSearchParams(); const [tab, setTab] = useState(sp.get('tab') ?? 'pending'); const [msg, setMsg] = useState<string | null>(null); const [info, setInfo] = useState<string | null>(null);
  const links = useLoad(() => api<any[]>('/links', { query: { status: tab === 'done' ? 'approved,rejected,invalidated' : 'review,suggested' } }), [tab]);
  const un = useLoad(() => api<any>('/unmatched'), []);
  const [fix, setFix] = useState<any>(null); const [pick, setPick] = useState('');
  const [allVariants, setAllVariants] = useState<any[]>([]);
  const act = async (fn: () => Promise<any>) => { setMsg(null); try { await fn(); links.reload(); un.reload(); } catch (e: any) { setMsg(e.message); } };
  const approve = (l: any) => act(async () => { let note: string | undefined; if (l.mismatches?.length) { note = window.prompt('Bu eşleşmede uyuşmazlık var. Onay gerekçesini yazın:') ?? undefined; if (!note) throw new Error('Gerekçe girilmedi; onay verilmedi.'); } await api(`/links/${l.id}/status`, { method: 'POST', body: { status: 'approved', note } }); });
  return <>
    <Err msg={msg} />{info && <div className="ok">{info}</div>}
    <Tabs value={tab} onChange={setTab} tabs={[['pending', `Onay bekleyenler${links.data && tab === 'pending' ? ` (${links.data.length})` : ''}`], ['unmatched', `Eşleşmeyenler${un.data ? ` (${un.data.variants.length + un.data.competitorProducts.length})` : ''}`], ['done', 'Karara bağlananlar']]} />
    {tab === 'unmatched' ? <>
      <div className="row" style={{ marginBottom: 10 }}>{can(me, 'match:write') && <button className="btn pri" onClick={() => act(async () => { const r: any = await api('/matching/suggest', { method: 'POST' }); setInfo(`${r.created} eşleşme önerisi üretildi. Öneriler insan onayı bekler.`); })}>Benzerlikle öneri üret</button>}</div>
      <div className="grid g2">
        <div className="card"><h3>Onaylı rakibi olmayan Ragyu ürünleri ({un.data?.variants.length ?? 0})</h3><div className="tw"><table><tbody>{(un.data?.variants ?? []).map((v: any) => <tr key={v.variant_id}><td><a href={`/urunler/${v.product_id}`}>{v.name}</a><div className="sub">{v.sku} · {pack(v.pack_qty, v.pack_unit)}</div></td><td className="r">{v.pending_count > 0 ? <span className="badge b-warn">{v.pending_count} bekliyor</span> : <a className="btn sm" href={`/urunler/${v.product_id}`}>URL ekle</a>}</td></tr>)}</tbody></table></div></div>
        <div className="card"><h3>Ragyu ürününe bağlanmamış rakip ürünleri ({un.data?.competitorProducts.length ?? 0})</h3><div className="tw"><table><tbody>{(un.data?.competitorProducts ?? []).map((c: any) => <tr key={c.id}><td>{c.title}<div className="sub">{c.source_name} · {tl(c.last_unit_price)}/kg</div></td><td className="r">{can(me, 'match:write') && <button className="btn sm" onClick={async () => { if (!allVariants.length) setAllVariants((await api<any>('/products', { query: { pageSize: 200, stock: 'all' } })).rows); setFix({ cp: c }); setPick(''); }}>Eşleştir</button>}</td></tr>)}</tbody></table></div></div>
      </div></>
    : <div className="card tw"><Loading on={links.loading && !links.data} /><table><thead><tr><th>Ragyu ürünü</th><th>Rakip ürünü</th><th>Durum</th><th>Uyuşmazlık</th><th>Kaynak</th><th></th></tr></thead><tbody>
      {(links.data ?? []).map((l: any) => <tr key={l.id}><td><b>{l.product_name}</b><div className="sub">{l.sku} · {pack(l.pack_qty, l.pack_unit)}</div></td><td>{l.competitor_title}<div className="sub">{l.source_name}{l.last_unit_price ? ` · ${tl(l.last_unit_price)}/kg` : ''}</div></td><td><LinkBadge s={l.status} />{l.score && <div className="sub">benzerlik {Math.round(Number(l.score) * 100)}%</div>}{l.reviewed_by_name && <div className="sub">{l.reviewed_by_name}</div>}</td><td><Mismatches m={l.mismatches} /></td><td>{l.origin === 'manual' ? 'elle' : 'otomatik öneri'}</td>
        <td className="r nowrap">{tab === 'pending' && <>{can(me, 'match:approve') && <button className="btn sm pri" onClick={() => approve(l)}>Onayla</button>} {can(me, 'match:write') && <><button className="btn sm" onClick={() => act(() => api(`/links/${l.id}/status`, { method: 'POST', body: { status: 'rejected' } }))}>Reddet</button> <button className="btn sm" onClick={async () => { if (!allVariants.length) setAllVariants((await api<any>('/products', { query: { pageSize: 200, stock: 'all' } })).rows); setFix({ link: l }); setPick(''); }}>Düzelt</button></>}</>}
          {tab === 'done' && l.status === 'approved' && can(me, 'match:approve') && <button className="btn sm danger" onClick={() => act(() => api(`/links/${l.id}/status`, { method: 'POST', body: { status: 'invalidated', note: 'Geçersiz kılındı' } }))}>Geçersiz kıl</button>}</td></tr>)}
      {links.data?.length === 0 && <tr><td colSpan={6} className="muted">Kayıt yok.</td></tr>}</tbody></table></div>}
    {fix && <Modal title={fix.link ? 'Eşleşmeyi düzelt' : 'Rakip ürünü eşleştir'} onClose={() => setFix(null)}>
      <p className="sub">{fix.link ? fix.link.competitor_title : fix.cp.title}</p>
      <Field label="Ragyu ürünü / varyantı"><select value={pick} onChange={(e) => setPick(e.target.value)} style={{ width: '100%' }}><option value="">Seçin…</option>{allVariants.map((v: any) => <option key={v.variantId} value={v.variantId}>{v.name} — {pack(v.packQty, v.packUnit)} ({v.sku})</option>)}</select></Field>
      <button className="btn pri" disabled={!pick} onClick={() => act(async () => { if (fix.link) await api(`/links/${fix.link.id}/reassign`, { method: 'POST', body: { variantId: pick } }); else await api('/links', { method: 'POST', body: { variantId: pick, competitorProductId: fix.cp.id } }); setFix(null); setInfo('Eşleşme onaya gönderildi.'); })}>Kaydet (onaya gider)</button></Modal>}
  </>;
}
export default function Page() { return <Shell title="Eşleşmeler" sub="Otomatik öneriler ve elle girilen eşleşmeler insan onayı olmadan güvenilir kıyasa girmez."><Suspense fallback={null}><Inner /></Suspense></Shell>; }
