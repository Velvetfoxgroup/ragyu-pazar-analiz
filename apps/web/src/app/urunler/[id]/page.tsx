'use client';
import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Shell, useLoad, Err, Loading, PosBadge, LinkBadge, RunBadge, Modal, Field, useMe, can, LineChart, COLORS, Tabs } from '@/components/ui';
import { tl, n, pct, dt, ago, pack } from '@/lib/format';

const reasonText: Record<string, string> = { qty_unknown: 'Gramaj bilinmiyor', qty_conflict: 'Gramaj çelişkisi', price_jump: 'Fiyat sıçraması', content_mismatch: 'Ürün uyuşmuyor', unit_family: 'Birim türü uyuşmuyor', invalid_price: 'Geçersiz fiyat', accepted: 'Kabul edildi' };

function CheckResult({ r }: { r: any }) {
  if (r.pending) return <div className="note">Kontrol kuyruğa alındı; sonuç birkaç saniye içinde Geçmiş bölümünde görünür.</div>;
  const e = r.extracted;
  return <div className={r.status === 'error' ? 'err' : r.status === 'review' ? 'warnbox' : 'ok'}>
    <b>{r.status === 'ok' ? 'Kontrol başarılı' : r.status === 'review' ? 'Veri incelemeye alındı (güvenilir kıyasa girmez)' : 'Kontrol başarısız'}</b> · {dt(r.checkedAt)}
    {r.error && <div>{r.error}</div>}
    {e && <table style={{ marginTop: 8 }}><tbody>
      <tr><td>Bulunan ürün</td><td><b>{e.title}</b></td></tr><tr><td>Fiyat</td><td><b>{tl(e.salePrice)}</b>{e.listPrice ? <span className="sub"> (liste {tl(e.listPrice)})</span> : null}</td></tr>
      <tr><td>Gramaj</td><td>{e.packQty ? `${n(e.packQty)} ${e.packUnit}` : 'okunamadı'}</td></tr><tr><td>Birim fiyat</td><td>{r.unitPrice ? `${tl(r.unitPrice.value)} / ${r.unitPrice.per}` : 'hesaplanamadı'}</td></tr>
      <tr><td>Stok</td><td>{e.inStock === null ? 'bilinmiyor' : e.inStock ? 'Stokta var' : 'Stokta yok'}</td></tr><tr><td>Yöntem</td><td className="mono">{e.method}</td></tr></tbody></table>}
    {(r.reasons ?? []).map((x: any, i: number) => <div key={i}>• {x.message}</div>)}
  </div>;
}

function AddUrl({ variantId, onClose, onDone }: { variantId: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ url: '', title: '', qty: '', unit: 'g', note: '' }); const [err, setErr] = useState<string | null>(null); const [res, setRes] = useState<any>(null); const [check, setCheck] = useState<any>(null); const [busy, setBusy] = useState(false);
  const s = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <Modal title="Rakip ürün URL’si ekle" onClose={() => { onClose(); if (res) onDone(); }}><Err msg={err} />
    {!res ? <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { setRes(await api(`/variants/${variantId}/urls`, { method: 'POST', body: { url: f.url, title: f.title || undefined, expectedQty: f.qty ? Number(f.qty.replace(',', '.')) : undefined, expectedUnit: f.qty ? f.unit : undefined, note: f.note || undefined } })); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } }}>
      <p className="sub">Bağlantı planlı aralıklarla sürekli taranır. Yalnızca genel internet adresleri kabul edilir.</p>
      <Field label="Rakip ürün sayfası adresi"><input value={f.url} onChange={s('url')} placeholder="https://…" required style={{ width: '100%' }} /></Field>
      <Field label="Rakip ürün adı (isteğe bağlı)"><input value={f.title} onChange={s('title')} style={{ width: '100%' }} /></Field>
      <div className="row"><Field label="Beklenen paket gramajı (isteğe bağlı)"><input value={f.qty} onChange={s('qty')} inputMode="decimal" /></Field><Field label="Birim"><select value={f.unit} onChange={s('unit')}>{['g', 'kg', 'ml', 'l'].map((u) => <option key={u}>{u}</option>)}</select></Field></div>
      <Field label="Not"><input value={f.note} onChange={s('note')} style={{ width: '100%' }} /></Field>
      <button className="btn pri" disabled={busy}>Ekle</button></form>
      : <div><div className="ok">URL eklendi. Eşleşme durumu: <LinkBadge s={res.linkStatus} />{res.createdSource && <> · Yeni kaynak oluşturuldu.</>}</div>
        {res.mismatches?.length > 0 && <div className="warnbox">Uyuşmazlıklar: {res.mismatches.map((m: any) => `${m.field} (${m.ours} ≠ ${m.theirs})`).join(', ')}</div>}
        {check && <CheckResult r={check} />}
        <div className="row"><button className="btn pri" disabled={busy} onClick={async () => { setBusy(true); try { setCheck(await api(`/urls/${res.trackedUrlId}/check-now`, { method: 'POST' })); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } }}>Şimdi kontrol et</button><button className="btn" onClick={() => { onClose(); onDone(); }}>Kapat</button></div></div>}
  </Modal>;
}

