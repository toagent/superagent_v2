// A command fixture, never a model. The job wrapper and stdout wire format are the subject under test.
import { appendFileSync, writeFileSync } from 'node:fs';
const input = process.argv[3];
const data = JSON.parse(input.slice(input.lastIndexOf('\n') + 1)) as {
  episode: { id: string; project: string };
};
if (process.env.FAKE_MEMORY_INPUT) writeFileSync(process.env.FAKE_MEMORY_INPUT, input);
if (process.env.FAKE_MEMORY_STARTED)
  appendFileSync(process.env.FAKE_MEMORY_STARTED, data.episode.id + '\n');
if (process.env.FAKE_MEMORY_DELAY) await Bun.sleep(Number(process.env.FAKE_MEMORY_DELAY));
if (process.env.FAKE_MEMORY_EXIT) process.exit(Number(process.env.FAKE_MEMORY_EXIT));
writeFileSync(
  process.argv[2],
  process.env.FAKE_MEMORY_OVERSIZE
    ? ' '.repeat(1025)
    : process.env.FAKE_MEMORY_EMPTY
      ? JSON.stringify({ operations: [] })
      : JSON.stringify({
          operations: [
            {
              op: 'ADD',
              lesson: {
                tier: 'project',
                scope: data.episode.project,
                when: '验收占用固定端口',
                do: '选取空闲端口再跑验收',
                dont: '假定 39890 空闲',
                why: '端口冲突有验收证据',
                evidence: [data.episode.id],
                mechanizable: false,
              },
            },
          ],
        })
);
if (!process.env.FAKE_MEMORY_UNKNOWN_USAGE)
  console.log(
    JSON.stringify({
      type: 'turn.completed',
      usage: {
        input_tokens: Number(process.env.FAKE_MEMORY_TOKENS ?? 8192),
        cached_input_tokens: 4096,
        output_tokens: 1024,
      },
    })
  );
