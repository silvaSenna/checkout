import { readConfig } from './config.js';
import { compose } from './composition.js';
import { createApp } from './http/app.js';

async function main() {
  const config = readConfig();
  const { pool, context } = compose(config);
  try {
    await context.checkDatabase();
    const app = await createApp(context);
    await app.listen(config.PORT, '0.0.0.0');
  } catch (error) {
    await pool.end();
    throw error;
  }
}
void main().catch(() => {
  console.error('Falha ao iniciar a API. Verifique configuração, banco e migrations.');
  process.exitCode = 1;
});
