import { conditionalOutput, output, ref, type SyncOutput } from '../src/contract';

const conditional = conditionalOutput<SyncOutput>('conditional-sync');
ref.required(conditional, 'status');
ref.optional(conditional, 'generation', 'not-a-number');
ref.required(output<SyncOutput>('sync'), 'missing_field');
