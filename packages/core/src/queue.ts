import { Queue, QueueEvents, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';

export const SCRAPE_QUEUE = 'scrape';
export interface ScrapeJob { trackedUrlId: string; trigger: 'scheduled' | 'manual' | 'retry'; userId?: string | null }

export function redisConnection(url = process.env.REDIS_URL) {
  if (!url) throw new Error('REDIS_URL tanımlı değil');
  return new IORedis(url, { maxRetriesPerRequest: null });
}
export function makeQueue(conn = redisConnection()) {
  return new Queue<ScrapeJob>(SCRAPE_QUEUE, { connection: conn, defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 1000 } });
}
export { Queue, QueueEvents, Worker, Job };
