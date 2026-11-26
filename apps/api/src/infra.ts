import 'reflect-metadata';
import { CanActivate, ExecutionContext, HttpException, Inject, Injectable, SetMetadata, createParamDecorator, BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ZodSchema } from 'zod';
import type { Pool } from 'pg';
import { Permission, Role, can, hashToken, audit, runCheck, CheckResult, makeQueue, QueueEvents, redisConnection, SCRAPE_QUEUE, ScrapeJob } from '@ragyu/core';

export const DB = 'DB';
export const COOKIE = 'ragyu_session';
export const CSRF_HEADER = 'x-requested-with';
export const IDLE_MS = Number(process.env.SESSION_IDLE_MINUTES ?? 60) * 60_000;
export const ABSOLUTE_MS = Number(process.env.SESSION_MAX_HOURS ?? 12) * 3600_000;

export interface AuthUser { id: string; orgId: string; username: string; displayName: string; role: Role; mustChangePassword: boolean; sessionHash: string }

export const Public = () => SetMetadata('public', true);
export const Perm = (p: Permission) => SetMetadata('perm', p);
export const CurrentUser = createParamDecorator((_d, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
export const ClientIp = createParamDecorator((_d, ctx: ExecutionContext): string => {
  const r = ctx.switchToHttp().getRequest(); return r.ip ?? r.socket?.remoteAddress ?? 'unknown';
});

export function parse<T>(schema: ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException({ code: 'validation', message: r.error.issues.map((i) => `${i.path.join('.') || 'girdi'}: ${i.message}`).join('; ') });
  return r.data;
}
export const httpErr = (status: number, message: string, code = 'error') => new HttpException({ code, message }, status);

/** Her istekte: oturum doğrula → boşta kalma/mutlak süre → CSRF başlığı → rol izni (API tarafı yetki denetimi). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(DB) private db: Pool, @Inject(Reflector) private reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()]);
    const req = ctx.switchToHttp().getRequest();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers[CSRF_HEADER] !== 'ragyu') throw new ForbiddenException({ code: 'csrf', message: 'Geçersiz istek kaynağı.' });
    if (isPublic) return true;
    const token = req.cookies?.[COOKIE];
    if (!token) throw new UnauthorizedException({ code: 'unauthenticated', message: 'Oturum açmanız gerekiyor.' });
    const h = hashToken(token);
    const { rows } = await this.db.query(
      `SELECT s.created_at, s.last_seen_at, s.expires_at, u.id, u.org_id, u.username, u.display_name, u.role, u.active, u.must_change_password
         FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1`, [h]);
    const r = rows[0];
    const now = Date.now();
    if (!r || !r.active || now - new Date(r.last_seen_at).getTime() > IDLE_MS || now > new Date(r.expires_at).getTime()) {
      if (r) await this.db.query('DELETE FROM sessions WHERE token_hash=$1', [h]);
      throw new UnauthorizedException({ code: 'session_expired', message: 'Oturumunuz sona erdi. Lütfen yeniden giriş yapın.' });
    }
    if (now - new Date(r.last_seen_at).getTime() > 30_000) await this.db.query('UPDATE sessions SET last_seen_at=now() WHERE token_hash=$1', [h]);
    const user: AuthUser = { id: r.id, orgId: r.org_id, username: r.username, displayName: r.display_name, role: r.role, mustChangePassword: r.must_change_password, sessionHash: h };
    req.user = user;
    const allowedWhileMustChange = ['/api/auth/me', '/api/auth/password', '/api/auth/logout'];
    if (user.mustChangePassword && !allowedWhileMustChange.includes(req.path)) throw new ForbiddenException({ code: 'must_change_password', message: 'Devam etmeden önce şifrenizi değiştirmelisiniz.' });
    const perm = this.reflector.getAllAndOverride<Permission>('perm', [ctx.getHandler(), ctx.getClass()]) ?? 'read';
    if (!can(user.role, perm)) throw new ForbiddenException({ code: 'forbidden', message: 'Bu işlem için yetkiniz yok.' });
    return true;
  }
}

@Injectable()
export class QueueService {
  private queue = process.env.QUEUE_MODE === 'inline' || !process.env.REDIS_URL ? null : makeQueue();
  private events: QueueEvents | null = null;
  constructor(@Inject(DB) private db: Pool) {}
  get mode() { return this.queue ? 'redis' : 'inline'; }
  /** "Şimdi kontrol et": kuyruktaki işçiye gönderir ve sonucu bekler; kuyruk yoksa aynı süreçte çalıştırır. */
  async checkNow(trackedUrlId: string, userId: string): Promise<CheckResult | { pending: true }> {
    if (!this.queue) return runCheck(this.db, trackedUrlId, { trigger: 'manual', userId });
    if (!this.events) this.events = new QueueEvents(SCRAPE_QUEUE, { connection: redisConnection() });
    const job = await this.queue.add('check', { trackedUrlId, trigger: 'manual', userId } as ScrapeJob, { priority: 1 });
    try { return (await job.waitUntilFinished(this.events, 60_000)) as CheckResult; } catch { return { pending: true }; }
  }
  async health() {
    if (!this.queue) return { mode: 'inline' };
    try { await this.queue.getJobCounts('waiting'); return { mode: 'redis', ok: true }; } catch { return { mode: 'redis', ok: false }; }
  }
}

export async function auditFrom(db: Pool, u: AuthUser, action: string, entityType: string, entityId: string | undefined, details: unknown) {
  await audit(db, { orgId: u.orgId, actorId: u.id, actorName: `${u.displayName} (${u.username})`, action, entityType, entityId, details });
}
