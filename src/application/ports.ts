import type { Payment, PaymentMethod, PaymentStatus, ProviderPayment } from '../domain/payment.js';

export interface PaymentFilter {
  cpf?: string;
  paymentMethod?: PaymentMethod;
  status?: PaymentStatus;
  limit: number;
  after?: string;
}
export interface PaymentRepository {
  create(
    payment: Payment,
    key: string,
    fingerprint: string,
  ): Promise<{ payment: Payment; created: boolean }>;
  find(id: string): Promise<Payment | null>;
  list(filter: PaymentFilter): Promise<Payment[]>;
  save(payment: Payment, expectedVersion: number, actor: string): Promise<Payment>;
}
export interface PaymentGateway {
  createPreference(payment: Payment): Promise<{ id: string; checkoutUrl: string }>;
  getPayment(id: string): Promise<ProviderPayment>;
}
export interface Job {
  id: string;
  kind: 'CREATE_PREFERENCE' | 'SYNC_PAYMENT';
  payload: { paymentId?: string; providerPaymentId?: string };
  attempts: number;
  leaseToken: string;
}
export interface JobQueue {
  enqueueWebhook(providerPaymentId: string, deliveryKey: string): Promise<void>;
  claim(): Promise<Job | null>;
  complete(job: Job): Promise<void>;
  fail(job: Job, code: string, retryable: boolean): Promise<void>;
}

export interface JobProcessor {
  execute(job: Job): Promise<void>;
}
