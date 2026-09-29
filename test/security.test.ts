import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhook } from '../src/infrastructure/mercado-pago/webhook-signature.js';
import { readConfig } from '../src/config.js';
import {
  createSchema,
  filterSchema,
  parse,
  updateSchema,
  versionSchema,
} from '../src/http/schemas.js';

const secret = 'webhook-secret-for-tests';
const now = Date.now();
function signature(ts: string, dataId = '123') {
  return `ts=${ts},v1=${createHmac('sha256', secret).update(`id:${dataId};request-id:req-1;ts:${ts};`).digest('hex')}`;
}
describe('Assinatura de webhook', () => {
  for (const ts of [String(now), String(Math.floor(now / 1000))]) {
    it(`valida timestamp ${ts.length === 13 ? 'milissegundos' : 'segundos'}`, () => {
      verifyWebhook({ signature: signature(ts), requestId: 'req-1', dataId: '123', secret, now });
    });
  }
  for (const overrides of [
    { signature: '' },
    { signature: `ts=${now},v1=xyz` },
    { requestId: 'tampered' },
    { dataId: '456' },
    { secret: 'wrong' },
    { now: now + 301000 },
    { now: now - 301000 },
    { signature: `${signature(String(now))},ts=${now}` },
    { requestId: 'req-1;ts:123;' },
  ]) {
    it(`rejeita adulteração/replay: ${JSON.stringify(overrides)}`, () =>
      assert.throws(
        () =>
          verifyWebhook({
            signature: signature(String(now)),
            requestId: 'req-1',
            dataId: '123',
            secret,
            now,
            ...overrides,
          }),
        { code: 'INVALID_WEBHOOK_SIGNATURE' },
      ));
  }
});
describe('Validação de fronteira', () => {
  it('recusa mass assignment, enums inválidos e atualização vazia', () => {
    const valid = {
      cpf: '52998224725',
      description: 'Teste',
      amount: '1.00',
      paymentMethod: 'PIX',
    };
    assert.throws(() => parse(createSchema, { ...valid, status: 'PAID' }));
    assert.throws(() => parse(createSchema, { ...valid, paymentMethod: 'BOLETO' }));
    assert.throws(() => parse(updateSchema, {}));
    assert.throws(() => parse(updateSchema, { amount: 10 }));
  });
  it('limita paginação e exige ETag forte numérico', () => {
    assert.equal(parse(filterSchema, {}).limit, 20);
    for (const limit of ['101', '-1', '0', '1.5', '1e2', ['2', '3']])
      assert.throws(() => parse(filterSchema, { limit }));
    for (const value of ['1', 'W/"1"', '"0"', '*'])
      assert.throws(() => parse(versionSchema, value));
    assert.equal(parse(versionSchema, '"12"'), 12);
  });
  it('configura PIX sem credenciais e rejeita configuração parcial/segredos fracos', () => {
    const env = { DATABASE_URL: 'postgres://test:test@localhost/test', API_KEY: 'a'.repeat(32) };
    assert.equal(readConfig(env).MP_ACCESS_TOKEN, undefined);
    assert.throws(() => readConfig({ ...env, API_KEY: 'short' }));
    assert.throws(() => readConfig({ ...env, MP_ACCESS_TOKEN: 'secret' }));
    assert.throws(() => readConfig({ ...env, MP_WEBHOOK_URL: 'http://localhost' }));
  });
});
