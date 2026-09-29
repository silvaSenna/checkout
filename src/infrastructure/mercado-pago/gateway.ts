import { z } from 'zod';
import type { PaymentGateway } from '../../application/ports.js';
import { ProviderError } from '../../domain/errors.js';
import { toCents, type Payment, type ProviderPayment } from '../../domain/payment.js';

const remoteId = z
  .union([z.string().min(1), z.number().int().safe().nonnegative()])
  .transform(String);
const preferenceSchema = z.object({
  id: z.string().min(1),
  init_point: z.url(),
  sandbox_init_point: z.url().optional(),
});
const paymentSchema = z.object({
  id: remoteId,
  external_reference: z.uuid(),
  transaction_amount: z.union([z.string(), z.number()]),
  currency_id: z.string(),
  payment_type_id: z.string(),
  status: z.string(),
  date_last_updated: z.iso.datetime({ offset: true }),
  collector_id: remoteId,
  live_mode: z.boolean(),
});
const methodsSchema = z.array(z.object({ payment_type_id: z.string() })).min(1);

export interface MercadoPagoConfig {
  accessToken: string;
  webhookUrl: string;
  returnUrl: string;
  collectorId: string;
  sandbox: boolean;
  timeoutMs: number;
}

/** API host is deliberately fixed: credentials must never be sent to a caller-controlled URL. */
export class MercadoPagoGateway implements PaymentGateway {
  constructor(
    private readonly config: MercadoPagoConfig,
    private readonly http: typeof fetch = fetch,
  ) {}

  private async request(path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await this.http(`https://api.mercadopago.com${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(
          `MP_HTTP_${response.status}`,
          response.status === 429 || response.status >= 500 || response.status === 404,
        );
      }
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('MP_NETWORK_OR_RESPONSE_ERROR', true);
    }
  }

  async createPreference(payment: Payment) {
    const methods = methodsSchema.safeParse(await this.request('/v1/payment_methods'));
    if (!methods.success) throw new ProviderError('MP_INVALID_METHODS', false);
    // Checkout Pro does not permit excluding account balance; reconciliation rejects non-card payments.
    const excluded = [...new Set(methods.data.map((m) => m.payment_type_id))].filter(
      (type) => type !== 'credit_card' && type !== 'account_money',
    );
    const parsed = preferenceSchema.safeParse(
      await this.request('/checkout/preferences', {
        external_reference: payment.id,
        items: [
          {
            id: payment.id,
            title: payment.description,
            quantity: 1,
            currency_id: 'BRL',
            unit_price: payment.amountCents / 100,
          },
        ],
        payer: { identification: { type: 'CPF', number: payment.cpf } },
        payment_methods: {
          excluded_payment_types: excluded.map((id) => ({ id })),
          installments: 1,
        },
        notification_url: this.config.webhookUrl,
        back_urls: {
          success: this.config.returnUrl,
          failure: this.config.returnUrl,
          pending: this.config.returnUrl,
        },
        auto_return: 'approved',
      }),
    );
    if (!parsed.success) throw new ProviderError('MP_INVALID_PREFERENCE', false);
    const checkoutUrl = this.config.sandbox
      ? parsed.data.sandbox_init_point
      : parsed.data.init_point;
    if (!checkoutUrl || new URL(checkoutUrl).protocol !== 'https:') {
      throw new ProviderError('MP_INVALID_CHECKOUT_URL', false);
    }
    return { id: parsed.data.id, checkoutUrl };
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    const parsed = paymentSchema.safeParse(
      await this.request(`/v1/payments/${encodeURIComponent(id)}`),
    );
    if (!parsed.success) throw new ProviderError('MP_INVALID_PAYMENT', false);
    const remote = parsed.data;
    if (
      remote.id !== id ||
      remote.collector_id !== this.config.collectorId ||
      remote.live_mode === this.config.sandbox
    ) {
      throw new ProviderError('MP_PAYMENT_OWNERSHIP_MISMATCH', false);
    }
    let amountCents: number;
    try {
      amountCents = toCents(remote.transaction_amount);
    } catch {
      throw new ProviderError('MP_INVALID_AMOUNT', false);
    }
    return {
      id: remote.id,
      externalReference: remote.external_reference,
      amountCents,
      currency: remote.currency_id,
      paymentType: remote.payment_type_id,
      status: remote.status,
      updatedAt: new Date(remote.date_last_updated).toISOString(),
    };
  }
}
