import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Job, JobQueue } from '../../application/ports.js';
import { transaction } from '../database/database.js';

export class PgJobQueue implements JobQueue {
  constructor(
    private readonly pool: Pool,
    private readonly maxAttempts = 8,
  ) {}

  async enqueueWebhook(providerPaymentId: string, deliveryKey: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO jobs (id, kind, dedup_key, payload) VALUES ($1, 'SYNC_PAYMENT', $2, $3)
       ON CONFLICT (dedup_key) DO NOTHING`,
      [randomUUID(), `webhook:${deliveryKey}`, { providerPaymentId }],
    );
  }

  async claim(): Promise<Job | null> {
    const result = await this.pool.query<Job>(
      `WITH candidate AS (
        SELECT id FROM jobs WHERE (status = 'READY' AND available_at <= now())
          OR (status = 'RUNNING' AND lease_until < now())
        ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
       ) UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1,
         lease_until = now() + interval '60 seconds', lease_token = $1, updated_at = now()
       FROM candidate WHERE jobs.id = candidate.id
       RETURNING jobs.id, kind, payload, attempts, lease_token AS "leaseToken"`,
      [randomUUID()],
    );
    return result.rows[0] ?? null;
  }

  async complete(job: Job): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status = 'DONE', lease_until = NULL, lease_token = NULL, updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'`,
      [job.id, job.leaseToken],
    );
  }

  async fail(job: Job, code: string, retryable: boolean): Promise<void> {
    const dead = !retryable || job.attempts >= this.maxAttempts;
    const delay = Math.min(300, 2 ** Math.min(job.attempts, 10)) + Math.floor(Math.random() * 3);
    await transaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE jobs SET status = $3, last_error_code = $4,
          available_at = now() + ($5 * interval '1 second'), lease_until = NULL, lease_token = NULL, updated_at = now()
         WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING' RETURNING id`,
        [job.id, job.leaseToken, dead ? 'DEAD' : 'READY', code, delay],
      );
      if (result.rowCount && dead && job.kind === 'CREATE_PREFERENCE') {
        const changed = await client.query<{ id: string; status: string; version: number }>(
          `UPDATE payments SET checkout_status = 'REQUIRES_REVIEW', version = version + 1, updated_at = now()
           WHERE id = $1 AND preference_id IS NULL RETURNING id, status, version`,
          [job.payload.paymentId],
        );
        if (changed.rows[0]) {
          const p = changed.rows[0];
          await client.query(
            `INSERT INTO payment_events (payment_id, previous_status, status, version, actor)
             VALUES ($1, $2, $2, $3, 'WORKER')`,
            [p.id, p.status, p.version],
          );
        }
      }
    });
  }
}
