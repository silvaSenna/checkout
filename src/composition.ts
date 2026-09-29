import { Payments } from './application/payments.js';
import { ProcessJob } from './application/process-job.js';
import type { Config } from './config.js';
import { createPool } from './infrastructure/database/database.js';
import { PgPaymentRepository } from './infrastructure/database/payment-repository.js';
import { PgJobQueue } from './infrastructure/jobs/pg-job-queue.js';
import { JobRunner } from './infrastructure/jobs/runner.js';
import { MercadoPagoGateway } from './infrastructure/mercado-pago/gateway.js';

export function compose(config: Config) {
  const pool = createPool(config.DATABASE_URL);
  pool.on('error', () => console.error(JSON.stringify({ event: 'database.pool_error' })));
  const repository = new PgPaymentRepository(pool);
  const jobs = new PgJobQueue(pool);
  const context = {
    config,
    close: () => pool.end(),
    payments: new Payments(repository),
    jobs,
    checkDatabase: async () => {
      await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
    },
  };
  const gateway = config.MP_ACCESS_TOKEN
    ? new MercadoPagoGateway({
        accessToken: config.MP_ACCESS_TOKEN,
        webhookUrl: config.MP_WEBHOOK_URL!,
        returnUrl: config.MP_RETURN_URL!,
        collectorId: config.MP_COLLECTOR_ID!,
        sandbox: config.MP_SANDBOX,
        timeoutMs: config.MP_TIMEOUT_MS,
      })
    : null;
  const runner = gateway ? new JobRunner(jobs, new ProcessJob(repository, gateway)) : null;
  return { pool, context, runner };
}
