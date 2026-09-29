import process from 'node:process';
import console from 'node:console';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';

let database;
let directory;
let started = false;
try {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    directory = await mkdtemp(join(tmpdir(), 'payments-pg-'));
    const socket = createServer();
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(0, '127.0.0.1', resolve);
    });
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    database = new EmbeddedPostgres({
      databaseDir: directory,
      port,
      user: 'postgres',
      password: 'local-test-password',
      persistent: false,
      authMethod: 'scram-sha-256',
      postgresFlags: ['-h', '127.0.0.1', '-k', directory],
      onLog: () => {},
      onError: () => {},
    });
    await database.initialise();
    await database.start();
    started = true;
    url = `postgres://postgres:local-test-password@127.0.0.1:${port}/postgres`;
  }
  const child = spawn(
    process.execPath,
    ['--test', '--test-reporter=spec', '.test-build/test/integration/postgres.test.js'],
    {
      stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL: url },
    },
  );
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} catch (error) {
  console.error('Não foi possível executar PostgreSQL de teste:', error.message);
  process.exitCode = 1;
} finally {
  if (started) await database.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
}

// embedded-postgres registers a beforeExit hook that otherwise resets failures to zero.
process.exit(process.exitCode ?? 0);
