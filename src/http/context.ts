import type { Config } from '../config.js';
import type { Payments } from '../application/payments.js';
import type { JobQueue } from '../application/ports.js';

export const HTTP_CONTEXT = Symbol('HTTP_CONTEXT');
export interface HttpContext {
  config: Config;
  payments: Payments;
  jobs: JobQueue;
  close?: () => Promise<void>;
  checkDatabase: () => Promise<void>;
}
