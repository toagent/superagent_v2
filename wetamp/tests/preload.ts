// Empty values prevent Bun children from restoring derived identities from .env.
for (const key of [
  'SUPERAGENT_ROLE',
  'SA_JOB_ID',
  'SA_JOB_CARD',
  'SA_JOB_REQUEST_REF',
  'AI_DISPATCH_ROLE',
  'TWIN_AGENT_REMOTE',
])
  process.env[key] = '';
