/**
 * İlk (veya ek) sistem yöneticisini komut satırından oluşturur. Şifre kaynak kodda yoktur;
 * ADMIN_PASSWORD ortam değişkeni veya etkileşimli istemle verilir.
 */
import readline from 'node:readline';
import { getPool, migrate, closePool, audit } from '../db';
import { hashPassword, passwordProblem } from '../auth';

function ask(q: string, hidden = false): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((res) => {
    if (hidden) { (rl as any)._writeToOutput = (s: string) => { if (s.includes(q)) (rl as any).output.write(s); }; }
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); });
  });
}
async function main() {
  const db = getPool(); await migrate(db);
  const username = process.env.ADMIN_USERNAME ?? (await ask('Yönetici kullanıcı adı: '));
  const displayName = process.env.ADMIN_DISPLAY_NAME ?? (await ask('Görünen ad: '));
  const password = process.env.ADMIN_PASSWORD ?? (await ask('Şifre (en az 10 karakter, harf+rakam): ', true));
  const problem = passwordProblem(password); if (problem) throw new Error(problem);
  let org = (await db.query('SELECT id FROM organizations ORDER BY created_at LIMIT 1')).rows[0];
  if (!org) org = (await db.query(`INSERT INTO organizations(name,slug) VALUES ('Ragyu Kasap+','ragyu') RETURNING id`)).rows[0];
  const dup = await db.query('SELECT 1 FROM users WHERE org_id=$1 AND lower(username)=lower($2)', [org.id, username]);
  if (dup.rowCount) throw new Error('Bu kullanıcı adı zaten var.');
  const u = (await db.query(`INSERT INTO users(org_id,username,display_name,password_hash,role) VALUES ($1,$2,$3,$4,'admin') RETURNING id`, [org.id, username, displayName, await hashPassword(password)])).rows[0];
  await audit(db, { orgId: org.id, actorId: u.id, actorName: username, action: 'cli.admin_created', entityType: 'user', entityId: u.id });
  console.log(`Yönetici oluşturuldu: ${username}`);
  await closePool();
}
main().catch((e) => { console.error('Hata:', e.message); process.exit(1); });
