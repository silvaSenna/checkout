import { setTimeout as delay } from 'node:timers/promises';
import { readConfig } from './config.js';
import { compose } from './composition.js';

async function main() {
  const config = readConfig();
  const { pool, context, runner } = compose(config);
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    if (!runner) throw new Error('Configure Mercado Pago para executar o worker.');
    await context.checkDatabase();
    console.info(JSON.stringify({ event: 'worker.started' }));
    while (!stopping) {
      try {
        if (!(await runner.runOnce())) await delay(config.WORKER_POLL_MS);
      } catch {
        console.error(JSON.stringify({ event: 'worker.queue_error' }));
        await delay(config.WORKER_POLL_MS);
      }
    }
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  console.error('Falha ao iniciar worker. Verifique configuração e banco.');
  process.exitCode = 1;
});
