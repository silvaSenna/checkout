import { randomUUID } from 'node:crypto';
import type { Payment, ProviderPayment } from '../src/domain/payment.js';
import type { PaymentFilter, PaymentRepository } from '../src/application/ports.js';
import { AppError } from '../src/domain/errors.js';

export function samplePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    id: randomUUID(),
    cpf: '52998224725',
    description: 'Assinatura',
    amountCents: 15090,
    paymentMethod: 'CREDIT_CARD',
    status: 'PENDING',
    checkoutStatus: 'PROCESSING',
    preferenceId: null,
    checkoutUrl: null,
    providerPaymentId: null,
    providerUpdatedAt: null,
    version: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}
export function sampleRemote(
  payment: Payment,
  overrides: Partial<ProviderPayment> = {},
): ProviderPayment {
  return {
    id: '123456',
    externalReference: payment.id,
    amountCents: payment.amountCents,
    currency: 'BRL',
    paymentType: 'credit_card',
    status: 'approved',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}
export class MemoryRepository implements PaymentRepository {
  readonly rows = new Map<string, Payment>();
  private readonly keys = new Map<string, { id: string; fingerprint: string }>();
  async create(payment: Payment, key: string, fingerprint: string) {
    const existing = this.keys.get(key);
    if (existing) {
      if (fingerprint !== existing.fingerprint)
        throw new AppError('IDEMPOTENCY_CONFLICT', 'Conflict', 409);
      return { payment: this.rows.get(existing.id)!, created: false };
    }
    this.keys.set(key, { id: payment.id, fingerprint });
    this.rows.set(payment.id, payment);
    return { payment, created: true };
  }
  async find(id: string) {
    return this.rows.get(id) ?? null;
  }
  async list(filter: PaymentFilter) {
    return [...this.rows.values()]
      .filter(
        (p) =>
          (!filter.cpf || p.cpf === filter.cpf) &&
          (!filter.paymentMethod || p.paymentMethod === filter.paymentMethod) &&
          (!filter.status || p.status === filter.status) &&
          (!filter.after || p.id > filter.after),
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, filter.limit);
  }
  async save(payment: Payment, version: number) {
    if (this.rows.get(payment.id)?.version !== version)
      throw new AppError('VERSION_CONFLICT', 'Conflict', 412);
    const updated = { ...payment, version: version + 1, updatedAt: new Date().toISOString() };
    this.rows.set(payment.id, updated);
    return updated;
  }
}
