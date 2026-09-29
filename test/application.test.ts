import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Payments, present } from '../src/application/payments.js';
import { ProcessJob } from '../src/application/process-job.js';
import { JobRunner } from '../src/infrastructure/jobs/runner.js';
import { ProviderError } from '../src/domain/errors.js';
import type { Job, JobQueue, PaymentGateway } from '../src/application/ports.js';
import { MemoryRepository, samplePayment, sampleRemote } from './fixtures.js';

const input = {
  cpf: '529.982.247-25',
  description: 'Cobrança',
  amount: '150.90',
  paymentMethod: 'PIX' as const,
};
describe('Casos de uso', () => {
  it('cria PIX pendente e reaproveita chave com payload normalizado', async () => {
    const service = new Payments(new MemoryRepository());
    const first = await service.create(input, 'same-key');
    const repeated = await service.create(
      { ...input, cpf: '52998224725', amount: 150.9 },
      'same-key',
    );
    assert.equal(first.created, true);
    assert.equal(repeated.created, false);
    assert.equal(first.payment.id, repeated.payment.id);
    assert.equal(first.payment.status, 'PENDING');
    assert.equal(first.payment.checkoutStatus, 'NOT_REQUIRED');
    assert.equal(present(first.payment).amount, '150.90');
    await assert.rejects(service.create({ ...input, amount: 99 }, 'same-key'), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('distingue não encontrado de versão obsoleta', async () => {
    const service = new Payments(new MemoryRepository());
    await assert.rejects(service.get(samplePayment().id), { code: 'PAYMENT_NOT_FOUND' });
    const { payment } = await service.create(input, 'new-key');
    await assert.rejects(service.update(payment.id, 2, { status: 'PAID' }), {
      code: 'VERSION_CONFLICT',
    });
    assert.equal((await service.update(payment.id, 1, { status: 'PAID' })).version, 2);
  });
  it('pagina com cursor e combina filtros', async () => {
    const repository = new MemoryRepository();
    const service = new Payments(repository);
    for (let i = 0; i < 4; i++) await service.create(input, `key-${i}`);
    await service.create({ ...input, paymentMethod: 'CREDIT_CARD' }, 'card-key');
    const first = await service.list({ cpf: input.cpf, paymentMethod: 'PIX', limit: 2 });
    const second = await service.list({ paymentMethod: 'PIX', limit: 2, after: first.nextCursor! });
    assert.equal(first.data.length, 2);
    assert.equal(second.data.length, 2);
    assert.equal(second.nextCursor, null);
    assert.equal(new Set([...first.data, ...second.data].map((p) => p.id)).size, 4);
  });
});

describe('Processamento durável', () => {
  const job: Job = {
    id: 'job-1',
    kind: 'CREATE_PREFERENCE',
    payload: {},
    attempts: 1,
    leaseToken: 'token',
  };
  it('persiste checkout e não chama provedor novamente quando já existe', async () => {
    const repository = new MemoryRepository();
    const p = samplePayment();
    repository.rows.set(p.id, p);
    let calls = 0;
    const gateway: PaymentGateway = {
      createPreference: async () => {
        calls++;
        return { id: 'pref', checkoutUrl: 'https://example.com/pay' };
      },
      getPayment: async () => sampleRemote(p),
    };
    const processor = new ProcessJob(repository, gateway);
    const task = { ...job, payload: { paymentId: p.id } };
    await processor.execute(task);
    await processor.execute(task);
    assert.equal(calls, 1);
    assert.equal((await repository.find(p.id))!.checkoutStatus, 'READY');
  });
  it('não sobrescreve liquidação recebida durante criação do checkout', async () => {
    const repository = new MemoryRepository();
    const p = samplePayment();
    repository.rows.set(p.id, p);
    const gateway: PaymentGateway = {
      createPreference: async () => {
        await repository.save({ ...p, status: 'PAID' }, 1);
        return { id: 'pref', checkoutUrl: 'https://example.com/pay' };
      },
      getPayment: async () => sampleRemote(p),
    };
    await new ProcessJob(repository, gateway).execute({ ...job, payload: { paymentId: p.id } });
    assert.equal((await repository.find(p.id))!.status, 'PAID');
  });
  it('consulta estado autoritativo e não regrava evento duplicado', async () => {
    const repository = new MemoryRepository();
    const p = samplePayment();
    repository.rows.set(p.id, p);
    const gateway: PaymentGateway = {
      createPreference: async () => {
        throw new Error('unused');
      },
      getPayment: async () => sampleRemote(p),
    };
    const processor = new ProcessJob(repository, gateway);
    const task: Job = { ...job, kind: 'SYNC_PAYMENT', payload: { providerPaymentId: '123456' } };
    await processor.execute(task);
    await processor.execute(task);
    assert.equal((await repository.find(p.id))!.status, 'PAID');
    assert.equal((await repository.find(p.id))!.version, 2);
  });
  for (const retryable of [true, false]) {
    it(`classifica falha de provedor retryable=${retryable}`, async () => {
      let received: unknown[] = [];
      const queue: JobQueue = {
        claim: async () => job,
        complete: async () => assert.fail('não deveria concluir'),
        enqueueWebhook: async () => {},
        fail: async (...args) => {
          received = args;
        },
      };
      const processor = {
        execute: async () => {
          throw new ProviderError('MP_ERROR', retryable);
        },
      };
      assert.equal(await new JobRunner(queue, processor, () => {}).runOnce(), true);
      assert.deepEqual(received, [job, 'MP_ERROR', retryable]);
    });
  }
  it('retorna idle sem executar processador', async () => {
    const queue: JobQueue = {
      claim: async () => null,
      complete: async () => {},
      fail: async () => {},
      enqueueWebhook: async () => {},
    };
    assert.equal(
      await new JobRunner(
        queue,
        { execute: async () => assert.fail('No job should execute') },
        () => {},
      ).runOnce(),
      false,
    );
  });
});

describe('Regressões de recuperação', () => {
  it('conflito de versão não repete criação remota de preferência', async () => {
    const repository = new MemoryRepository();
    const payment = samplePayment();
    repository.rows.set(payment.id, payment);
    const original = repository.save.bind(repository);
    let conflict = true;
    repository.save = async (next, version) => {
      if (conflict) {
        conflict = false;
        await original({ ...payment, status: 'PAID' }, version);
      }
      return original(next, version);
    };
    let calls = 0;
    const gateway: PaymentGateway = {
      createPreference: async () => {
        calls++;
        return { id: 'pref', checkoutUrl: 'https://example.com/pay' };
      },
      getPayment: async () => sampleRemote(payment),
    };
    await new ProcessJob(repository, gateway).execute({
      id: 'job',
      kind: 'CREATE_PREFERENCE',
      payload: { paymentId: payment.id },
      attempts: 1,
      leaseToken: 'token',
    });
    assert.equal(calls, 1);
    assert.equal((await repository.find(payment.id))!.status, 'PAID');
    assert.equal((await repository.find(payment.id))!.preferenceId, 'pref');
  });

  it('quedas sucessivas respeitam limite de tentativas antes de chamar provedor', async () => {
    const job: Job = {
      id: 'job',
      kind: 'CREATE_PREFERENCE',
      payload: {},
      attempts: 9,
      leaseToken: 'token',
    };
    let failed = false;
    const queue: JobQueue = {
      claim: async () => job,
      complete: async () => assert.fail('Não deve concluir'),
      enqueueWebhook: async () => {},
      fail: async (_job, code, retryable) => {
        failed = true;
        assert.equal(code, 'ATTEMPTS_EXHAUSTED');
        assert.equal(retryable, false);
      },
    };
    await new JobRunner(
      queue,
      { execute: async () => assert.fail('Não deve chamar provedor') },
      () => {},
    ).runOnce();
    assert.equal(failed, true);
  });
});
