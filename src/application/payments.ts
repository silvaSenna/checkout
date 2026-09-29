import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import {
  describe,
  normalizeCpf,
  toCents,
  updatePayment,
  type Payment,
  type PaymentMethod,
  type PaymentStatus,
} from '../domain/payment.js';
import type { PaymentFilter, PaymentRepository } from './ports.js';

export class Payments {
  constructor(private readonly repository: PaymentRepository) {}

  async create(
    input: {
      cpf: string;
      description: string;
      amount: string | number;
      paymentMethod: PaymentMethod;
    },
    key: string,
  ) {
    const normalized = {
      cpf: normalizeCpf(input.cpf),
      description: describe(input.description),
      amountCents: toCents(input.amount),
      paymentMethod: input.paymentMethod,
    };
    const now = new Date().toISOString();
    const payment: Payment = {
      ...normalized,
      id: randomUUID(),
      status: 'PENDING',
      checkoutStatus: input.paymentMethod === 'PIX' ? 'NOT_REQUIRED' : 'PROCESSING',
      preferenceId: null,
      checkoutUrl: null,
      providerPaymentId: null,
      providerUpdatedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    return this.repository.create(payment, key, fingerprint);
  }

  async get(id: string): Promise<Payment> {
    const payment = await this.repository.find(id);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Pagamento não encontrado.', 404);
    return payment;
  }

  async list(filter: PaymentFilter) {
    const rows = await this.repository.list({
      ...filter,
      cpf: filter.cpf === undefined ? undefined : normalizeCpf(filter.cpf),
      limit: filter.limit + 1,
    });
    const hasMore = rows.length > filter.limit;
    const data = rows.slice(0, filter.limit);
    return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null };
  }

  async update(
    id: string,
    expectedVersion: number,
    input: { description?: string; status?: PaymentStatus },
  ) {
    const payment = await this.get(id);
    if (payment.version !== expectedVersion) {
      throw new AppError('VERSION_CONFLICT', 'Pagamento alterado. Releia antes de atualizar.', 412);
    }
    return this.repository.save(updatePayment(payment, input), expectedVersion, 'API');
  }
}

export function present(payment: Payment) {
  const { amountCents, ...rest } = payment;
  return { ...rest, amount: (amountCents / 100).toFixed(2), currency: 'BRL' };
}
