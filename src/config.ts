import { z } from 'zod';

const httpsUrl = z.url().refine((url) => new URL(url).protocol === 'https:', 'HTTPS obrigatório');
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .url()
    .refine((url) => ['postgres:', 'postgresql:'].includes(new URL(url).protocol)),
  API_KEY: z.string().min(32),
  MP_ACCESS_TOKEN: z.string().min(1).optional(),
  MP_WEBHOOK_SECRET: z.string().min(16).optional(),
  MP_COLLECTOR_ID: z.string().regex(/^\d+$/).optional(),
  MP_WEBHOOK_URL: httpsUrl.optional(),
  MP_RETURN_URL: httpsUrl.optional(),
  MP_SANDBOX: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  MP_TIMEOUT_MS: z.coerce.number().int().min(100).max(15000).default(8000),
  WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  WORKER_POLL_MS: z.coerce.number().int().min(100).max(10000).default(1000),
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Never put secrets or connection strings in startup errors.
    throw new Error(
      `Configuração inválida: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  const config = result.data;
  const mp = [
    config.MP_ACCESS_TOKEN,
    config.MP_WEBHOOK_SECRET,
    config.MP_COLLECTOR_ID,
    config.MP_WEBHOOK_URL,
    config.MP_RETURN_URL,
  ];
  if (mp.some(Boolean) && !mp.every(Boolean))
    throw new Error('Configure todas as variáveis MP_* de credenciais e URLs.');
  if (config.NODE_ENV === 'production' && config.API_KEY.includes('change-me'))
    throw new Error('Substitua a API_KEY de exemplo.');
  return config;
}
