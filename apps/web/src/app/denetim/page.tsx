'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Shell, useLoad, Err, Loading } from '@/components/ui';
import { dt } from '@/lib/format';

const LABEL: Record<string, string> = { 'link.approved': 'Eşleşme onaylandı', 'link.rejected': 'Eşleşme reddedildi', 'link.invalidated': 'Eşleşme geçersiz kılındı', 'link.reassigned': 'Eşleşme düzeltildi', 'link.created': 'Eşleşme oluşturuldu', 'url.added': 'Rakip URL’si eklendi', 'url.changed': 'Rakip URL’si değiştirildi', 'url.deactivated': 'URL devre dışı bırakıldı', 'url.activated': 'URL etkinleştirildi', 'url.check_now': 'Şimdi kontrol et', 'qty_override.created': 'Gramaj düzeltmesi girildi', 'qty_override.approved': 'Gramaj düzeltmesi onaylandı', 'qty_override.rejected': 'Gramaj düzeltmesi reddedildi', 'user.created': 'Hesap açıldı', 'user.role_changed': 'Rol değişti', 'user.deactivated': 'Hesap devre dışı', 'user.activated': 'Hesap etkinleştirildi', 'user.password_reset': 'Şifre sıfırlandı', 'auth.login': 'Giriş', 'auth.password_changed': 'Şifre değişti', 'product.created': 'Ürün eklendi', 'product.updated': 'Ürün güncellendi', 'catalog.imported': 'Katalog içe aktarıldı', 'setup.first_admin': 'İlk yönetici kuruldu', 'alert.resolved': 'Uyarı kapatıldı' };

function Inner() {
  const [action, setAction] = useState(''); const [actor, setActor] = useState(''); const { data, error, loading } = useLoad(() => api<any[]>('/audit', { query: { action, actor, limit: 300 } }), [action, actor]);
  return <><div className="card"><div className="row"><div><label>İşlem öneki (örn. link, url, user)</label><input value={action} onChange={(e) => setAction(e.target.value)} /></div><div><label>Kişi</label><input value={actor} onChange={(e) => setActor(e.target.value)} /></div></div></div>
    <Err msg={error} /><Loading on={loading && !data} /><div className="card tw"><table><thead><tr><th>Zaman</th><th>Kişi</th><th>İşlem</th><th>Ayrıntı</th></tr></thead><tbody>{(data ?? []).map((a) => <tr key={a.id}><td className="nowrap">{dt(a.at)}</td><td>{a.actor_name}</td><td>{LABEL[a.action] ?? a.action}<div className="sub mono">{a.action}</div></td><td className="sub mono" style={{ maxWidth: 480, wordBreak: 'break-all' }}>{JSON.stringify(a.details)}</td></tr>)}</tbody></table></div></>;
}
export default function Page() { return <Shell title="Denetim kayıtları" sub="Kim, neyi, ne zaman yaptı"><Inner /></Shell>; }
