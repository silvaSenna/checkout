import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../domain/errors.js';

export function verifyWebhook(input: {
  signature: string;
  requestId: string;
  dataId: string;
  secret: string;
  now?: number;
  toleranceMs?: number;
}): void {
  const invalid = () => new AppError('INVALID_WEBHOOK_SIGNATURE', 'Assinatura inválida.', 401);
  const parts = input.signature.split(',').map((part) => part.trim());
  const timestamps = parts.filter((part) => part.startsWith('ts='));
  const signatures = parts.filter((part) => part.startsWith('v1='));
  if (timestamps.length !== 1 || signatures.length !== 1 || parts.length !== 2) throw invalid();
  const ts = timestamps[0]!.slice(3);
  const signature = signatures[0]!.slice(3);
  if (
    !/^\d{10}(\d{3})?$/.test(ts) ||
    !/^[a-f\d]{64}$/i.test(signature) ||
    !/^[\w-]{1,200}$/.test(input.requestId)
  )
    throw invalid();
  const timestampMs = ts.length === 10 ? Number(ts) * 1000 : Number(ts);
  if (Math.abs((input.now ?? Date.now()) - timestampMs) > (input.toleranceMs ?? 300_000))
    throw invalid();
  const manifest = `id:${input.dataId.toLowerCase()};request-id:${input.requestId};ts:${ts};`;
  const expected = createHmac('sha256', input.secret).update(manifest).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw invalid();
}
