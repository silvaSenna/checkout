import { AppError } from './errors.js';

export type PaymentMethod = 'PIX' | 'CREDIT_CARD';
export type PaymentStatus = 'PENDING' | 'PAID' | 'FAIL';
export type CheckoutStatus = 'NOT_REQUIRED' | 'PROCESSING' | 'READY' | 'REQUIRES_REVIEW';

export interface Payment {
  id: string;
  cpf: string;
  description: string;
  amountCents: number;
  paymentMethod: PaymentMethod;
  status: PaymentStatus;
  checkoutStatus: CheckoutStatus;
  preferenceId: string | null;
  checkoutUrl: string | null;
  providerPaymentId: string | null;
  providerUpdatedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderPayment {
  id: string;
  externalReference: string;
  amountCents: number;
  currency: string;
  paymentType: string;
  status: string;
  updatedAt: string;
}

export function normalizeCpf(value: string): string {
  if (!/^(\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/.test(value)) {
    throw new AppError('INVALID_CPF', 'CPF deve ter 11 dígitos ou máscara 000.000.000-00.');
  }
  const cpf = value.replace(/\D/g, '');
  if (/^(\d)\1{10}$/.test(cpf)) throw new AppError('INVALID_CPF', 'CPF inválido.');
  for (const length of [9, 10]) {
    const sum = [...cpf.slice(0, length)].reduce(
      (total, digit, index) => total + Number(digit) * (length + 1 - index),
      0,
    );
    const digit = ((sum * 10) % 11) % 10;
    if (digit !== Number(cpf[length])) throw new AppError('INVALID_CPF', 'CPF inválido.');
  }
  return cpf;
}

/** Convert at the boundary; all internal arithmetic and storage use integer cents. */
export function toCents(value: string | number): number {
  const text = String(value);
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(text)) {
    throw new AppError('INVALID_AMOUNT', 'Valor deve ter até duas casas decimais.');
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents < 1 || cents > 99_999_999) {
    throw new AppError('INVALID_AMOUNT', 'Valor deve estar entre 0.01 e 999999.99 BRL.');
  }
  return cents;
}

export function describe(value: string): string {
  const description = value.trim();
  if (description.length < 1 || description.length > 255) {
    throw new AppError('INVALID_DESCRIPTION', 'Descrição deve ter entre 1 e 255 caracteres.');
  }
  return description;
}

export function updatePayment(
  payment: Payment,
  input: { description?: string; status?: PaymentStatus },
): Payment {
  if (input.status && payment.paymentMethod === 'CREDIT_CARD') {
    throw new AppError(
      'PROVIDER_MANAGED_STATUS',
      'Status de cartão é gerenciado pelo provedor.',
      409,
    );
  }
  if (input.description !== undefined && payment.status !== 'PENDING') {
    throw new AppError('PAYMENT_IMMUTABLE', 'Cobrança finalizada não pode ser editada.', 409);
  }
  if (input.description !== undefined && payment.paymentMethod === 'CREDIT_CARD') {
    throw new AppError('PAYMENT_IMMUTABLE', 'Descrição do cartão já foi enviada ao checkout.', 409);
  }
  if (input.status && payment.status !== 'PENDING' && input.status !== payment.status) {
    throw new AppError('INVALID_TRANSITION', 'Transição de status não permitida.', 409);
  }
  return {
    ...payment,
    description:
      input.description === undefined ? payment.description : describe(input.description),
    status: input.status ?? payment.status,
  };
}

export function reconcilePayment(payment: Payment, remote: ProviderPayment): Payment {
  if (
    payment.paymentMethod !== 'CREDIT_CARD' ||
    remote.externalReference !== payment.id ||
    remote.amountCents !== payment.amountCents ||
    remote.currency !== 'BRL' ||
    remote.paymentType !== 'credit_card'
  ) {
    throw new AppError(
      'PROVIDER_PAYMENT_MISMATCH',
      'Transação divergente: revisão necessária.',
      409,
    );
  }
  if (
    payment.providerPaymentId === remote.id &&
    payment.providerUpdatedAt &&
    Date.parse(remote.updatedAt) <= Date.parse(payment.providerUpdatedAt)
  )
    return payment;

  const statuses: Record<string, PaymentStatus> = {
    approved: 'PAID',
    rejected: 'FAIL',
    cancelled: 'FAIL',
    pending: 'PENDING',
    in_process: 'PENDING',
    authorized: 'PENDING',
    in_mediation: 'PENDING',
  };
  const status = Object.hasOwn(statuses, remote.status) ? statuses[remote.status] : undefined;
  if (!status) {
    throw new AppError('UNSUPPORTED_PROVIDER_STATUS', 'Status exige conciliação manual.', 409);
  }
  if (payment.status === 'PAID') {
    if (status === 'PAID' && payment.providerPaymentId !== remote.id) {
      throw new AppError('DUPLICATE_APPROVAL', 'Segunda aprovação exige conciliação manual.', 409);
    }
    return payment;
  }
  return {
    ...payment,
    status,
    providerPaymentId: remote.id,
    providerUpdatedAt: remote.updatedAt,
  };
}
