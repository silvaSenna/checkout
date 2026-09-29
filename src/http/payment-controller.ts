import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { present } from '../application/payments.js';
import { AppError } from '../domain/errors.js';
import { ApiKeyGuard } from './auth.js';
import { HTTP_CONTEXT, type HttpContext } from './context.js';
import {
  createSchema,
  filterSchema,
  idSchema,
  keySchema,
  parse,
  updateSchema,
  versionSchema,
} from './schemas.js';
import { createBody, errorSchema, paymentResponseSchema, updateBody } from './openapi.js';

@ApiTags('Pagamentos')
@ApiSecurity('apiKey')
@ApiResponse({ status: 400, description: 'Entrada inválida', schema: errorSchema })
@ApiResponse({ status: 401, description: 'API key inválida', schema: errorSchema })
@ApiResponse({
  status: 409,
  description: 'Conflito de negócio ou idempotência',
  schema: errorSchema,
})
@ApiResponse({
  status: 503,
  description: 'Serviço temporariamente indisponível',
  schema: errorSchema,
})
@UseGuards(ApiKeyGuard)
@Controller('api/payment')
export class PaymentController {
  constructor(@Inject(HTTP_CONTEXT) private readonly context: HttpContext) {}

  @Post()
  @ApiOperation({ summary: 'Criar cobrança; cartão inicia checkout de forma assíncrona' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8 a 128 caracteres: letras, números, _ ou -',
  })
  @ApiBody({ schema: createBody })
  @ApiResponse({ status: 201, description: 'Cobrança persistida', schema: paymentResponseSchema })
  @ApiResponse({
    status: 200,
    description: 'Repetição da chave: recurso existente',
    schema: paymentResponseSchema,
  })
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const input = parse(createSchema, body);
    const idempotencyKey = parse(keySchema, key);
    if (input.paymentMethod === 'CREDIT_CARD' && !this.context.config.MP_ACCESS_TOKEN) {
      throw new AppError(
        'CARD_NOT_CONFIGURED',
        'Configure a integração Mercado Pago para usar cartão.',
        503,
      );
    }
    const result = await this.context.payments.create(input, idempotencyKey);
    response.status(result.created ? 201 : 200);
    response.setHeader('Location', `/api/payment/${result.payment.id}`);
    response.setHeader('ETag', `"${result.payment.version}"`);
    response.setHeader('Idempotency-Replayed', String(!result.created));
    return present(result.payment);
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, schema: paymentResponseSchema })
  @ApiResponse({ status: 404, schema: errorSchema })
  async get(@Param('id') id: unknown, @Res({ passthrough: true }) response: Response) {
    const payment = await this.context.payments.get(parse(idSchema, id));
    response.setHeader('ETag', `"${payment.version}"`);
    return present(payment);
  }

  @Get()
  @ApiQuery({ name: 'cpf', required: false })
  @ApiQuery({ name: 'paymentMethod', enum: ['PIX', 'CREDIT_CARD'], required: false })
  @ApiQuery({ name: 'status', enum: ['PENDING', 'PAID', 'FAIL'], required: false })
  @ApiQuery({ name: 'limit', type: Number, required: false, description: '1 a 100; padrão 20' })
  @ApiQuery({
    name: 'after',
    format: 'uuid',
    required: false,
    description: 'nextCursor da página anterior; ordem por UUID',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      properties: {
        data: { type: 'array', items: paymentResponseSchema },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  async list(@Query() query: unknown) {
    const result = await this.context.payments.list(parse(filterSchema, query));
    return { ...result, data: result.data.map(present) };
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Atualizar descrição/status do PIX; dados financeiros são imutáveis',
    description:
      'PUT aplica somente campos enviados (convenção do enunciado). Status de cartão só pode ser alterado pelo callback verificado.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'ETag retornado na leitura, incluindo aspas: "1"',
  })
  @ApiBody({ schema: updateBody })
  @ApiResponse({ status: 200, schema: paymentResponseSchema })
  @ApiResponse({ status: 404, schema: errorSchema })
  @ApiResponse({ status: 412, description: 'Versão desatualizada', schema: errorSchema })
  @ApiResponse({ status: 428, description: 'If-Match ausente', schema: errorSchema })
  async update(
    @Param('id') id: unknown,
    @Headers('if-match') version: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (version === undefined)
      throw new AppError('PRECONDITION_REQUIRED', 'Envie o ETag no header If-Match.', 428);
    const payment = await this.context.payments.update(
      parse(idSchema, id),
      parse(versionSchema, version),
      parse(updateSchema, body),
    );
    response.setHeader('ETag', `"${payment.version}"`);
    return present(payment);
  }
}
