import 'reflect-metadata';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createHmac, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createPool } from '../../src/infrastructure/database/database.js';
import { migrate } from '../../src/infrastructure/database/migrate.js';
import { PgPaymentRepository } from '../../src/infrastructure/database/payment-repository.js';
import { PgJobQueue } from '../../src/infrastructure/jobs/pg-job-queue.js';
import { Payments } from '../../src/application/payments.js';
import { ProcessJob } from '../../src/application/process-job.js';
import { createApp } from '../../src/http/app.js';
import { readConfig } from '../../src/config.js';
import type { Job, PaymentGateway } from '../../src/application/ports.js';
import { samplePayment, sampleRemote } from '../fixtures.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error('Use npm run test:integration; testes não são ignorados silenciosamente.');
const schemaName = `test_${randomUUID().replaceAll('-', '')}`;
const apiKey = 'integration-api-key-with-at-least-32-characters';
const secret = 'integration-webhook-secret';
const input = {
  cpf: '52998224725',
  description: 'Cobrança de teste',
  amount: '150.90',
  paymentMethod: 'PIX' as const,
};
let admin: Pool;
let pool: Pool;
let repository: PgPaymentRepository;
let jobs: PgJobQueue;
let payments: Payments;
let app: INestApplication;

before(async () => {
  admin = createPool(databaseUrl);
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  const isolated = new URL(databaseUrl);
  isolated.searchParams.set('options', `-c search_path=${schemaName}`);
  pool = createPool(isolated.toString());
  await migrate(pool);
  repository = new PgPaymentRepository(pool);
  jobs = new PgJobQueue(pool);
  payments = new Payments(repository);
  const config = readConfig({
    DATABASE_URL: isolated.toString(),
    API_KEY: apiKey,
    NODE_ENV: 'test',
    MP_ACCESS_TOKEN: 'test-token',
    MP_WEBHOOK_SECRET: secret,
    MP_COLLECTOR_ID: '900',
    MP_WEBHOOK_URL: 'https://example.com/api/webhooks/mercado-pago',
    MP_RETURN_URL: 'https://example.com/return',
  });
  app = await createApp(
    {
      config,
      payments,
      jobs,
      checkDatabase: async () => {
        await pool.query('SELECT 1');
      },
    },
    true,
  );
  await app.init();
});
after(async () => {
  await app?.close();
  await pool?.end();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin.end();
  }
});
beforeEach(async () => {
  await pool.query('TRUNCATE payment_events, jobs, idempotency_keys, payments RESTART IDENTITY');
});

function http() {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}
function signedWebhook(id: string, requestId = randomUUID()) {
  const ts = String(Date.now());
  const hash = createHmac('sha256', secret)
    .update(`id:${id};request-id:${requestId};ts:${ts};`)
    .digest('hex');
  return http()
    .post(`/api/webhooks/mercado-pago?data.id=${id}&type=payment`)
    .set('x-request-id', requestId)
    .set('x-signature', `ts=${ts},v1=${hash}`);
}

