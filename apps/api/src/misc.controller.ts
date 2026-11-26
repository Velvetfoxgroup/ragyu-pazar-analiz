import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { DB, Public, Perm, CurrentUser, AuthUser, parse, httpErr, auditFrom, QueueService } from './infra';

@Controller('api')
export class MiscController {
  constructor(@Inject(DB) private db: Pool, @Inject(QueueService) private queue: QueueService) {}

  @Public() @Get('health')
  async health() {
    let dbOk = false; try { await this.db.query('SELECT 1'); dbOk = true; } catch { /* */ }
    const q = await this.queue.health();
    const body = { status: dbOk ? 'ok' : 'error', db: dbOk, queue: q };
    if (!dbOk) throw httpErr(503, 'Veritabanına ulaşılamıyor.', 'db_down');
    return body;
  }

  @Get('alerts')
  async alerts(@CurrentUser() u: AuthUser, @Query('status') status = 'open') {
    return (await this.db.query(`SELECT * FROM alerts WHERE org_id=$1 AND status=$2 ORDER BY created_at DESC LIMIT 500`, [u.orgId, status])).rows;
  }

  /** Uyarıyı kapat. Fiyat sıçramasında "kabul et" seçilirse gözlem güvenilir sayılır; aksi hâlde dışarıda kalır. */
  @Perm('alert:resolve') @Post('alerts/:id/resolve')
  async resolve(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(z.object({ acceptObservation: z.boolean().optional(), note: z.string().max(300).optional() }), body ?? {});
    const a = (await this.db.query(`SELECT * FROM alerts WHERE id=$1 AND org_id=$2 AND status='open'`, [id, u.orgId])).rows[0];
    if (!a) throw httpErr(404, 'Uyarı bulunamadı.', 'not_found');
    if (b.acceptObservation && a.type === 'price_jump') {
      await this.db.query(`UPDATE price_observations SET quality='ok', quality_reasons = quality_reasons || $2::jsonb WHERE id=$1 AND org_id=$3`, [a.ref_id, JSON.stringify([{ code: 'accepted', message: `Fiyat sıçraması ${u.displayName} tarafından kabul edildi.` }]), u.orgId]);
    }
    await this.db.query(`UPDATE alerts SET status='resolved', resolved_by=$2, resolved_at=now() WHERE id=$1`, [id, u.id]);
    await auditFrom(this.db, u, 'alert.resolved', 'alert', id, { type: a.type, accepted: !!b.acceptObservation, note: b.note });
    return { ok: true };
  }

  @Perm('audit:read') @Get('audit')
  async audit(@CurrentUser() u: AuthUser, @Query() q: Record<string, string>) {
    const p: any[] = [u.orgId]; let w = 'org_id=$1';
    if (q.action) { p.push(q.action + '%'); w += ` AND action LIKE $${p.length}`; }
    if (q.actor) { p.push(`%${q.actor.toLowerCase()}%`); w += ` AND lower(actor_name) LIKE $${p.length}`; }
    const limit = Math.min(500, Number(q.limit ?? 200));
    return (await this.db.query(`SELECT id, actor_name, action, entity_type, entity_id, details, at FROM audit_log WHERE ${w} ORDER BY at DESC, id DESC LIMIT ${limit}`, p)).rows;
  }

  /** Başarısız / incelemedeki tarama işleri listesi. */
  @Get('runs')
  async runs(@CurrentUser() u: AuthUser, @Query('status') status = 'error') {
    return (await this.db.query(
      `SELECT r.id, r.tracked_url_id, r.url, r.trigger, r.started_at, r.finished_at, r.status, r.http_status, r.error, s.name AS source_name, cp.title
         FROM scrape_runs r JOIN tracked_urls t ON t.id=r.tracked_url_id JOIN sources s ON s.id=t.source_id JOIN competitor_products cp ON cp.id=t.competitor_product_id
        WHERE r.org_id=$1 AND ($2='all' OR r.status=$2) ORDER BY r.started_at DESC LIMIT 200`, [u.orgId, status])).rows;
  }
}
