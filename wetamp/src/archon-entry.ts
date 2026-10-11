import { installPolicyExecutor } from './policy-executor';

installPolicyExecutor();
// Detached re-invocations preserve argv[1], so resume uses the same execution boundary.
await import('../../packages/cli/src/cli');
