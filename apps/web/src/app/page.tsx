'use client';
import Link from 'next/link';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Shell, useLoad, Err, Loading, FreshBadge } from '@/components/ui';
import { ago } from '@/lib/format';

const ORDER = ['cheapest', 'same', 'below_avg', 'avg', 'above_avg', 'most_expensive', 'none'];
const COLOR: Record<string, string> = { cheapest: '#1a7f4b', same: '#1f5fa8', below_avg: '#0e9aa7', avg: '#c58a00', above_avg: '#e0651f', most_expensive: '#c62828', none: '#9a9090' };

function Inner() {
  const { data: d, error, loading } = useLoad(() => api('/dashboard'), []);
  if (!d) return <><Err msg={error} /><Loading on={loading} /></>;
  const total = d.totals.products || 1;
  const fresh = d.sourceHealth as any[];
  return (
    <>
      <div className="card">
        <h2 style={{ color: 'var(--good)', fontSize: 20 }}>{t('dash.cheapest', { n: d.headline.ofTotal, m: d.headline.cheapest })}</h2>
        <div className="bar" aria-label="Fiyat konumu dağılımı">{ORDER.map((k) => d.distribution[k] ? <i key={k} style={{ width: `${(d.distribution[k] / total) * 100}%`, background: COLOR[k] }} title={`${t('pos.' + k)}: ${d.distribution[k]}`} /> : null)}</div>
        <div className="chips" style={{ marginTop: 10 }}>{ORDER.map((k) => d.distribution[k] ? <Link key={k} href={`/urunler?position=${k}`} className="chip"><i style={{ display: 'inline-block', width: 9, height: 9, background: COLOR[k], borderRadius: 2, marginRight: 6 }} />{t('pos.' + k)} <b>{d.distribution[k]}</b></Link> : null)}</div>
        <p className="sub" style={{ marginTop: 10 }}>Konum yalnızca <b>onaylı eşleşme</b>, geçerli fiyat, bilinen gramaj, güncel veri ve stokta olan rakip teklifleriyle (TL/kg) hesaplanır. {d.meta.shippingIncluded ? 'Kargo dahil.' : 'Kargo hariç.'}</p>
      </div>
      <div className="grid g3" style={{ marginBottom: 16 }}>
        <Link href="/eslesmeler" className="stat" style={{ background: 'var(--info-soft)' }}><b>{d.totals.pendingLinks}</b><span>Onay bekleyen eşleşme</span></Link>
        <Link href="/gunluk" className="stat" style={{ background: d.totals.openAlerts ? 'var(--warn-soft)' : undefined }}><b>{d.totals.openAlerts}</b><span>Açık inceleme uyarısı</span></Link>
        <Link href="/eslesmeler?tab=unmatched" className="stat"><b>{d.totals.unmatched}</b><span>{t('dash.unmatched')} ürün</span></Link>
      </div>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="stat"><b>{d.totals.products}</b><span>Aktif ürün varyantı</span></div>
        <div className="stat"><b>{d.totals.tracked}</b><span>{t('dash.tracked')}</span></div>
        <div className="stat"><b>{d.totals.reliable}</b><span>{t('dash.reliable')}</span></div>
        <Link href="/kaynaklar" className="stat" style={{ background: d.totals.staleSources ? 'var(--bad-soft)' : undefined }}><b>{d.totals.staleSources}</b><span>{t('dash.stale')}</span></Link>
      </div>
      <div className="grid g2">
        <div className="card"><h3>Benden ucuz satanlar</h3>{d.cheaperThanMe.filter((x: any) => x.count).length === 0 ? <div className="muted">Güvenilir veriye göre senden ucuz rakip ürün yok.</div> :
          <table><tbody>{d.cheaperThanMe.filter((x: any) => x.count).map((x: any) => <tr key={x.name}><td>{x.name}</td><td className="r"><b>{x.count}</b> ürün</td></tr>)}</tbody></table>}</div>
        <div className="card"><h3>Son 7 gün: rakip fiyat hareketi</h3>{d.priceMovers.length === 0 ? <div className="muted">Karşılaştırılabilir değişim yok.</div> :
          <table><thead><tr><th>Rakip</th><th className="r">Artan</th><th className="r">Düşen</th><th className="r">Değişmeyen</th></tr></thead><tbody>{d.priceMovers.map((x: any) => <tr key={x.name}><td>{x.name}</td><td className="r" style={{ color: 'var(--bad)' }}>{x.up}</td><td className="r" style={{ color: 'var(--good)' }}>{x.down}</td><td className="r">{x.same}</td></tr>)}</tbody></table>}</div>
      </div>
      <div className="card"><h3>Rakip siteler</h3><div className="tw"><table><thead><tr><th>Rakip</th><th>Eşleşme kapsamı</th><th className="r">Onaylı eşleşme</th><th className="r">Güvenilir teklif</th><th>Veri durumu</th><th>Son başarılı kontrol</th></tr></thead><tbody>
        {d.sourcesWithCoverage.map((s: any) => { const h = fresh.find((x) => x.id === s.sourceId); const age = h?.last_success_at ? (Date.now() - new Date(h.last_success_at).getTime()) / 3600000 : null; const st = !h?.last_success_at ? 'never' : age! > h.stale_after_hours ? 'stale' : 'fresh';
          return <tr key={s.sourceId}><td>{s.name}</td><td style={{ minWidth: 140 }}><div className="bar"><i style={{ width: `${s.coveragePct}%`, background: s.coveragePct > 50 ? '#1a7f4b' : s.coveragePct > 25 ? '#c58a00' : '#c62828' }} /></div><span className="sub">%{s.coveragePct}</span></td><td className="r">{s.matched}</td><td className="r">{s.reliable}</td><td><FreshBadge s={st} /></td><td>{ago(h?.last_success_at)}</td></tr>; })}
        {d.sourcesWithCoverage.length === 0 && <tr><td colSpan={6} className="muted">Henüz rakip kaynağı yok. Bir ürüne rakip URL’si ekleyerek başlayın.</td></tr>}
      </tbody></table></div></div>
    </>
  );
}
export default function Page() { return <Shell title={t('dash.title')} sub="Ragyu’nun rakiplere göre fiyat konumu"><Inner /></Shell>; }
