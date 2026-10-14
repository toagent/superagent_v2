# Control-plane waits and execution receipts

`waitRun` delegates observation to Archon's existing `workflow wait --json` transport.
Its `RunWaitResult` is an attention notification, not a verbose `RunView`: failed-node,
delivery-artifact, owner and scheduled-resume classification still requires one `get`
after each notification. No lifecycle transitions, extra DB poller or daemon are added.
Blocks are at most 29 seconds with a 30-second transport bound, preserving the outer
deadline and the inbox check between blocks. Native wait failures fail clearly.
The synchronous CLI remains synchronous; inbox/supervisor visibility is bounded by
the current block rather than by a one-second poll. OS interruption remains native
subprocess interruption; no new signal handlers claim terminal ownership.

The deterministic running fixture in `tests/cli.test.ts` compares the same observation
window with the old one-second loop. Counts exclude model execution (none occurs):

| Window | Before wait/get | After wait/get | Before/after transport launches |
| ------ | --------------- | -------------- | ------------------------------- |
| 20s    | 20 / 21         | 1 / 2          | 41 / 3                          |
| 60s    | 60 / 61         | 3 / 4          | 121 / 7                         |

These are CLI transport launches; wrappers may spawn another child. Physical child
counts, native wall-clock savings and first-token latency require the controller's
native smoke and remain unknown. Fixture time advances deterministically rather
than spending 60 seconds sleeping. Policy and context are unchanged by waiting.

Job metadata retains `receipt.enqueued_at` independently of the compatibility
`started_at` (child start). Admission, spawn and settlement are wrapper observations,
not provider first events or first tokens. `execution` remains the existing resolved
policy owner and `card` supplies the context reference. `report` reads jobs readonly
and emits queue/preparation/execution durations, explicit missing measurements and
workflow phase coverage. Legacy records never infer queue duration from timestamps.
`brief --json` returns the existing structured summary and node execution metadata
with one `get`, without transcript exploration.

`superagent report` and `report --json` default to aggregate metrics, unreadable
counts and next steps. `unknown_counts` counts literal unknown occurrences by field
path in the full report; `*` and `[]` collapse map keys and array entries. These are
field-occurrence counts, not unique attempts. Explicit exec nodes (legacy bash/script)
without provider evidence use `n/a` for provider metrics and do not enter unknown
counts. Absent node types or missing AI streams remain `unknown`.

Readonly history reproduction reuses `superagent report --full --json`: its usage window
contains all retained generations, not an implied seven-day deployment cohort.
Filter the resulting metadata by UTC run timestamps to freeze a seven-day sample;
preserve `usage.unreadable`, token/phase coverage and unknown roles. The pre-change
readonly sampling source is `/tmp/sa-efficiency-review.gBNgzvuY/baseline.json`
(`measuring_code`); its frozen facts are `execution-history-facts.json` and
`execution-source-facts.json` in the same directory. Do not persist prompts, goal
text or other session bodies. Input/output/cache remain separate report fields;
never add cache to input or reasoning to output without the provider's convention.
Completed counts are lifecycle statistics, not requirement completion or deployment.
