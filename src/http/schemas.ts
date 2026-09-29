import { z } from 'zod';
import { AppError } from '../domain/errors.js';

export const createSchema = z
  .object({
    cpf: z.string().max(14),
    description: z.string().max(255),
    amount: z.union([z.string().max(12), z.number().finite()]),
    paymentMethod: z.enum(['PIX', 'CREDIT_CARD']),
  })
  .strict();
export const updateSchema = z
  .object({
    description: z.string().max(255).optional(),
    status: z.enum(['PENDING', 'PAID', 'FAIL']).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0, 'Informe ao menos um campo.');
export const filterSchema = z
  .object({
    cpf: z.string().max(14).optional(),
    paymentMethod: z.enum(['PIX', 'CREDIT_CARD']).optional(),
    status: z.enum(['PENDING', 'PAID', 'FAIL']).optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().min(1).max(100))
      .default(20),
    after: z.uuid().optional(),
  })
  .strict();
export const idSchema = z.uuid();
export const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
export const versionSchema = z
  .string()
  .regex(/^"[1-9]\d{0,8}"$/)
  .transform((value) => Number(value.slice(1, -1)));
export const webhookQuerySchema = z.object({
  'data.id': z.string().regex(/^\d{1,20}$/),
  type: z.literal('payment'),
});
export const webhookBodySchema = z.object({
  type: z.literal('payment'),
  data: z.object({
    id: z
      .union([z.string().regex(/^\d{1,20}$/), z.number().int().safe().nonnegative()])
      .transform(String),
  }),
});
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AppError(
      'VALIDATION_ERROR',
      `Dados inválidos: ${result.error.issues.map((issue) => issue.path.join('.') || 'body').join(', ')}`,
    );
  return result.data;
}
