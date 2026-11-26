'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Err } from '@/components/ui';

export default function Setup() {
  const [st, setSt] = useState<any>(null); const [f, setF] = useState({ token: '', username: '', displayName: '', password: '' }); const [err, setErr] = useState<string | null>(null); const [done, setDone] = useState(false);
  useEffect(() => { api('/setup/status').then(setSt).catch((e) => setErr(e.message)); }, []);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="login">
      <div style={{ marginBottom: 14 }}><span className="logo-plate"><img src="/ragyu-logo.png" alt="Ragyu Kasap+" width={200} height={38} /></span></div><h1 style={{ color: 'var(--ink)' }}>İlk yönetici kurulumu</h1>
      <div className="card">
        {st && !st.needsSetup && <div className="note">Kurulum tamamlanmış. <Link href="/login">Girişe dönün</Link>.</div>}
        {done && <div className="ok">Yönetici oluşturuldu. <Link href="/login">Giriş yapın</Link>.</div>}
        <Err msg={err} />
        {st?.needsSetup && !done && <form onSubmit={async (e) => { e.preventDefault(); setErr(null); try { await api('/setup/admin', { method: 'POST', body: f }); setDone(true); } catch (x: any) { setErr(x.message); } }}>
          <p className="sub">Kurulum anahtarı, sunucudaki <span className="mono">.env</span> dosyasında tanımlı <span className="mono">SETUP_TOKEN</span> değeridir. Yalnızca sistemde hiç kullanıcı yokken çalışır.</p>
          <div className="field"><label>Kurulum anahtarı</label><input type="password" value={f.token} onChange={set('token')} style={{ width: '100%' }} required /></div>
          <div className="field"><label>Kullanıcı adı</label><input value={f.username} onChange={set('username')} style={{ width: '100%' }} required minLength={3} /></div>
          <div className="field"><label>Ad soyad</label><input value={f.displayName} onChange={set('displayName')} style={{ width: '100%' }} required /></div>
          <div className="field"><label>Şifre (en az 10 karakter, harf ve rakam)</label><input type="password" autoComplete="new-password" value={f.password} onChange={set('password')} style={{ width: '100%' }} required /></div>
          <button className="btn pri" style={{ width: '100%', justifyContent: 'center' }}>Yöneticiyi oluştur</button>
        </form>}
      </div>
    </div>
  );
}
