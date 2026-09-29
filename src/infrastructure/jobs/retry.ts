import { z } from 'zod';
import { createPool } from '../database/database.js';

async function main() {
  const id = z.uuid().parse(process.argv[2]);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL é obrigatória.');
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const result = await pool.query(
      `UPDATE jobs SET status = 'READY', attempts = 0, available_at = now(), lease_until = NULL,
       lease_token = NULL, updated_at = now() WHERE id = $1 AND status = 'DEAD' RETURNING id`,
      [id],
    );
    if (!result.rowCount) throw new Error('Job não encontrado ou não está DEAD.');
    console.info('Job reagendado.');
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  console.error('Falha: informe um UUID de job DEAD e DATABASE_URL válida.');
  process.exitCode = 1;
});