describe('PostgreSQL real: transações e concorrência', () => {
  it('aplica migrations repetidamente sem duplicar', async () => {
    await migrate(pool);
    assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, 1);
  });
  it('cria um único pagamento sob 12 requisições concorrentes com mesma chave', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        payments.create({ ...input, paymentMethod: 'CREDIT_CARD' }, 'concurrent-key'),
      ),
    );
    assert.equal(new Set(results.map((r) => r.payment.id)).size, 1);
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal((await pool.query('SELECT * FROM payments')).rowCount, 1);
    assert.equal((await pool.query('SELECT * FROM jobs')).rowCount, 1);
    assert.equal((await pool.query('SELECT * FROM payment_events')).rowCount, 1);
    await assert.rejects(payments.create({ ...input, amount: 1 }, 'concurrent-key'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('rollback da outbox também desfaz pagamento e idempotência', async () => {
    const p = samplePayment();
    await pool.query(
      "INSERT INTO jobs(id, kind, dedup_key, payload) VALUES ($1, 'CREATE_PREFERENCE', $2, '{}')",
      [randomUUID(), `preference:${p.id}`],
    );
    await assert.rejects(repository.create(p, 'rollback-key', 'f'.repeat(64)));
    assert.equal(await repository.find(p.id), null);
    assert.equal((await pool.query('SELECT * FROM idempotency_keys')).rowCount, 0);
    assert.equal((await pool.query('SELECT * FROM payment_events')).rowCount, 0);
  });
  it('CAS admite só uma atualização concorrente e mantém auditoria', async () => {
    const { payment } = await payments.create(input, 'update-key');
    const results = await Promise.allSettled([
      repository.save({ ...payment, status: 'PAID' }, 1, 'API'),
      repository.save({ ...payment, status: 'FAIL' }, 1, 'API'),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await repository.find(payment.id))!.version, 2);
    assert.equal((await pool.query('SELECT * FROM payment_events')).rowCount, 2);
  });
  it('workers concorrentes não recebem o mesmo job; lease expirada é retomada', async () => {
    await payments.create({ ...input, paymentMethod: 'CREDIT_CARD' }, 'worker-key');
    const claimed = await Promise.all([jobs.claim(), jobs.claim(), jobs.claim()]);
    assert.equal(claimed.filter(Boolean).length, 1);
    const old = claimed.find(Boolean)!;
    await pool.query("UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1", [
      old.id,
    ]);
    const renewed = (await jobs.claim())!;
    assert.equal(renewed.id, old.id);
    assert.notEqual(renewed.leaseToken, old.leaseToken);
    await jobs.complete(old); // stale owner must not acknowledge a renewed lease
    assert.equal((await pool.query('SELECT status FROM jobs')).rows[0].status, 'RUNNING');
    await jobs.complete(renewed);
    assert.equal((await pool.query('SELECT status FROM jobs')).rows[0].status, 'DONE');
  });
  it('backoff, dead letter e sinalização de checkout sem fingir rejeição financeira', async () => {
    const { payment } = await payments.create(
      { ...input, paymentMethod: 'CREDIT_CARD' },
      'failure-key',
    );
    const job = (await jobs.claim())!;
    await jobs.fail(job, 'MP_HTTP_503', true);
    assert.equal(await jobs.claim(), null);
    await pool.query('UPDATE jobs SET available_at = now(), attempts = 7 WHERE id = $1', [job.id]);
    const retry = (await jobs.claim())!;
    await jobs.fail(retry, 'MP_HTTP_503', true);
    assert.equal((await pool.query('SELECT status FROM jobs')).rows[0].status, 'DEAD');
    const current = (await repository.find(payment.id))!;
    assert.equal(current.status, 'PENDING');
    assert.equal(current.checkoutStatus, 'REQUIRES_REVIEW');
    assert.equal((await pool.query('SELECT * FROM payment_events')).rowCount, 2);
  });
  it('filtra e pagina sem repetir registros', async () => {
    for (let i = 0; i < 5; i++) await payments.create(input, `list-key-${i}`);
    await payments.create(
      { ...input, cpf: '11144477735', paymentMethod: 'CREDIT_CARD' },
      'other-key',
    );
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await payments.list({ cpf: input.cpf, paymentMethod: 'PIX', limit: 2, after });
      ids.push(...page.data.map((p) => p.id));
      after = page.nextCursor ?? undefined;
    } while (after);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5);
  });
});

