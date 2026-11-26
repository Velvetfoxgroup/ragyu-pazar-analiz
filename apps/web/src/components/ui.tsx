'use client';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { t } from '@/lib/i18n';

export interface Me { id: string; username: string; displayName: string; role: 'admin' | 'editor' | 'approver' | 'viewer'; roleLabel: string; permissions: string[]; mustChangePassword: boolean }
const MeCtx = createContext<Me | null>(null);
export const useMe = () => useContext(MeCtx)!;
export const can = (me: Me, p: string) => me.permissions.includes(p);

export function useLoad<T>(fn: () => Promise<T>, deps: any[]) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true);
  const router = useRouter();
  const seq = useRef(0);
  const reload = useCallback(() => {
    const mine = ++seq.current; // eski isteğin geç gelen yanıtı yeni sonucu ezmesin
    setLoading(true);
    fn().then((d) => { if (mine === seq.current) { setData(d); setError(null); } }).catch((e) => { if (mine !== seq.current) return; if (e instanceof ApiError && e.status === 401) router.push('/login'); else setError(e.message); }).finally(() => { if (mine === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

export function Shell({ children, title, sub, actions }: { children: React.ReactNode; title: string; sub?: string; actions?: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null); const router = useRouter(); const path = usePathname();
  useEffect(() => {
    api<Me>('/auth/me').then((m) => { if (m.mustChangePassword && path !== '/hesabim') router.replace('/hesabim'); setMe(m); }).catch(() => router.replace('/login'));
  }, [path, router]);
  if (!me) return <div className="login muted">{t('common.loading')}</div>;
  const items: [string, string][] = [['/', 'nav.dashboard'], ['/gunluk', 'nav.worklist'], ['/urunler', 'nav.products'], ['/eslesmeler', 'nav.matches'], ['/raporlar', 'nav.reports'], ['/kaynaklar', 'nav.sources']];
  if (can(me, 'catalog:write')) items.push(['/ice-aktar', 'nav.import']);
  const admin: [string, string][] = [];
  if (can(me, 'user:manage')) admin.push(['/kullanicilar', 'nav.users']);
  if (can(me, 'audit:read')) admin.push(['/denetim', 'nav.audit']);
  const on = (h: string) => (h === '/' ? path === '/' : path.startsWith(h));
  return (
    <MeCtx.Provider value={me}>
      <div className="shell">
        <aside className="side">
          <div className="nav-logo"><span className="logo-plate"><img src="/ragyu-logo.png" alt="Ragyu Kasap+" width={150} height={29} /></span><small>{t('app.short')}</small></div>
          <nav className="nav">
            {!me.mustChangePassword && items.map(([h, k]) => <Link key={h} href={h} className={on(h) ? 'on' : ''}>{t(k)}</Link>)}
            {!me.mustChangePassword && admin.length > 0 && <div className="sec">{t('nav.admin')}</div>}
            {!me.mustChangePassword && admin.map(([h, k]) => <Link key={h} href={h} className={on(h) ? 'on' : ''}>{t(k)}</Link>)}
            <Link href="/hesabim" className={on('/hesabim') ? 'on' : ''}>{t('nav.account')}</Link>
          </nav>
          <div className="user"><b>{me.displayName}</b><br />{t('role.' + me.role)}<br />
            <button className="btn sm" style={{ marginTop: 8 }} onClick={async () => { await api('/auth/logout', { method: 'POST' }).catch(() => 0); router.push('/login'); }}>{t('nav.logout')}</button></div>
        </aside>
        <main className="main">
          <div className="head"><div><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div><div className="row">{actions}</div></div>
          {children}
        </main>
      </div>
    </MeCtx.Provider>
  );
}

export const Err = ({ msg }: { msg: string | null }) => (msg ? <div className="err" role="alert">{msg}</div> : null);
export const Loading = ({ on }: { on: boolean }) => (on ? <div className="muted">{t('common.loading')}</div> : null);

const POS: Record<string, string> = { cheapest: 'b-good', same: 'b-info', below_avg: 'b-good', avg: 'b-warn', above_avg: 'b-warn', most_expensive: 'b-bad', none: 'b-mute' };
export const PosBadge = ({ k }: { k: string }) => <span className={`badge ${POS[k] ?? 'b-mute'}`}>{t('pos.' + k)}</span>;
const LINK: Record<string, string> = { suggested: 'b-info', review: 'b-warn', approved: 'b-good', rejected: 'b-mute', invalidated: 'b-bad' };
export const LinkBadge = ({ s }: { s: string }) => <span className={`badge ${LINK[s] ?? 'b-mute'}`}>{t('link.' + s)}</span>;
export const RunBadge = ({ s }: { s: string | null }) => s ? <span className={`badge ${s === 'ok' ? 'b-good' : s === 'error' ? 'b-bad' : 'b-warn'}`}>{t('run.' + s)}</span> : <span className="badge b-mute">—</span>;
export const FreshBadge = ({ s }: { s: string }) => <span className={`badge ${s === 'fresh' ? 'b-good' : s === 'stale' ? 'b-bad' : 'b-mute'}`}>{t('fresh.' + s)}</span>;

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-label={title}><h2>{title}</h2>{children}</div></div>;
}
export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>;
}
export const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <div className="field"><label>{label}</label>{children}</div>;

/** Basit SVG çizgi grafik: seriler {name, color, points:[{x:Date ms, y:number}]}. */
export function LineChart({ series, height = 180 }: { series: { name: string; color: string; points: { x: number; y: number }[] }[]; height?: number }) {
  const all = series.flatMap((s) => s.points); if (!all.length) return <div className="muted">Veri yok</div>;
  const xs = all.map((p) => p.x), ys = all.map((p) => p.y); const x0 = Math.min(...xs), x1 = Math.max(...xs) || 1, y0 = Math.min(...ys) * 0.97, y1 = Math.max(...ys) * 1.03 || 1;
  const W = 640, P = 36; const sx = (x: number) => P + ((x - x0) / (x1 - x0 || 1)) * (W - P - 8); const sy = (y: number) => height - 22 - ((y - y0) / (y1 - y0 || 1)) * (height - 34);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Fiyat geçmişi grafiği">
        {[0, 0.5, 1].map((f) => { const y = y0 + (y1 - y0) * f; return <g key={f}><line x1={P} x2={W - 8} y1={sy(y)} y2={sy(y)} stroke="var(--line)" /><text x={2} y={sy(y) + 4} fontSize="10" fill="var(--muted)">{Math.round(y)}</text></g>; })}
        <text x={P} y={height - 4} fontSize="10" fill="var(--muted)">{new Date(x0).toLocaleDateString('tr-TR')}</text><text x={W - 8} y={height - 4} fontSize="10" textAnchor="end" fill="var(--muted)">{new Date(x1).toLocaleDateString('tr-TR')}</text>
        {series.map((s) => <g key={s.name}><polyline fill="none" stroke={s.color} strokeWidth="2" points={[...s.points].sort((a, b) => a.x - b.x).map((p) => `${sx(p.x)},${sy(p.y)}`).join(' ')} />{s.points.map((p, i) => <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="2.5" fill={s.color} />)}</g>)}
      </svg>
      <div className="chips">{series.map((s) => <span key={s.name} className="sub"><i style={{ display: 'inline-block', width: 10, height: 10, background: s.color, borderRadius: 2, marginRight: 4 }} />{s.name}</span>)}</div>
    </div>
  );
}
export const COLORS = ['#141ed2', '#0b6e8a', '#1a7f4b', '#9a6700', '#6b3fa0', '#0e7490', '#b45309', '#475569'];
