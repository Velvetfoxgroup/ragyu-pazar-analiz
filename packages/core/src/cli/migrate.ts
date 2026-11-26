import { getPool, migrate, closePool } from '../db';
migrate(getPool(), console.log).then((a) => { console.log(a.length ? `${a.length} geçiş uygulandı.` : 'Veritabanı güncel.'); return closePool(); }).catch((e) => { console.error(e); process.exit(1); });
