import { Body, Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { hashPassword, verifyPassword, passwordProblem, newToken, hashToken, permissionsOf, ROLE_LABELS, tx, audit } from '@ragyu/core';
import { DB, COOKIE, Public, CurrentUser, AuthUser, ClientIp, parse, httpErr, ABSOLUTE_MS, auditFrom } from './infra';

const DUMMY_HASH = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
const WINDOW_MIN = 15; const MAX_USER_FAILS = Number(process.env.LOGIN_MAX_FAILS ?? 5); const MAX_IP_FAILS = 40;

const cookieOpts = () => ({ httpOnly: true, sameSite: 'strict' as const, secure: process.env.COOKIE_SECURE === 'true', path: '/', maxAge: ABSOLUTE_MS });

@Controller('api')
export class AuthController {
  constructor(@Inject(DB) private db: Pool) {}

  @Public() @Get('setup/status')
  async setupStatus() {
    const n = Number((await this.db.query('SELECT count(*) n FROM users')).rows[0].n);
    return { needsSetup: n === 0, tokenConfigured: !!process.env.SETUP_TOKEN };
  }

  /** İlk yönetici: yalnızca hiç kullanıcı yokken ve sunucu ortamında tanımlı SETUP_TOKEN ile. */
  @Public() @Post('setup/admin')
  async setupAdmin(@Body() body: unknown) {
    const b = parse(z.object({ token: z.string(), username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/), displayName: z.string().min(2).max(80), password: z.string(), orgName: z.string().optional() }), body);
    const expected = process.env.SETUP_TOKEN;
    if (!expected || expected.length < 16) throw httpErr(503, 'Kurulum anahtarı (SETUP_TOKEN, en az 16 karakter) sunucuda tanımlı değil.', 'setup_disabled');
    const a = Buffer.from(b.token); const e = Buffer.from(expected);
    if (a.length !== e.length || !timingSafeEqual(a, e)) throw httpErr(403, 'Kurulum anahtarı hatalı.', 'bad_setup_token');
    const pp = passwordProblem(b.password); if (pp) throw httpErr(400, pp, 'weak_password');
    const hash = await hashPassword(b.password);
    return tx(this.db, async (c) => {
      await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
      if (Number((await c.query('SELECT count(*) n FROM users')).rows[0].n) > 0) throw httpErr(409, 'Kurulum zaten tamamlanmış.', 'already_setup');
      let org = (await c.query('SELECT id FROM organizations ORDER BY created_at LIMIT 1')).rows[0];
      if (!org) org = (await c.query(`INSERT INTO organizations(name, slug) VALUES ($1,'ragyu') RETURNING id`, [b.orgName ?? 'Ragyu Kasap+'])).rows[0];
      const u = (await c.query(`INSERT INTO users(org_id,username,display_name,password_hash,role) VALUES ($1,$2,$3,$4,'admin') RETURNING id`, [org.id, b.username, b.displayName, hash])).rows[0];
      await audit(c, { orgId: org.id, actorId: u.id, actorName: b.username, action: 'setup.first_admin', entityType: 'user', entityId: u.id });
      return { ok: true };
    });
  }

  @Public() @Post('auth/login')
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: any, @ClientIp() ip: string) {
    const b = parse(z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(200) }), body);
    const ukey = `u:${b.username.toLowerCase()}`; const ikey = `i:${ip}`;
    const fails = await this.db.query(
      `SELECT key, count(*)::int n FROM login_attempts WHERE key = ANY($1) AND NOT success AND at > now() - ($2 || ' minutes')::interval GROUP BY key`, [[ukey, ikey], String(WINDOW_MIN)]);
    const nf = (k: string) => fails.rows.find((r) => r.key === k)?.n ?? 0;
    if (nf(ukey) >= MAX_USER_FAILS || nf(ikey) >= MAX_IP_FAILS) throw httpErr(429, `Çok fazla başarısız giriş denemesi. ${WINDOW_MIN} dakika sonra tekrar deneyin.`, 'rate_limited');
    const { rows } = await this.db.query('SELECT * FROM users WHERE lower(username)=lower($1) ORDER BY active DESC LIMIT 1', [b.username]);
    const u = rows[0];
    const ok = await verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok || !u.active) {
      await this.db.query('INSERT INTO login_attempts(key,success) VALUES ($1,false),($2,false)', [ukey, ikey]);
      throw httpErr(401, 'Kullanıcı adı veya şifre hatalı.', 'bad_credentials');
    }
    await this.db.query('DELETE FROM login_attempts WHERE key=$1', [ukey]);
    const token = newToken();
    await this.db.query('INSERT INTO sessions(token_hash,user_id,org_id,expires_at) VALUES ($1,$2,$3, now() + ($4 || \' milliseconds\')::interval)', [hashToken(token), u.id, u.org_id, String(ABSOLUTE_MS)]);
    await this.db.query('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
    await audit(this.db, { orgId: u.org_id, actorId: u.id, actorName: u.username, action: 'auth.login', entityType: 'user', entityId: u.id });
    res.cookie(COOKIE, token, cookieOpts());
    return this.me({ id: u.id, orgId: u.org_id, username: u.username, displayName: u.display_name, role: u.role, mustChangePassword: u.must_change_password, sessionHash: '' });
  }

  @Post('auth/logout')
  async logout(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: any) {
    await this.db.query('DELETE FROM sessions WHERE token_hash=$1', [u.sessionHash]);
    res.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('auth/me')
  me(@CurrentUser() u: AuthUser) {
    return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, roleLabel: ROLE_LABELS[u.role], permissions: permissionsOf(u.role), mustChangePassword: u.mustChangePassword };
  }

  @Post('auth/password')
  async changePassword(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), body);
    const row = (await this.db.query('SELECT password_hash FROM users WHERE id=$1', [u.id])).rows[0];
    if (!(await verifyPassword(b.currentPassword, row.password_hash))) throw httpErr(400, 'Mevcut şifre hatalı.', 'bad_current_password');
    const pp = passwordProblem(b.newPassword); if (pp) throw httpErr(400, pp, 'weak_password');
    if (b.newPassword === b.currentPassword) throw httpErr(400, 'Yeni şifre eskisiyle aynı olamaz.', 'same_password');
    await this.db.query('UPDATE users SET password_hash=$2, must_change_password=false WHERE id=$1', [u.id, await hashPassword(b.newPassword)]);
    await this.db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [u.id, u.sessionHash]); // diğer oturumlar kapanır
    await auditFrom(this.db, u, 'auth.password_changed', 'user', u.id, {});
    return { ok: true };
  }
}
