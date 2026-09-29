import { Body, Controller, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ApiBody, ApiHeader, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppError } from '../domain/errors.js';
import { verifyWebhook } from '../infrastructure/mercado-pago/webhook-signature.js';
import { HTTP_CONTEXT, type HttpContext } from './context.js';
import { parse, webhookBodySchema, webhookQuerySchema } from './schemas.js';

@ApiTags('Mercado Pago')
@Controller('api/webhooks/mercado-pago')
export class WebhookController {
  constructor(@Inject(HTTP_CONTEXT) private readonly context: HttpContext) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Receber notificação assinada e persistir na inbox' })
  @ApiHeader({ name: 'x-signature', required: true })
  @ApiHeader({ name: 'x-request-id', required: true })
  @ApiQuery({ name: 'data.id', required: true })
  @ApiQuery({ name: 'type', enum: ['payment'], required: true })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['payment'] },
        data: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Recebimento durável confirmado; processamento assíncrono',
  })
  @ApiResponse({ status: 401, description: 'Assinatura inválida ou fora da janela configurada' })
  async receive(
    @Query() query: unknown,
    @Body() body: unknown,
    @Headers('x-signature') signature?: string,
    @Headers('x-request-id') requestId?: string,
  ) {
    const config = this.context.config;
    if (!config.MP_WEBHOOK_SECRET)
      throw new AppError('WEBHOOK_NOT_CONFIGURED', 'Integração não configurada.', 503);
    const params = parse(webhookQuerySchema, query);
    verifyWebhook({
      signature: signature ?? '',
      requestId: requestId ?? '',
      dataId: params['data.id'],
      secret: config.MP_WEBHOOK_SECRET,
      toleranceMs: config.WEBHOOK_TOLERANCE_SECONDS * 1000,
    });
    const payload = parse(webhookBodySchema, body);
    if (payload.data.id !== params['data.id'])
      throw new AppError('WEBHOOK_ID_MISMATCH', 'IDs divergentes.', 400);
    const deliveryKey = createHash('sha256')
      .update(`${requestId}:${params['data.id']}`)
      .digest('hex');
    await this.context.jobs.enqueueWebhook(params['data.id'], deliveryKey);
    return { received: true };
  }
}
