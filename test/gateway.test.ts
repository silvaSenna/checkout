import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MercadoPagoGateway,
  type MercadoPagoConfig,
} from '../src/infrastructure/mercado-pago/gateway.js';
import { samplePayment } from './fixtures.js';

const config: MercadoPagoConfig = {
  accessToken: 'test-token',
  webhookUrl: 'https://example.com/api/webhooks/mercado-pago',
  returnUrl: 'https://example.com/return',
  collectorId: '900',
  sandbox: true,
  timeoutMs: 100,
};
const payment = samplePayment();
const remote = {
  id: 123,
  external_reference: payment.id,
  transaction_amount: 150.9,
  currency_id: 'BRL',
  payment_type_id: 'credit_card',
  status: 'approved',
  date_last_updated: '2026-09-02T00:00:00.000-03:00',
  collector_id: 900,
  live_mode: false,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Contrato HTTP Mercado Pago', () => {
  it('cria preferência BRL correlacionada, exclui outros tipos e escolhe sandbox', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const http: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return requests.length === 1
        ? json([
            { payment_type_id: 'credit_card' },
            { payment_type_id: 'bank_transfer' },
            { payment_type_id: 'ticket' },
            { payment_type_id: 'account_money' },
          ])
        : json({
            id: 'pref-1',
            init_point: 'https://www.mercadopago.com.br/checkout',
            sandbox_init_point: 'https://sandbox.mercadopago.com.br/checkout',
          });
    };
    const result = await new MercadoPagoGateway(config, http).createPreference(payment);
    assert.equal(result.checkoutUrl, 'https://sandbox.mercadopago.com.br/checkout');
    assert.equal(requests[1]!.url, 'https://api.mercadopago.com/checkout/preferences');
    assert.equal(requests[1]!.init!.redirect, 'error');
    assert.equal(
      (requests[1]!.init!.headers as Record<string, string>).Authorization,
      'Bearer test-token',
    );
    const body = JSON.parse(String(requests[1]!.init!.body)) as Record<string, unknown>;
    assert.equal(body.external_reference, payment.id);
    assert.deepEqual(body.items, [
      {
        id: payment.id,
        title: payment.description,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: 150.9,
      },
    ]);
    assert.deepEqual(body.payment_methods, {
      excluded_payment_types: [{ id: 'bank_transfer' }, { id: 'ticket' }],
      installments: 1,
    });
    assert.equal(body.notification_url, config.webhookUrl);
  });
  it('consulta pagamento por ID e converte resposta', async () => {
    const http: typeof fetch = async (url) => {
      assert.equal(String(url), 'https://api.mercadopago.com/v1/payments/123');
      return json(remote);
    };
    const result = await new MercadoPagoGateway(config, http).getPayment('123');
    assert.equal(result.amountCents, 15090);
    assert.equal(result.externalReference, payment.id);
    assert.equal(result.updatedAt, '2026-09-02T03:00:00.000Z');
  });
  for (const [status, retryable] of [
    [400, false],
    [401, false],
    [403, false],
    [404, true],
    [429, true],
    [500, true],
    [503, true],
  ] as const) {
    it(`classifica HTTP ${status} como retryable=${retryable}`, async () => {
      await assert.rejects(
        new MercadoPagoGateway(config, async () =>
          json({ secret: 'never-log' }, status),
        ).getPayment('123'),
        { code: `MP_HTTP_${status}`, retryable },
      );
    });
  }
  for (const override of [{ id: 456 }, { collector_id: 999 }, { live_mode: true }]) {
    it(`recusa pagamento com ${Object.keys(override)[0]} divergente`, async () => {
      await assert.rejects(
        new MercadoPagoGateway(config, async () => json({ ...remote, ...override })).getPayment(
          '123',
        ),
        { code: 'MP_PAYMENT_OWNERSHIP_MISMATCH' },
      );
    });
  }
  it('rejeita valor com fração de centavo e JSON inesperado', async () => {
    await assert.rejects(
      new MercadoPagoGateway(config, async () =>
        json({ ...remote, transaction_amount: 1.001 }),
      ).getPayment('123'),
      { code: 'MP_INVALID_AMOUNT' },
    );
    await assert.rejects(new MercadoPagoGateway(config, async () => json({})).getPayment('123'), {
      code: 'MP_INVALID_PAYMENT',
    });
  });
  it('classifica timeout de rede sem expor a mensagem', async () => {
    await assert.rejects(
      new MercadoPagoGateway(config, async () => {
        throw new Error('token-secret');
      }).getPayment('123'),
      { message: 'MP_NETWORK_OR_RESPONSE_ERROR', retryable: true },
    );
  });
  it('não aceita checkout inseguro ou resposta de sandbox incompleta', async () => {
    const gateway = new MercadoPagoGateway(config, async (url) =>
      String(url).endsWith('/payment_methods')
        ? json([{ payment_type_id: 'credit_card' }])
        : json({
            id: 'p',
            init_point: 'https://example.com',
            sandbox_init_point: 'http://example.com',
          }),
    );
    await assert.rejects(gateway.createPreference(payment), { code: 'MP_INVALID_CHECKOUT_URL' });
  });
});