describe('API HTTP completa', () => {
  it('cria, lê, atualiza e lista PIX com ETags e autenticação', async () => {
    const created = await http()
      .post('/api/payment')
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', 'http-create-key')
      .send(input)
      .expect(201);
    assert.equal(created.body.status, 'PENDING');
    assert.equal(created.body.amount, '150.90');
    assert.equal(created.headers.etag, '"1"');
    assert.ok(created.headers['x-request-id']);
    assert.equal((await pool.query('SELECT * FROM jobs')).rowCount, 0);
    const path = created.headers.location as string;
    await http().get(path).expect(401);
    await http().get(path).set('x-api-key', apiKey).expect(200);
    await http().put(path).set('x-api-key', apiKey).send({ status: 'PAID' }).expect(428);
    const updated = await http()
      .put(path)
      .set('x-api-key', apiKey)
      .set('If-Match', '"1"')
      .send({ status: 'PAID' })
      .expect(200);
    assert.equal(updated.body.status, 'PAID');
    assert.equal(updated.headers.etag, '"2"');
    await http()
      .put(path)
      .set('x-api-key', apiKey)
      .set('If-Match', '"1"')
      .send({ status: 'FAIL' })
      .expect(412);
    const list = await http()
      .get('/api/payment?cpf=529.982.247-25&paymentMethod=PIX&status=PAID')
      .set('x-api-key', apiKey)
      .expect(200);
    assert.equal(list.body.data.length, 1);
    const replay = await http()
      .post('/api/payment')
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', 'http-create-key')
      .send(input)
      .expect(200);
    assert.equal(replay.body.id, created.body.id);
    assert.equal(replay.body.status, 'PAID');
  });
  it('valida entradas, JSON malformado, IDs, CPF, dinheiro e campos desconhecidos', async () => {
    for (const body of [
      { ...input, cpf: '11111111111' },
      { ...input, amount: 0 },
      { ...input, amount: 1.001 },
      { ...input, status: 'PAID' },
      { ...input, description: ' ' },
    ]) {
      await http()
        .post('/api/payment')
        .set('x-api-key', apiKey)
        .set('Idempotency-Key', randomUUID())
        .send(body)
        .expect(400);
    }
    await http()
      .post('/api/payment')
      .set('x-api-key', apiKey)
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    await http()
      .post('/api/payment')
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', randomUUID())
      .send({ ...input, description: 'x'.repeat(20_000) })
      .expect(413);
    await http().get('/api/payment/not-a-uuid').set('x-api-key', apiKey).expect(400);
    await http().get(`/api/payment/${randomUUID()}`).set('x-api-key', apiKey).expect(404);
    await http().get('/api/payment?limit=101').set('x-api-key', apiKey).expect(400);
  });
  it('cartão: cria preferência, recebe callback durável, consulta provedor e liquida', async () => {
    const created = await http()
      .post('/api/payment')
      .set('x-api-key', apiKey)
      .set('Idempotency-Key', 'card-http-key')
      .send({ ...input, paymentMethod: 'CREDIT_CARD' })
      .expect(201);
    const p = (await repository.find(created.body.id as string))!;
    let queries = 0;
    const gateway: PaymentGateway = {
      createPreference: async () => ({
        id: 'preference-1',
        checkoutUrl: 'https://sandbox.mercadopago.com.br/checkout',
      }),
      getPayment: async (id) => {
        queries++;
        assert.equal(id, '123456');
        return sampleRemote(p);
      },
    };
    const processor = new ProcessJob(repository, gateway);
    const creation = (await jobs.claim())!;
    await processor.execute(creation);
    await jobs.complete(creation);
    assert.equal((await repository.find(p.id))!.checkoutStatus, 'READY');
    const deliveryId = randomUUID();
    await signedWebhook('123456', deliveryId)
      .send({ type: 'payment', data: { id: '123456' }, status: 'approved' })
      .expect(200);
    await signedWebhook('123456', deliveryId)
      .send({ type: 'payment', data: { id: '123456' } })
      .expect(200);
    assert.equal((await repository.find(p.id))!.status, 'PENDING'); // only inbox persisted
    assert.equal((await pool.query("SELECT * FROM jobs WHERE kind = 'SYNC_PAYMENT'")).rowCount, 1);
    const sync = (await jobs.claim()) as Job;
    await processor.execute(sync);
    await jobs.complete(sync);
    assert.equal(queries, 1);
    assert.equal((await repository.find(p.id))!.status, 'PAID');
    await http()
      .put(`/api/payment/${p.id}`)
      .set('x-api-key', apiKey)
      .set('If-Match', '"3"')
      .send({ status: 'FAIL' })
      .expect(409);
  });
  it('recusa assinatura inválida e divergência entre corpo e query sem enfileirar', async () => {
    await http()
      .post('/api/webhooks/mercado-pago?data.id=123&type=payment')
      .send({ type: 'payment', data: { id: '123' } })
      .expect(401);
    await signedWebhook('123')
      .send({ type: 'payment', data: { id: '999' } })
      .expect(400);
    assert.equal((await pool.query('SELECT * FROM jobs')).rowCount, 0);
  });
  it('exibe health, Swagger e contrato OpenAPI', async () => {
    await http().get('/health/live').expect(200);
    await http().get('/health/ready').expect(200);
    await http().get('/docs/').expect(200);
    const document = await http().get('/openapi.json').expect(200);
    assert.ok(document.body.paths['/api/payment'].post);
    assert.ok(document.body.paths['/api/payment/{id}'].put);
    assert.ok(document.body.paths['/api/webhooks/mercado-pago'].post);
  });
});

describe('Defesas de integridade', () => {
  it('constraints do banco rejeitam centavos inválidos mesmo fora da borda HTTP', async () => {
    const payment = samplePayment({ amountCents: -1 });
    await assert.rejects(repository.create(payment, 'invalid-db-amount', 'f'.repeat(64)));
    assert.equal((await pool.query('SELECT * FROM payments')).rowCount, 0);
  });

  it('divergência financeira vai para DEAD e preserva cobrança pendente', async () => {
    const { payment } = await payments.create(
      { ...input, paymentMethod: 'CREDIT_CARD' },
      'mismatch-key',
    );
    const preferenceJob = (await jobs.claim())!;
    await jobs.complete(preferenceJob);
    await jobs.enqueueWebhook('123456', 'mismatch-delivery');
    const gateway: PaymentGateway = {
      createPreference: async () => assert.fail('Não deve criar preferência'),
      getPayment: async () => sampleRemote(payment, { amountCents: 1 }),
    };
    const { JobRunner } = await import('../../src/infrastructure/jobs/runner.js');
    await new JobRunner(jobs, new ProcessJob(repository, gateway), () => {}).runOnce();
    const job = (
      await pool.query("SELECT status, last_error_code FROM jobs WHERE kind = 'SYNC_PAYMENT'")
    ).rows[0];
    assert.equal(job.status, 'DEAD');
    assert.equal(job.last_error_code, 'PROVIDER_PAYMENT_MISMATCH');
    assert.equal((await repository.find(payment.id))!.status, 'PENDING');
  });

  it('callback não recebe 200 se a inbox não conseguiu persistir', async () => {
    const enqueue = jobs.enqueueWebhook.bind(jobs);
    jobs.enqueueWebhook = async () => {
      throw new Error('simulated-database-outage');
    };
    try {
      const response = await signedWebhook('123')
        .send({ type: 'payment', data: { id: '123' } })
        .expect(500);
      assert.equal(response.body.code, 'INTERNAL_ERROR');
      assert.equal(JSON.stringify(response.body).includes('simulated-database-outage'), false);
      assert.equal((await pool.query('SELECT * FROM jobs')).rowCount, 0);
    } finally {
      jobs.enqueueWebhook = enqueue;
    }
  });
});
