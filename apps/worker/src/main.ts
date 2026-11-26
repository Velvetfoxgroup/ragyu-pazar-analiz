import { getPool, migrate, runCheck, claimDue, refreshStaleAlerts, Worker, makeQueue, redisConnection, SCRAPE_QUEUE, ScrapeJob } from '@ragyu/core';

/**
 * Bağımsız veri toplama işçisi: API'den ayrı süreçtir, yeniden başlatılabilir.
 * - Zamanlayıcı: her dakika zamanı gelen izlenen URL'leri kuyruğa alır.
 * - İşçi: kuyruktan gelen işleri sırayla (kaynak başına hız sınırıyla) çalıştırır.
 */
async function main() {
  const db = getPool();
  if (process.env.AUTO_MIGRATE !== 'false') await migrate(db);
  const queue = makeQueue();
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);
  const worker = new Worker<ScrapeJob>(SCRAPE_QUEUE, async (job) => runCheck(db, job.data.trackedUrlId, { trigger: job.data.trigger, userId: job.data.userId }), { connection: redisConnection(), concurrency });
  worker.on('failed', (j, e) => console.error('[worker] iş başarısız', j?.id, e.message));
  worker.on('completed', (j, r: any) => console.log(`[worker] ${j.data.trackedUrlId} → ${r?.status}`));

  const tick = async () => {
    try {
      const due = await claimDue(db, Number(process.env.SCHEDULER_BATCH ?? 50));
      for (const d of due) await queue.add('check', { trackedUrlId: d.id, trigger: 'scheduled' });
      if (due.length) console.log(`[scheduler] ${due.length} iş kuyruğa alındı`);
    } catch (e: any) { console.error('[scheduler]', e.message); }
  };
  const housekeeping = async () => {
    try {
      await refreshStaleAlerts(db);
      await db.query(`DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - interval '1 day'`);
      await db.query(`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`);
    } catch (e: any) { console.error('[housekeeping]', e.message); }
  };
  await tick(); await housekeeping();
  const t1 = setInterval(tick, 60_000); const t2 = setInterval(housekeeping, 10 * 60_000);
  console.log('Veri toplama işçisi çalışıyor.');
  const stop = async () => { clearInterval(t1); clearInterval(t2); await worker.close(); await queue.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
main().catch((e) => { console.error(e); process.exit(1); });
