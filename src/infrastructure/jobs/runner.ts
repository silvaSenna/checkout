import type { JobQueue, JobProcessor } from '../../application/ports.js';
import { AppError, ProviderError } from '../../domain/errors.js';

export class JobRunner {
  constructor(
    private readonly queue: JobQueue,
    private readonly processor: JobProcessor,
    private readonly log: (record: Record<string, unknown>) => void = (record) =>
      console.info(JSON.stringify(record)),
  ) {}

  async runOnce(): Promise<boolean> {
    const job = await this.queue.claim();
    if (!job) return false;
    try {
      if (job.attempts > 8) throw new ProviderError('ATTEMPTS_EXHAUSTED', false);
      await this.processor.execute(job);
      await this.queue.complete(job);
      this.log({ event: 'job.completed', jobId: job.id, kind: job.kind });
    } catch (error) {
      const code =
        error instanceof ProviderError || error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      const retryable =
        error instanceof ProviderError
          ? error.retryable
          : error instanceof AppError
            ? error.code === 'VERSION_CONFLICT'
            : true;
      await this.queue.fail(job, code, retryable);
      this.log({
        event: 'job.failed',
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
        code,
        retryable,
      });
    }
    return true;
  }
}
