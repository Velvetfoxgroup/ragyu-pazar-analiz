'use client';
import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Shell, useLoad, Err, Loading, useMe, can, LinkBadge, RunBadge } from '@/components/ui';
import { dt, ago, pct, n } from '@/lib/format';

const ALERT_LABEL: Record<string, string> = { price_jump: 'Fiyat sıçraması', qty_doubt: 'Gramaj şüphesi', match_issue: 'Eşleşme sorunu', scrape_failing: 'Toplama hatası', stale_source: 'Güncel olmayan kaynak', content_mismatch: 'Ürün içeriği uyuşmuyor' };

function Inner() {
  const me = useMe(); const { data: w, error, loading, reload } = useLoad(() => api('/worklist'), []); const [msg, setMsg] = useState<string | null>(null);
  if (!w) return <><Err msg={error} /><Loading on={loading} /></>;
  const act = async (fn: () => Promise<any>) => { setMsg(null); try { await fn(); reload(); } catch (e: any) { setMsg(e.message); } };
  return (
    <>
      <Err msg={msg} />
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="stat"><b>{w.pendingLinks.length}</b><span>Onay bekleyen eşleşme</span></div><div className="stat"><b>{w.failedScrapes.length}</b><span>Başarısız tarama</span></div>
        <div className="stat"><b>{w.qtyDoubts.length}</b><span>Gramaj belirsizliği</span></div><div className="stat"><b>{w.bigChanges.length}</b><span>Önemli fiyat değişimi (≥%10, 7 gün)</span></div>
      </div>
      {w.pendingOverrides.length > 0 && <div className="card"><h3>Onay bekleyen gramaj düzeltmeleri</h3><table><tbody>{w.pendingOverrides.map((o: any) => <tr key={o.id}><td>{o.title}<div className="sub trunc">{o.url}</div></td><td>{n(o.pack_qty)} {o.pack_unit}</td><td className="sub">{o.reason}</td><td className="r nowrap">{can(me, 'gram:approve') && <><button className="btn sm pri" onClick={() => act(() => api(`/qty-overrides/${o.id}/approve`, { method: 'POST' }))}>Onayla</button> <button className="btn sm" onClick={() => act(() => api(`/qty-overrides/${o.id}/reject`, { method: 'POST' }))}>Reddet</button></>}</td></tr>)}</tbody></table></div>}
      <div className="card"><h3>Onay bekleyen eşleşmeler</h3>{w.pendingLinks.length === 0 ? <div className="muted">Bekleyen eşleşme yok.</div> :
        <div className="tw"><table><thead><tr><th>Ragyu ürünü</th><th>Rakip ürünü</th><th>Durum</th><th>Uyuşmazlık</th></tr></thead><tbody>{w.pendingLinks.slice(0, 15).map((l: any) => <tr key={l.id}><td>{l.product_name}<div className="sub">{l.sku} · {n(l.pack_qty)} {l.pack_unit}</div></td><td>{l.competitor_title}<div className="sub">{l.source_name}</div></td><td><LinkBadge s={l.status} /></td><td>{(l.mismatches ?? []).length ? <span className="badge b-warn">{l.mismatches.length} fark</span> : '—'}</td></tr>)}</tbody></table>{w.pendingLinks.length > 15 && <p className="sub"><Link href="/eslesmeler">Tümünü gör ({w.pendingLinks.length})</Link></p>}</div>}</div>
      <div className="card"><h3>Başarısız taramalar</h3>{w.failedScrapes.length === 0 ? <div className="muted">Başarısız tarama yok.</div> :
        <div className="tw"><table><thead><tr><th>Rakip ürün</th><th>Hata</th><th>Son deneme</th><th>Son başarılı</th><th className="r">Üst üste hata</th></tr></thead><tbody>{w.failedScrapes.map((f: any) => <tr key={f.id}><td>{f.title}<div className="sub">{f.source_name}</div></td><td style={{ color: 'var(--bad)' }}>{f.last_error}</td><td>{ago(f.last_attempt_at)}</td><td>{ago(f.last_success_at)}</td><td className="r">{f.consecutive_failures}</td></tr>)}</tbody></table></div>}</div>
      <div className="card"><h3>İnceleme uyarıları</h3>{w.alerts.length === 0 ? <div className="muted">Açık uyarı yok.</div> :
        <div className="tw"><table><thead><tr><th>Tür</th><th>Mesaj</th><th>Zaman</th><th></th></tr></thead><tbody>{w.alerts.map((a: any) => <tr key={a.id}><td><span className={`badge ${a.severity === 'critical' ? 'b-bad' : 'b-warn'}`}>{ALERT_LABEL[a.type] ?? a.type}</span></td><td>{a.message}</td><td className="nowrap">{dt(a.created_at)}</td>
          <td className="r nowrap">{can(me, 'alert:resolve') && <>{a.type === 'price_jump' && <button className="btn sm" onClick={() => act(() => api(`/alerts/${a.id}/resolve`, { method: 'POST', body: { acceptObservation: true } }))}>Fiyatı kabul et</button>} <button className="btn sm" onClick={() => act(() => api(`/alerts/${a.id}/resolve`, { method: 'POST', body: {} }))}>Kapat</button></>}</td></tr>)}</tbody></table></div>}</div>
      <div className="card"><h3>Önemli fiyat değişimleri (son 7 gün)</h3>{w.bigChanges.length === 0 ? <div className="muted">Önemli değişim yok.</div> :
        <table><thead><tr><th>Ürün</th><th>Rakip</th><th className="r">Başlangıç</th><th className="r">Bitiş</th><th className="r">Değişim</th></tr></thead><tbody>{w.bigChanges.map((c: any, i: number) => <tr key={i}><td><Link href={`/urunler?q=${encodeURIComponent(c.code)}`}>{c.name}</Link></td><td>{c.sourceName}</td><td className="r">{n(c.startUnitPrice)}</td><td className="r">{n(c.endUnitPrice)}</td><td className="r" style={{ color: Number(c.changePct) > 0 ? 'var(--bad)' : 'var(--good)' }}>{pct(c.changePct)}</td></tr>)}</tbody></table>}</div>
    </>
  );
}
export default function Page() { return <Shell title="Günlük çalışma listesi" sub="Bugün ilgilenmen gereken işler"><Inner /></Shell>; }