function UrlRow({ u, me, reload }: { u: any; me: any; reload: () => void }) {
  const [res, setRes] = useState<any>(null); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [modal, setModal] = useState<null | 'edit' | 'qty' | 'hist'>(null);
  const [url, setUrl] = useState(u.url); const [q, setQ] = useState({ qty: '', unit: 'g', reason: '' }); const [hist, setHist] = useState<any>(null);
  const run = async (fn: () => Promise<any>) => { setErr(null); setBusy(true); try { return await fn(); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } };
  return <>
    <tr style={u.active ? undefined : { opacity: 0.6 }}>
      <td><div className="trunc" title={u.url}>{u.url}</div><div className="sub">{u.source_name} · {u.origin === 'manual' ? 'elle eklendi' : 'otomatik'} {!u.active && '· pasif'}</div></td>
      <td><LinkBadge s={u.link_status} /></td><td><RunBadge s={u.last_status} />{u.last_error && <div className="sub" style={{ color: 'var(--bad)' }}>{u.last_error}</div>}</td>
      <td className="nowrap">Deneme: {ago(u.last_attempt_at)}<div className="sub">Başarılı: {ago(u.last_success_at)}</div></td>
      <td className="r nowrap">
        {can(me, 'check:run') && u.active && <button className="btn sm pri" disabled={busy} onClick={async () => { const r = await run(() => api(`/urls/${u.id}/check-now`, { method: 'POST' })); if (r) { setRes(r); reload(); } }}>Şimdi kontrol et</button>}{' '}
        <button className="btn sm" onClick={async () => { setHist(await api(`/urls/${u.id}/history`)); setModal('hist'); }}>Geçmiş</button>
        {can(me, 'url:write') && <> <button className="btn sm" onClick={() => setModal('edit')}>Düzenle</button> <button className="btn sm" onClick={async () => { await run(() => api(`/urls/${u.id}`, { method: 'PATCH', body: { active: !u.active } })); reload(); }}>{u.active ? 'Devre dışı bırak' : 'Etkinleştir'}</button></>}
        {can(me, 'gram:write') && <> <button className="btn sm" onClick={() => setModal('qty')}>Gramaj düzeltmesi</button></>}
      </td></tr>
    {(res || err) && <tr><td colSpan={5}><Err msg={err} />{res && <CheckResult r={res} />}</td></tr>}
    {u.overrides?.length > 0 && <tr><td colSpan={5} className="sub">Gramaj düzeltmeleri: {u.overrides.map((o: any) => `${n(o.pack_qty)} ${o.pack_unit} (${o.status === 'approved' ? 'onaylı' : o.status === 'pending' ? 'onay bekliyor' : 'reddedildi'}; ${o.created_by_name ?? '—'}, ${dt(o.valid_from)}${o.valid_to ? ' – ' + dt(o.valid_to) : ''})`).join(' · ')}</td></tr>}
    {modal === 'edit' && <tr><td><Modal title="URL’yi düzenle" onClose={() => setModal(null)}><Err msg={err} /><p className="sub">Adres değişirse eski adres pasifleşir; <b>eski fiyat gözlemleri silinmez</b> ve hangi adresten geldikleri geçmişte görünür.</p><Field label="Adres"><input style={{ width: '100%' }} value={url} onChange={(e) => setUrl(e.target.value)} /></Field><button className="btn pri" onClick={async () => { const r = await run(() => api(`/urls/${u.id}`, { method: 'PATCH', body: { url } })); if (r) { setModal(null); reload(); } }}>Kaydet</button></Modal></td></tr>}
    {modal === 'qty' && <tr><td><Modal title="Gramaj düzeltmesi" onClose={() => setModal(null)}><Err msg={err} /><p className="sub">{can(me, 'gram:approve') ? 'Düzeltme hemen geçerli olur.' : 'Düzeltme onay yetkilisi onaylayana kadar uygulanmaz.'} Kaydeden kişi ve geçerlilik başlangıcı denetim kaydına yazılır.</p>
      <div className="row"><Field label="Gerçek paket miktarı"><input value={q.qty} onChange={(e) => setQ({ ...q, qty: e.target.value })} inputMode="decimal" /></Field><Field label="Birim"><select value={q.unit} onChange={(e) => setQ({ ...q, unit: e.target.value })}>{['g', 'kg', 'ml', 'l'].map((x) => <option key={x}>{x}</option>)}</select></Field></div>
      <Field label="Gerekçe"><input style={{ width: '100%' }} value={q.reason} onChange={(e) => setQ({ ...q, reason: e.target.value })} /></Field>
      <button className="btn pri" onClick={async () => { const r = await run(() => api(`/urls/${u.id}/qty-override`, { method: 'POST', body: { packQty: Number(q.qty.replace(',', '.')), packUnit: q.unit, reason: q.reason } })); if (r) { setModal(null); reload(); } }}>Kaydet</button></Modal></td></tr>}
    {modal === 'hist' && hist && <tr><td><Modal title="Tarama ve fiyat geçmişi" onClose={() => setModal(null)}>
      <h3>Fiyat gözlemleri (bu rakip ürünün tüm adreslerinden)</h3><div className="tw"><table><thead><tr><th>Tarih</th><th className="r">Fiyat</th><th className="r">TL/kg</th><th>Kalite</th><th>Alındığı adres</th><th>Tarama</th></tr></thead><tbody>{hist.observations.map((o: any) => <tr key={o.id}><td className="nowrap">{dt(o.observed_at)}</td><td className="r">{tl(o.sale_price)}</td><td className="r">{tl(o.unit_price)}</td><td>{o.quality === 'ok' ? <span className="badge b-good">güvenilir</span> : <span className="badge b-warn" title={(o.quality_reasons ?? []).map((x: any) => x.message).join(' ')}>{o.quality}</span>}</td><td><div className="trunc" title={o.url}>{o.url}</div></td><td className="mono">{String(o.scrape_run_id ?? '').slice(0, 8)}</td></tr>)}{hist.observations.length === 0 && <tr><td colSpan={6} className="muted">Gözlem yok</td></tr>}</tbody></table></div>
      <h3 style={{ marginTop: 14 }}>Son taramalar</h3><div className="tw"><table><tbody>{hist.runs.map((r: any) => <tr key={r.id}><td className="nowrap">{dt(r.started_at)}</td><td><RunBadge s={r.status} /></td><td>{r.trigger === 'manual' ? 'elle' : 'planlı'}</td><td className="sub">{r.error ?? ''}</td></tr>)}</tbody></table></div></Modal></td></tr>}
  </>;
}

