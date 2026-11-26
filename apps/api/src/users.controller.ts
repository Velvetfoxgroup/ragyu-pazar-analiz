import { Body, Controller, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ROLES, ROLE_LABELS, hashPassword, passwordProblem, generateTempPassword } from '@ragyu/core';
import { DB, Perm, CurrentUser, AuthUser, parse, httpErr, auditFrom } from './infra';

const role = z.enum(['admin', 'editor', 'approver', 'viewer']);
const pub = 'id, username, display_name AS "displayName", email, role, active, must_change_password AS "mustChangePassword", created_at AS "createdAt", last_login_at AS "lastLoginAt"';

@Controller('api/users')
export class UsersController {
  constructor(@Inject(DB) private db: Pool) {}

  @Perm('user:manage') @Get()
  async list(@CurrentUser() u: AuthUser) {
    const r = await this.db.query(`SELECT ${pub} FROM users WHERE org_id=$1 ORDER BY lower(username)`, [u.orgId]);
    return { users: r.rows.map((x) => ({ ...x, roleLabel: ROLE_LABELS[x.role as keyof typeof ROLE_LABELS] })), roles: ROLES.map((k) => ({ key: k, label: ROLE_LABELS[k] })) };
  }

  @Perm('user:manage') @Post()
  async create(@CurrentUser() u: AuthUser, @Body() body: unknown) {
    const b = parse(z.object({ username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/, 'yalnızca harf, rakam, . _ -'), displayName: z.string().min(2).max(80), email: z.string().email().optional().or(z.literal('')), role, password: z.string().optional() }), body);
    const temp = !b.password; const pw = b.password ?? generateTempPassword();
    const pp = passwordProblem(pw); if (pp) throw httpErr(400, pp, 'weak_password');
    const dup = await this.db.query('SELECT 1 FROM users WHERE org_id=$1 AND lower(username)=lower($2)', [u.orgId, b.username]);
    if (dup.rowCount) throw httpErr(409, 'Bu kullanıcı adı zaten kullanılıyor.', 'duplicate');
    const r = await this.db.query(`INSERT INTO users(org_id,username,display_name,email,password_hash,role,must_change_password) VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
      [u.orgId, b.username, b.displayName, b.email || null, await hashPassword(pw), b.role]);
    await auditFrom(this.db, u, 'user.created', 'user', r.rows[0].id, { username: b.username, role: b.role });
    // Geçici şifre yalnızca bu yanıtta bir kez gösterilir; ilk girişte değiştirilmesi zorunludur.
    return { id: r.rows[0].id, username: b.username, temporaryPassword: pw, generated: temp, mustChangePassword: true };
  }

  @Perm('user:manage') @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ displayName: z.string().min(2).max(80).optional(), email: z.string().email().nullable().optional(), role: role.optional(), active: z.boolean().optional() }), body);
    const cur = (await this.db.query('SELECT * FROM users WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!cur) throw httpErr(404, 'Kullanıcı bulunamadı.', 'not_found');
    const losingAdmin = cur.role === 'admin' && cur.active && ((b.role && b.role !== 'admin') || b.active === false);
    if (losingAdmin) {
      if (id === u.id) throw httpErr(400, 'Kendi yönetici yetkinizi veya hesabınızı kaldıramazsınız.', 'self_lockout');
      const n = Number((await this.db.query(`SELECT count(*) n FROM users WHERE org_id=$1 AND role='admin' AND active`, [u.orgId])).rows[0].n);
      if (n <= 1) throw httpErr(400, 'Son aktif yönetici kaldırılamaz.', 'last_admin');
    }
    await this.db.query(`UPDATE users SET display_name=COALESCE($3,display_name), email=CASE WHEN $4::boolean THEN $5 ELSE email END, role=COALESCE($6,role), active=COALESCE($7,active) WHERE id=$1 AND org_id=$2`,
      [id, u.orgId, b.displayName ?? null, b.email !== undefined, b.email ?? null, b.role ?? null, b.active ?? null]);
    if (b.active === false || (b.role && b.role !== cur.role)) await this.db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    if (b.role && b.role !== cur.role) await auditFrom(this.db, u, 'user.role_changed', 'user', id, { username: cur.username, from: cur.role, to: b.role });
    if (b.active !== undefined && b.active !== cur.active) await auditFrom(this.db, u, b.active ? 'user.activated' : 'user.deactivated', 'user', id, { username: cur.username });
    if (b.displayName || b.email !== undefined) await auditFrom(this.db, u, 'user.updated', 'user', id, { username: cur.username });
    return { ok: true };
  }

  /** E-posta altyapısı olmadan güvenli yönetici sıfırlaması: geçici şifre üretir, oturumları kapatır, ilk girişte değişim ister. */
  @Perm('user:manage') @Post(':id/reset-password')
  async reset(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const cur = (await this.db.query('SELECT username FROM users WHERE id=$1 AND org_id=$2', [id, u.orgId])).rows[0];
    if (!cur) throw httpErr(404, 'Kullanıcı bulunamadı.', 'not_found');
    const pw = generateTempPassword();
    await this.db.query('UPDATE users SET password_hash=$2, must_change_password=true WHERE id=$1', [id, await hashPassword(pw)]);
    await this.db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await auditFrom(this.db, u, 'user.password_reset', 'user', id, { username: cur.username });
    return { temporaryPassword: pw, mustChangePassword: true };
  }
}
