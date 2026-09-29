import type { SchemaObject } from '@nestjs/swagger';

export const paymentResponseSchema: SchemaObject = {
  type: 'object',
  required: [
    'id',
    'cpf',
    'description',
    'amount',
    'currency',
    'paymentMethod',
    'status',
    'checkoutStatus',
    'version',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    cpf: { type: 'string', example: '52998224725' },
    description: { type: 'string' },
    amount: { type: 'string', example: '150.90' },
    currency: { type: 'string', enum: ['BRL'] },
    paymentMethod: { type: 'string', enum: ['PIX', 'CREDIT_CARD'] },
    status: { type: 'string', enum: ['PENDING', 'PAID', 'FAIL'] },
    checkoutStatus: {
      type: 'string',
      enum: ['NOT_REQUIRED', 'PROCESSING', 'READY', 'REQUIRES_REVIEW'],
    },
    preferenceId: { type: 'string', nullable: true },
    checkoutUrl: { type: 'string', nullable: true },
    providerPaymentId: { type: 'string', nullable: true },
    providerUpdatedAt: { type: 'string', format: 'date-time', nullable: true },
    version: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};
export const createBody: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['cpf', 'description', 'amount', 'paymentMethod'],
  properties: {
    cpf: { type: 'string', example: '52998224725' },
    description: { type: 'string', minLength: 1, maxLength: 255 },
    amount: {
      oneOf: [
        { type: 'string', pattern: '^\\d{1,6}(\\.\\d{1,2})?$' },
        { type: 'number', minimum: 0.01, maximum: 999999.99 },
      ],
      example: '150.90',
    },
    paymentMethod: { type: 'string', enum: ['PIX', 'CREDIT_CARD'] },
  },
};
export const updateBody: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    description: { type: 'string', minLength: 1, maxLength: 255 },
    status: { type: 'string', enum: ['PENDING', 'PAID', 'FAIL'] },
  },
};
export const errorSchema: SchemaObject = {
  type: 'object',
  properties: {
    status: { type: 'integer' },
    code: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string', format: 'uuid' },
  },
};