function Variant({ v, me, reload }: { v: any; me: any; reload: () => void }) {
  const row = v.comparison; const [add, setAdd] = useState(false); const [tab, setTab] = useState('offers'); const [open, setOpen] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const [price, setPrice] = useState(v.variant.price ? String(Number(v.variant.price)) : ''); const [ed, setEd] = useState(false);
  const bySource: Record<string, { x: number; y: number }[]> = {};
  v.history.filter((o: any) => o.quality === 'ok' && o.unit_price).forEach((o: any) => { (bySource[o.source_name] ??= []).push({ x: new Date(o.observed_at).getTime(), y: Number(o.unit_price) }); });
  const ownPts = [...v.ownHistory].map((o: any) => ({ x: new Date(o.valid_from).getTime(), y: Number(o.price) * (1000 / (v.variant.pack_unit === 'g' || v.variant.pack_unit === 'ml' ? Number(v.variant.pack_qty) : Number(v.variant.pack_qty) * 1000)) }));
  const series = [{ name: 'Ragyu', color: COLORS[0], points: ownPts.length === 1 ? [...ownPts, { x: Date.now(), y: ownPts[0].y }] : ownPts }, ...Object.entries(bySource).map(([k, p], i) => ({ name: k, color: COLORS[(i + 1) % COLORS.length], points: p }))];
  const mult = row.ownUnitKnown ? 1000 / (['g', 'ml'].includes(v.variant.pack_unit) ? Number(v.variant.pack_qty) : Number(v.variant.pack_qty) * 1000) : null;
  return <div className="card">
    {add && <AddUrl variantId={v.variant.id} onClose={() => setAdd(false)} onDone={reload} />}
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <div><h2 style={{ margin: 0 }}>{pack(v.variant.pack_qty, v.variant.pack_unit)} <span className="sub">· SKU {v.variant.sku}</span></h2>
        <div className="sub">Satış fiyatı {ed ? <><input value={price} onChange={(e) => setPrice(e.target.value)} style={{ width: 110 }} inputMode="decimal" /> <button className="btn sm pri" onClick={async () => { try { await api(`/variants/${v.variant.id}`, { method: 'PATCH', body: { price: Number(price.replace(',', '.')) } }); setEd(false); reload(); } catch (x: any) { setErr(x.message); } }}>Kaydet</button></> : <><b>{tl(v.variant.price)}</b>{can(me, 'catalog:write') && <button className="btn sm" style={{ marginLeft: 6 }} onClick={() => setEd(true)}>Düzenle</button>}</>}</div></div>
      <div style={{ textAlign: 'right' }}><PosBadge k={row.position.key} /><div className="sub">{row.position.rank ? `${row.position.rank}. sıra · ` : ''}En düşük rakip {tl(row.stats.min)}/{row.per} {row.stats.minSource ? `(${row.stats.minSource})` : ''}</div></div></div>
    <Err msg={err} />
    <div className="grid g4" style={{ margin: '12px 0' }}><div className="stat"><b>{tl(row.ownUnitPrice)}</b><span>Ragyu {row.per ? `TL/${row.per}` : ''}</span></div><div className="stat"><b>{tl(row.stats.avg)}</b><span>Rakip ortalaması</span></div><div className="stat"><b>{tl(row.stats.median)}</b><span>Rakip medyanı</span></div><div className="stat"><b>{pct(row.position.diffPct)}</b><span>Fark (en düşük rakibe göre)</span></div></div>
    {mult && <div className="note">Gramaj çarpanı: 1000 ÷ {n(['g', 'ml'].includes(v.variant.pack_unit) ? v.variant.pack_qty : Number(v.variant.pack_qty) * 1000)} = <b>{n(mult)}</b> → {tl(v.variant.price)} × {n(mult)} = <b>{tl(row.ownUnitPrice)}/{row.per}</b></div>}
    <Tabs value={tab} onChange={setTab} tabs={[['offers', `Rakip teklifler (${row.offers.length})`], ['urls', `Rakip bağlantıları (${v.urls.length})`], ['history', 'Fiyat geçmişi']]} />
    {tab === 'offers' && <div className="tw"><table><thead><tr><th>Satıcı / ürün</th><th>Durum</th><th className="r">Paket fiyatı</th><th>Paket</th><th className="r">TL/kg</th><th>Stok</th><th>Gözlem</th><th></th></tr></thead><tbody>
      {row.offers.map((o: any) => <React.Fragment key={o.linkId}><tr style={o.eligible ? undefined : { opacity: 0.75 }}><td><b>{o.sourceName}</b><div className="sub trunc" title={o.title}>{o.title}</div></td>
        <td><LinkBadge s={o.linkStatus} />{!o.eligible && <div><span className="badge b-warn">{o.excludedLabel}</span></div>}{o.mismatches?.length > 0 && <div><span className="badge b-warn" title={o.mismatches.map((m: any) => `${m.field}: ${m.ours} ≠ ${m.theirs}`).join('\n')}>{o.mismatches.length} uyuşmazlık</span></div>}</td>
        <td className="r">{tl(o.salePrice)}{o.listPrice && <div className="sub"><s>{tl(o.listPrice)}</s></div>}{o.shippingFee && <div className="sub">kargo {tl(o.shippingFee)}</div>}{o.campaign && <div className="sub">{o.campaign}</div>}{o.multibuyMin > 1 && <div className="sub">{o.multibuyMin} adet şartı</div>}</td>
        <td className="nowrap">{o.packQty ? pack(o.packQty, o.packUnit) : '—'}<div className="sub">{o.qtySource === 'override' ? 'düzeltme' : o.qtySource === 'page' ? 'sayfadan' : o.qtySource === 'manual' ? 'elle' : ''}</div></td>
        <td className="r"><b>{o.eligible ? tl(o.unitPrice) : <span className="muted">{tl(o.unitPrice)}</span>}</b></td><td>{o.inStock === null ? '—' : o.inStock ? 'Var' : <span className="badge b-bad">Yok</span>}</td><td className="nowrap">{ago(o.observedAt)}</td>
        <td className="r nowrap"><button className="btn sm" onClick={() => setOpen(open === o.linkId ? null : o.linkId)}>Gramaj hesabı</button> {o.linkStatus !== 'approved' && can(me, 'match:approve') && <button className="btn sm pri" onClick={async () => { const note = o.mismatches?.length ? prompt('Uyuşmazlık var; onay gerekçesi:') : undefined; if (o.mismatches?.length && !note) return; try { await api(`/links/${o.linkId}/status`, { method: 'POST', body: { status: 'approved', note } }); reload(); } catch (x: any) { setErr(x.message); } }}>Onayla</button>} {o.linkStatus !== 'rejected' && can(me, 'match:write') && <button className="btn sm" onClick={async () => { try { await api(`/links/${o.linkId}/status`, { method: 'POST', body: { status: 'rejected' } }); reload(); } catch (x: any) { setErr(x.message); } }}>Reddet</button>}</td></tr>
        {open === o.linkId && <tr><td colSpan={8}><div className="note"><b>Gramaj hesabı.</b> Paket fiyatı {tl(o.comparedPrice ?? o.salePrice)} ({o.shippingFee && row.offers ? 'kargo dahil olabilir' : 'kargo hariç'}) ÷ ({o.packQty ? n(o.packQty) : '?'} {o.packUnit ?? ''} ÷ 1000) = <b>{tl(o.unitPrice)}/{o.per ?? 'kg'}</b>. Gramaj kaynağı: {o.qtySource ?? 'yok'}.{o.excluded && <> Kıyasa dahil değil: <b>{o.excludedLabel}</b>.</>}</div></td></tr>}</React.Fragment>)}
      {row.offers.length === 0 && <tr><td colSpan={8} className="muted">Bu varyant için rakip yok. “Rakip bağlantıları” sekmesinden URL ekleyin.</td></tr>}</tbody></table></div>}
    {tab === 'urls' && <><div className="row" style={{ marginBottom: 8 }}>{can(me, 'url:write') && <button className="btn pri" onClick={() => setAdd(true)}>+ Rakip URL’si ekle</button>}</div>
      <div className="tw"><table><thead><tr><th>Adres</th><th>Eşleşme</th><th>Son durum</th><th>Zaman</th><th></th></tr></thead><tbody>{v.urls.map((u: any) => <UrlRow key={u.id} u={u} me={me} reload={reload} />)}{v.urls.length === 0 && <tr><td colSpan={5} className="muted">Bağlantı yok.</td></tr>}</tbody></table></div></>}
    {tab === 'history' && <><LineChart series={series} /><div className="tw" style={{ marginTop: 10 }}><table><thead><tr><th>Tarih</th><th>Satıcı</th><th className="r">Fiyat</th><th className="r">TL/kg</th><th>Kalite</th><th>Alındığı adres</th></tr></thead><tbody>{v.history.slice(0, 60).map((o: any) => <tr key={o.id}><td className="nowrap">{dt(o.observed_at)}</td><td>{o.source_name}</td><td className="r">{tl(o.sale_price)}</td><td className="r">{tl(o.unit_price)}</td><td>{o.quality === 'ok' ? '✓' : <span className="badge b-warn">{o.quality}</span>}</td><td><div className="trunc" title={o.url}>{o.url}</div></td></tr>)}</tbody></table></div></>}
  </div>;
}

function Inner() {
  const me = useMe(); const { id } = useParams<{ id: string }>(); const { data, error, loading, reload } = useLoad(() => api(`/products/${id}`), [id]);
  if (!data) return <><Err msg={error} /><Loading on={loading} /></>;
  const p = data.product;
  return <><div className="card"><div className="row" style={{ justifyContent: 'space-between' }}><div><b>{p.name}</b><div className="sub">{p.code} · {p.brand ?? '—'} · {p.category ?? '—'} · kaynak: {p.source}</div></div>
    {can(me, 'catalog:write') && <button className="btn" onClick={async () => { await api(`/products/${id}`, { method: 'PATCH', body: { active: !p.active } }); reload(); }}>{p.active ? 'Pasife al' : 'Aktif et'}</button>}</div></div>
    {data.variants.map((v: any) => <Variant key={v.variant.id} v={v} me={me} reload={reload} />)}</>;
}
export default function Page() { return <Shell title="Ürün detayı" sub="Gramaj varyantları ayrı ayrı karşılaştırılır"><Inner /></Shell>; }
