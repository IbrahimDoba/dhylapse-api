import { closeDb } from './db/client.ts';
import { preflight } from './db/preflight.ts';
import { env } from './env.ts';
import { buildApp } from './app.ts';
import { startScheduler } from './jobs/scheduler.ts';

const app = await buildApp();

try {
  await preflight();
  app.log.info('preflight ok — RLS enforced, ledger triggers present');
} catch (err) {
  app.log.error((err as Error).message);
  await closeDb();
  process.exit(1);
}

await app.listen({ port: env.PORT, host: env.HOST });

const scheduler = startScheduler(app);

/**
 * Graceful shutdown. Railway/Render/Fly send SIGTERM on deploy; without this
 * the process dies mid-request and in-flight writes are cut off.
 */
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      scheduler.stop();
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  });
}
