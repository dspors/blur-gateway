const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLifecyclePlan } = require('../dist/routes/session-lifecycle.js');

test('builds a Claude lifecycle plan from provider file metadata', () => {
  const plan = buildLifecyclePlan({
    id: 'local_test',
    title: 'Claude Smoke',
    provider: 'claude-desktop',
    status: 'Idle',
    archived: false,
    jsonlPath: 'C:\\does\\not\\exist\\session.jsonl',
    metadataPath: 'C:\\does\\not\\exist\\local_test.json',
  });

  assert.equal(plan.sessionId, 'local_test');
  assert.equal(plan.title, 'Claude Smoke');
  assert.equal(plan.provider, 'claude-desktop');
  assert.deepEqual(plan.files.map(file => file.role), ['jsonl', 'metadata']);
  assert.equal(plan.files[0].exists, false);
  assert.equal(plan.warnings.length, 0);
});

test('warns that Codex lifecycle mutation is discovery-gated', () => {
  const plan = buildLifecyclePlan({
    id: 'codex_test',
    title: 'codex-e2e',
    provider: 'codex-cli',
    jsonlPath: 'C:\\does\\not\\exist\\rollout.jsonl',
  });

  assert.equal(plan.sessionId, 'codex_test');
  assert.deepEqual(plan.files.map(file => file.role), ['jsonl']);
  assert.match(plan.warnings.join('\n'), /state_5\.sqlite/);
});
