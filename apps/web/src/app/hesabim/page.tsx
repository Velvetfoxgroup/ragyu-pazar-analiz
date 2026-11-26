'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Shell, Err, useMe } from '@/components/ui';

function Inner() {
  const me = useMe(); const router = useRouter(); const [f, setF] = useState({ currentPassword: '', newPassword: '', again: '' }); const [err, setErr] = useState<string | null>(null); const [ok, setOk] = useState(false);
  return (
    <div className="card" style={{ maxWidth: 460 }}>
      {me.mustChangePassword && <div className="warnbox">Devam etmek için geçici şifrenizi değiştirmelisiniz.</div>}
      <p className="sub">{me.displayName} · {me.username} · {me.roleLabel}</p>
      <Err msg={err} />{ok && <div className="ok">Şifreniz değiştirildi.</div>}
      <form onSubmit={async (e) => { e.preventDefault(); setErr(null); setOk(false); if (f.newPassword !== f.again) return setErr('Yeni şifreler eşleşmiyor.'); try { await api('/auth/password', { method: 'POST', body: { currentPassword: f.currentPassword, newPassword: f.newPassword } }); setOk(true); setF({ currentPassword: '', newPassword: '', again: '' }); if (me.mustChangePassword) router.push('/'); } catch (x: any) { setErr(x.message); } }}>
        <div className="field"><label>Mevcut şifre</label><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} style={{ width: '100%' }} required /></div>
        <div className="field"><label>Yeni şifre (en az 10 karakter, harf ve rakam)</label><input type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} style={{ width: '100%' }} required /></div>
        <div className="field"><label>Yeni şifre (tekrar)</label><input type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} style={{ width: '100%' }} required /></div>
        <button className="btn pri">Şifreyi değiştir</button>
      </form>
    </div>
  );
}
export default function Page() { return <Shell title="Hesabım"><Inner /></Shell>; }
