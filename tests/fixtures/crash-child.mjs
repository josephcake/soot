// Child process for tests/resume-after-kill.test.ts. Runs a persisted run with mock agents
// (TEST DOUBLE; no model calls) from the BUILT packages, prints READY once the state the
// parent wants to interrupt has been committed, then waits to be SIGKILLed.
import { parseEnv } from '../../packages/core/dist/index.js';
import { MockAgentRunner, runTaskGraph } from '../../packages/agent-runtime/dist/index.js';
import { openExecutionStore } from '../../packages/context-manager/dist/index.js';
import { buildTaskGraph } from '../../packages/task-graph/dist/index.js';

const runId = process.argv[2];
const { dataDir } = parseEnv(process.env);
const store = openExecutionStore({ dataDir });
const run = store.loadRun(runId);

const finished = new Set();
let cStarted = false;
const maybeReady = () => {
  if (cStarted && ['a', 'b', 'd'].every((id) => finished.has(id))) process.stdout.write('READY\n');
};

await runTaskGraph(buildTaskGraph(run.tasks), {
  runner: new MockAgentRunner({
    defaultScript: { delayMs: 20 },
    scripts: { c: { outcome: 'hang' } },
  }),
  journal: store.journal(runId),
  completed: run.completed,
  previousAttempts: run.attemptCounts,
  onEvent: (event) => {
    if (event.type === 'task-started' && event.taskId === 'c') cStarted = true;
    if (event.type === 'task-finished') finished.add(event.taskId);
    maybeReady();
  },
});
process.stdout.write('UNEXPECTED-FINISH\n');
