import { AppError } from '../domain/errors.js';
import { reconcilePayment } from '../domain/payment.js';
import type { Job, PaymentGateway, PaymentRepository } from './ports.js';

export class ProcessJob {
  constructor(
    private readonly payments: PaymentRepository,
    private readonly gateway: PaymentGateway,
  ) {}

  async execute(job: Job): Promise<void> {
    if (job.kind === 'CREATE_PREFERENCE') {
      const payment = await this.payments.find(job.payload.paymentId!);
      if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Pagamento não encontrado.', 404);
      if (payment.preferenceId) return;
      const preference = await this.gateway.createPreference(payment);
      // Reuse the same preference after a CAS conflict, without repeating external I/O.
      for (let attempt = 0; attempt < 5; attempt++) {
        const current = await this.payments.find(payment.id);
        if (!current) throw new AppError('PAYMENT_NOT_FOUND', 'Pagamento não encontrado.', 404);
        if (current.preferenceId) return;
        try {
          await this.payments.save(
            {
              ...current,
              preferenceId: preference.id,
              checkoutUrl: preference.checkoutUrl,
              checkoutStatus: 'READY',
            },
            current.version,
            'CHECKOUT',
          );
          return;
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'VERSION_CONFLICT' || attempt === 4)
            throw error;
        }
      }
      return;
    }
    const remote = await this.gateway.getPayment(job.payload.providerPaymentId!);
    const payment = await this.payments.find(remote.externalReference);
    if (!payment) throw new AppError('UNKNOWN_EXTERNAL_REFERENCE', 'Referência desconhecida.', 404);
    const next = reconcilePayment(payment, remote);
    if (next !== payment) await this.payments.save(next, payment.version, 'MERCADO_PAGO');
  }
}
