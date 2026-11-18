import { assertCommander, coord } from './index';
import { launcher } from '../launcher';
import { home } from '../config';

assertCommander();
const session = await Bun.stdin.text();
// The resume payload identifies the session when an app-server hosts several sessions.
const who = launcher(home().sa, { ...process.env, CODEX_SESSION_ID: session });
if (who?.client === process.argv[2] && who.session_id === session) {
  const { client, session_id, host, pid, pid_start } = who;
  coord().renewSession({ client, session_id, host, pid, pid_start });
}
