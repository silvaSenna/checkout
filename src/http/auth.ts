import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../domain/errors.js';
import { HTTP_CONTEXT, type HttpContext } from './context.js';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(HTTP_CONTEXT) private readonly context: HttpContext) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const key = request.header('x-api-key');
    const digest = (value: string) => createHash('sha256').update(value).digest();
    if (!key || !timingSafeEqual(digest(key), digest(this.context.config.API_KEY))) {
      throw new AppError('UNAUTHORIZED', 'Credencial inválida.', 401);
    }
    return true;
  }
}
