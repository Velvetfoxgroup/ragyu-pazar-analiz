'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Shell, useLoad, Err, Loading, Modal, Field, useMe } from '@/components/ui';
import { dt } from '@/lib/format';

function Inner() {
  const me = useMe(); const { data, error, loading, reload } = useLoad(() => api<any>('/users'), []); const [add, setAdd] = useState(false); const [f, setF] = useState({ username: '', displayName: '', email: '', role: 'editor' }); const [err, setErr] = useState<string | null>(null); const [cred, setCred] = useState<any>(null);
  const act = async (fn: () => Promise<any>) => { setErr(null); try { return await fn(); } catch (x: any) { setErr(x.message); } };
  return <>
    <Err msg={error ?? err} /><Loading on={loading && !data} />
    {cred && <Modal title="Geçici şifre" onClose={() => setCred(null)}><div className="warnbox">Bu şifre yalnızca <b>bir kez</b> gösterilir. Çalışana güvenli bir kanaldan iletin; ilk girişte değiştirmesi zorunludur.</div><p>Kullanıcı: <b>{cred.username}</b></p><p className="mono" style={{ fontSize: 18 }}>{cred.temporaryPassword}</p><button className="btn" onClick={() => navigator.clipboard?.writeText(cred.temporaryPassword)}>Kopyala</button> <button className="btn pri" onClick={() => setCred(null)}>Tamam</button></Modal>}
    <div className="card tw"><div className="row" style={{ marginBottom: 10 }}><button className="btn pri" onClick={() => setAdd(true)}>+ Çalışan hesabı aç</button></div>
      <table><thead><tr><th>Kullanıcı</th><th>Rol</th><th>Durum</th><th>Son giriş</th><th></th></tr></thead><tbody>{data?.users.map((u: any) => <tr key={u.id}><td><b>{u.displayName}</b><div className="sub">{u.username}{u.email ? ` · ${u.email}` : ''}</div></td>
        <td><select value={u.role} disabled={u.id === me.id} onChange={async (e) => { await act(() => api(`/users/${u.id}`, { method: 'PATCH', body: { role: e.target.value } })); reload(); }}>{data.roles.map((r: any) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></td>
        <td>{u.active ? <span className="badge b-good">Aktif</span> : <span className="badge b-mute">Devre dışı</span>}{u.mustChangePassword && <div className="sub">şifre değişimi bekliyor</div>}</td><td>{dt(u.lastLoginAt)}</td>
        <td className="r nowrap"><button className="btn sm" onClick={async () => { if (!confirm(`${u.username} için geçici şifre üretilsin mi? Açık oturumları kapanır.`)) return; const r = await act(() => api(`/users/${u.id}/reset-password`, { method: 'POST' })); if (r) setCred({ username: u.username, ...r }); }}>Şifre sıfırla</button> {u.id !== me.id && <button className="btn sm" onClick={async () => { await act(() => api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } })); reload(); }}>{u.active ? 'Devre dışı bırak' : 'Etkinleştir'}</button>}</td></tr>)}</tbody></table></div>
    {add && <Modal title="Çalışan hesabı aç" onClose={() => setAdd(false)}><form onSubmit={async (e) => { e.preventDefault(); const r = await act(() => api('/users', { method: 'POST', body: { ...f, email: f.email || undefined } })); if (r) { setAdd(false); setCred(r); reload(); } }}>
      <Field label="Kullanıcı adı"><input style={{ width: '100%' }} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} required minLength={3} /></Field><Field label="Ad soyad"><input style={{ width: '100%' }} value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} required /></Field>
      <Field label="E-posta (isteğe bağlı)"><input type="email" style={{ width: '100%' }} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="Rol"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} style={{ width: '100%' }}>{data?.roles.map((r: any) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field>
      <p className="sub">Güvenli bir geçici şifre üretilir ve bir kez gösterilir.</p><button className="btn pri">Hesabı oluştur</button></form></Modal>}
  </>;
}
export default function Page() { return <Shell title="Çalışan hesapları" sub="Hesapları yalnızca sistem yöneticisi açar, rollerini ve durumunu değiştirir."><Inner /></Shell>; }
