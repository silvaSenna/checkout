import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PaymentFilter, PaymentRepository } from '../../application/ports.js';
import { AppError } from '../../domain/errors.js';
import type { Payment } from '../../domain/payment.js';
import { transaction } from './database.js';

const columns = `id, cpf, description, amount_cents AS "amountCents", payment_method AS "paymentMethod",
  status, checkout_status AS "checkoutStatus", preference_id AS "preferenceId", checkout_url AS "checkoutUrl",
  provider_payment_id AS "providerPaymentId", provider_updated_at AS "providerUpdatedAt",
  version, created_at AS "createdAt", updated_at AS "updatedAt"`;
type Row = Omit<Payment, 'createdAt' | 'updatedAt' | 'providerUpdatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
  providerUpdatedAt: Date | null;
};
const map = (row: Row): Payment => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  providerUpdatedAt: row.providerUpdatedAt?.toISOString() ?? null,
});

export class PgPaymentRepository implements PaymentRepository {
  constructor(private readonly pool: Pool) {}

  async create(payment: Payment, key: string, fingerprint: string) {
    return transaction(this.pool, async (client) => {
      // Serialize only the same idempotency key, including requests on other API replicas.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      const existing = await client.query<{ fingerprint: string; payment_id: string }>(
        'SELECT fingerprint, payment_id FROM idempotency_keys WHERE key = $1',
        [key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== fingerprint) {
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Chave já utilizada com dados diferentes.',
            409,
          );
        }
        const found = await client.query<Row>(`SELECT ${columns} FROM payments WHERE id = $1`, [
          existing.rows[0].payment_id,
        ]);
        return { payment: map(found.rows[0]!), created: false };
      }
      const result = await client.query<Row>(
        `INSERT INTO payments (id, cpf, description, amount_cents, payment_method, status, checkout_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${columns}`,
        [
          payment.id,
          payment.cpf,
          payment.description,
          payment.amountCents,
          payment.paymentMethod,
          payment.status,
          payment.checkoutStatus,
        ],
      );
      await client.query(
        'INSERT INTO idempotency_keys (key, fingerprint, payment_id) VALUES ($1, $2, $3)',
        [key, fingerprint, payment.id],
      );
      await client.query(
        "INSERT INTO payment_events (payment_id, status, version, actor) VALUES ($1, 'PENDING', 1, 'API')",
        [payment.id],
      );
      if (payment.paymentMethod === 'CREDIT_CARD') {
        await client.query(
          "INSERT INTO jobs (id, kind, dedup_key, payload) VALUES ($1, 'CREATE_PREFERENCE', $2, $3)",
          [randomUUID(), `preference:${payment.id}`, { paymentId: payment.id }],
        );
      }
      return { payment: map(result.rows[0]!), created: true };
    });
  }

  async find(id: string): Promise<Payment | null> {
    const result = await this.pool.query<Row>(`SELECT ${columns} FROM payments WHERE id = $1`, [
      id,
    ]);
    return result.rows[0] ? map(result.rows[0]) : null;
  }

  async list(filter: PaymentFilter): Promise<Payment[]> {
    const values: unknown[] = [];
    const predicates: string[] = [];
    for (const [column, value] of [
      ['cpf', filter.cpf],
      ['payment_method', filter.paymentMethod],
      ['status', filter.status],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        predicates.push(`${column} = $${values.length}`);
      }
    }
    if (filter.after) {
      values.push(filter.after);
      predicates.push(`id > $${values.length}`);
    }
    values.push(filter.limit);
    const result = await this.pool.query<Row>(
      `SELECT ${columns} FROM payments ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''}
       ORDER BY id ASC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(map);
  }

  async save(payment: Payment, expectedVersion: number, actor: string): Promise<Payment> {
    return transaction(this.pool, async (client) => {
      const previous = await client.query<{ status: string }>(
        'SELECT status FROM payments WHERE id = $1 FOR UPDATE',
        [payment.id],
      );
      const result = await client.query<Row>(
        `UPDATE payments SET description = $2, status = $3, checkout_status = $4,
         preference_id = $5, checkout_url = $6, provider_payment_id = $7, provider_updated_at = $8,
         version = version + 1, updated_at = clock_timestamp() WHERE id = $1 AND version = $9 RETURNING ${columns}`,
        [
          payment.id,
          payment.description,
          payment.status,
          payment.checkoutStatus,
          payment.preferenceId,
          payment.checkoutUrl,
          payment.providerPaymentId,
          payment.providerUpdatedAt,
          expectedVersion,
        ],
      );
      if (!result.rows[0]) throw new AppError('VERSION_CONFLICT', 'Versão desatualizada.', 412);
      const saved = map(result.rows[0]);
      await client.query(
        `INSERT INTO payment_events (payment_id, previous_status, status, version, actor, provider_payment_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          payment.id,
          previous.rows[0]!.status,
          saved.status,
          saved.version,
          actor,
          saved.providerPaymentId,
        ],
      );
      return saved;
    });
  }
}
