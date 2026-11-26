'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { Err } from '@/components/ui';

export default function Login() {
  const [u, setU] = useState(''); const [p, setP] = useState(''); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false); const router = useRouter();
  useEffect(() => { api('/setup/status').then((s: any) => setNeedsSetup(s.needsSetup)).catch(() => 0); }, []);
  return (
    <div className="login">
      <h1 style={{ color: 'var(--brand)' }}>{t('app.name')}</h1>
      <div className="card">
        <h2>{t('login.title')}</h2>
        <Err msg={err} />
        {needsSetup && <div className="note">Sistemde henüz yönetici yok. <Link href="/kurulum">İlk yönetici kurulumunu başlatın</Link>.</div>}
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { const me: any = await api('/auth/login', { method: 'POST', body: { username: u, password: p } }); router.push(me.mustChangePassword ? '/hesabim' : '/'); } catch (x: any) { setErr(x.message); } finally { setBusy(false); } }}>
          <div className="field"><label htmlFor="u">{t('login.username')}</label><input id="u" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} style={{ width: '100%' }} required /></div>
          <div className="field"><label htmlFor="p">{t('login.password')}</label><input id="p" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} style={{ width: '100%' }} required /></div>
          <button className="btn pri" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>{t('login.submit')}</button>
        </form>
        <p className="sub" style={{ marginTop: 12 }}>{t('login.help')}</p>
      </div>
    </div>
  );
}
