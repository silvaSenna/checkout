import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  describe as description,
  normalizeCpf,
  reconcilePayment,
  toCents,
  updatePayment,
} from '../src/domain/payment.js';
import { samplePayment, sampleRemote } from './fixtures.js';

describe('CPF', () => {
  it('normaliza máscara e valida dígitos verificadores', () => {
    assert.equal(normalizeCpf('529.982.247-25'), '52998224725');
    assert.equal(normalizeCpf('11144477735'), '11144477735');
  });
  for (const value of [
    '11111111111',
    '00000000000',
    '52998224726',
    '52998224715',
    '5299822472',
    'abc52998224725',
    '529-982-247.25',
  ]) {
    it(`rejeita CPF inválido: ${value}`, () =>
      assert.throws(() => normalizeCpf(value), { code: 'INVALID_CPF' }));
  }
});
describe('Dinheiro e descrição', () => {
  for (const [input, expected] of [
    ['0.29', 29],
    [0.29, 29],
    ['150.90', 15090],
    ['999999.99', 99999999],
    [1, 100],
  ] as const) {
    it(`converte ${input} sem erro de arredondamento`, () =>
      assert.equal(toCents(input), expected));
  }
  for (const value of [
    0,
    -1,
    0.001,
    0.1 + 0.2,
    '10,00',
    '1e2',
    'NaN',
    Infinity,
    1000000,
    ' 1',
    '',
    '10.999',
  ]) {
    it(`rejeita valor inválido: ${value}`, () =>
      assert.throws(() => toCents(value), { code: 'INVALID_AMOUNT' }));
  }
  it('normaliza espaços sem aceitar descrição vazia ou excessiva', () => {
    assert.equal(description(' Cobrança '), 'Cobrança');
    assert.throws(() => description('   '));
    assert.throws(() => description('x'.repeat(256)));
  });
});
describe('Transições da cobrança', () => {
  it('permite concluir PIX e repetir o mesmo status', () => {
    const p = samplePayment({ paymentMethod: 'PIX', checkoutStatus: 'NOT_REQUIRED' });
    const paid = updatePayment(p, { status: 'PAID', description: 'Nova descrição' });
    assert.equal(paid.status, 'PAID');
    assert.equal(p.status, 'PENDING');
    assert.equal(updatePayment(paid, { status: 'PAID' }).status, 'PAID');
    assert.throws(() => updatePayment(paid, { status: 'FAIL' }), { code: 'INVALID_TRANSITION' });
    assert.throws(() => updatePayment(paid, { description: 'Outra' }), {
      code: 'PAYMENT_IMMUTABLE',
    });
  });
  it('bloqueia status manual e edição de cartão', () => {
    assert.throws(() => updatePayment(samplePayment(), { status: 'PAID' }), {
      code: 'PROVIDER_MANAGED_STATUS',
    });
    assert.throws(() => updatePayment(samplePayment(), { description: 'Alterado' }), {
      code: 'PAYMENT_IMMUTABLE',
    });
  });
  it('concilia aprovação e aceita nova tentativa depois de rejeição', () => {
    const p = samplePayment();
    const failed = reconcilePayment(p, sampleRemote(p, { status: 'rejected' }));
    assert.equal(failed.status, 'FAIL');
    assert.equal(reconcilePayment(failed, sampleRemote(p, { id: '789' })).status, 'PAID');
  });
  for (const status of ['pending', 'in_process', 'authorized', 'in_mediation']) {
    it(`${status} continua pendente`, () => {
      const p = samplePayment();
      assert.equal(reconcilePayment(p, sampleRemote(p, { status })).status, 'PENDING');
    });
  }
  for (const override of [
    { amountCents: 1 },
    { currency: 'USD' },
    { paymentType: 'account_money' },
    { externalReference: 'wrong' },
  ]) {
    it(`rejeita divergência ${Object.keys(override)[0]}`, () => {
      const p = samplePayment();
      assert.throws(() => reconcilePayment(p, sampleRemote(p, override)), {
        code: 'PROVIDER_PAYMENT_MISMATCH',
      });
    });
  }
  it('não aceita cartão como liquidação de PIX', () => {
    const p = samplePayment({ paymentMethod: 'PIX' });
    assert.throws(() => reconcilePayment(p, sampleRemote(p)));
  });
  it('ignora callback antigo ou duplicado do mesmo pagamento', () => {
    const p = samplePayment();
    const remote = sampleRemote(p);
    const paid = reconcilePayment(p, remote);
    assert.equal(reconcilePayment(paid, remote), paid);
    assert.equal(
      reconcilePayment(paid, { ...remote, status: 'rejected', updatedAt: p.createdAt }),
      paid,
    );
  });
  it('aprovação não regride; segunda aprovação gera revisão', () => {
    const p = samplePayment();
    const paid = reconcilePayment(p, sampleRemote(p));
    assert.equal(reconcilePayment(paid, sampleRemote(p, { id: '999', status: 'rejected' })), paid);
    assert.throws(() => reconcilePayment(paid, sampleRemote(p, { id: '999' })), {
      code: 'DUPLICATE_APPROVAL',
    });
  });
  for (const status of ['refunded', 'charged_back', 'unknown', 'constructor']) {
    it(`exige revisão para ${status}`, () => {
      const p = samplePayment();
      assert.throws(() => reconcilePayment(p, sampleRemote(p, { status })), {
        code: 'UNSUPPORTED_PROVIDER_STATUS',
      });
    });
  }
});
