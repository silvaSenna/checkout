import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  Module,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { AppError } from '../domain/errors.js';
import { HTTP_CONTEXT, type HttpContext } from './context.js';
import { PaymentController } from './payment-controller.js';
import { WebhookController } from './webhook-controller.js';
import { HealthController } from './health-controller.js';
import { ApiKeyGuard } from './auth.js';

@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const parserError =
      error instanceof Error &&
      'type' in error &&
      ['entity.parse.failed', 'entity.too.large'].includes(String(error.type));
    const status =
      error instanceof AppError
        ? error.httpStatus
        : error instanceof HttpException
          ? error.getStatus()
          : parserError
            ? 'status' in error
              ? Number(error.status)
              : 400
            : 500;
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: 'http.error',
          requestId: response.locals.requestId,
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
        }),
      );
    response.status(status).json({
      status,
      code:
        error instanceof AppError ? error.code : status >= 500 ? 'INTERNAL_ERROR' : 'HTTP_ERROR',
      message:
        error instanceof AppError
          ? error.message
          : status >= 500
            ? 'Erro interno.'
            : 'Requisição inválida.',
      requestId: response.locals.requestId,
    });
  }
}

export async function createApp(context: HttpContext, quiet = false) {
  @Module({
    controllers: [PaymentController, WebhookController, HealthController],
    providers: [
      { provide: HTTP_CONTEXT, useValue: context },
      ApiKeyGuard,
      {
        provide: 'RESOURCES',
        useValue: { onApplicationShutdown: context.close ?? (() => undefined) },
      },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: quiet ? false : ['error', 'warn', 'log'],
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-Id', res.locals.requestId as string);
    res.setHeader('Cache-Control', 'no-store');
    res.on('finish', () => {
      if (!quiet)
        console.info(
          JSON.stringify({
            event: 'http.request',
            requestId: res.locals.requestId,
            method: req.method,
            route: (req.route as { path?: string } | undefined)?.path ?? 'unmatched',
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
          }),
        );
    });
    next();
  });
  app.use(helmet());
  app.use(json({ limit: '16kb' }));
  app.useGlobalFilters(new Errors());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Payments API')
      .setDescription(
        'Cobranças PIX e Checkout Pro. Valores em BRL. Consulte README e decisões arquiteturais.',
      )
      .setVersion('1.0.0')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'x-api-key' }, 'apiKey')
      .build(),
  );
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'openapi.json' });
  app.enableShutdownHooks();
  return app;
}
