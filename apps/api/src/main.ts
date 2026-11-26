import { createApp } from './bootstrap';
import { getPool, migrate } from '@ragyu/core';

async function main() {
  if (process.env.AUTO_MIGRATE !== 'false') await migrate(getPool(), (m) => console.log('[migrate]', m));
  const app = await createApp();
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, process.env.API_HOST ?? '0.0.0.0');
  console.log(`API dinleniyor: ${port}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
