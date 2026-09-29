import { Controller, Get, Inject } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppError } from '../domain/errors.js';
import { HTTP_CONTEXT, type HttpContext } from './context.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(@Inject(HTTP_CONTEXT) private readonly context: HttpContext) {}
  @Get('live')
  @ApiResponse({ status: 200 })
  live() {
    return { status: 'ok' };
  }
  @Get('ready')
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 503 })
  async ready() {
    try {
      await this.context.checkDatabase();
    } catch {
      throw new AppError('DATABASE_UNAVAILABLE', 'Banco indisponível.', 503);
    }
    return { status: 'ok' };
  }
}
