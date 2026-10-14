/**
 * Zod schema for step retry configuration.
 */
import { z } from '@hono/zod-openapi';

export const DEFAULT_NODE_MAX_RETRIES = 2;

export const stepRetryConfigSchema = z.object({
  /** Maximum retry attempts (not including the initial attempt). 1–5, default 2. */
  max_attempts: z
    .number()
    .int()
    .min(1, "'retry.max_attempts' must be between 1 and 5")
    .max(5, "'retry.max_attempts' must be between 1 and 5")
    .default(DEFAULT_NODE_MAX_RETRIES),
  /** Initial delay in ms, doubled on each attempt. 1000–60000. */
  delay_ms: z
    .number()
    .min(1000, "'retry.delay_ms' must be a number between 1000 and 60000")
    .max(60000, "'retry.delay_ms' must be a number between 1000 and 60000")
    .optional(),
  /** Which error types trigger a retry. Default: 'transient'. */
  on_error: z.enum(['transient', 'all']).optional(),
});

export type StepRetryConfig = z.infer<typeof stepRetryConfigSchema>;
