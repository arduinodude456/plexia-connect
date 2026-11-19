import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotScheduler, getSessionSyncSnapshot, resumeStudentSession, submitResponse } from '../src/backend.ts';

globalThis.window = globalThis;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const row = (status = 'live') => ({ id: 's', presentation_id: 'p', join_code: 'ABCDEF', status, current_slide_index: 2, activity_status: 'running', created_at: 't' });
function fakeClient(results, user = { id: 'u', is_anonymous: true }) {
  const queries = [];
  return {
    queries,
    auth: { async getSession() { return { data: { session: user ? { user } : null }, error: null }; } },
    from(table) {
      const q = { table }; queries.push(q);
      return {
        select(columns) { q.columns = columns; return this; }, eq() { return this; },
        async single() { assert.ok(results.length, `unexpected ${table}`); return results.shift(); },
        async maybeSingle() { assert.ok(results.length, `unexpected ${table}`); return results.shift(); },
      };
    },
  };
}
const ok = (data) => ({ data, error: null });

test('reconnect invalidates stale in-flight data and schedules one current read', async () => {
  const gate = deferred(), applied = []; let calls = 0;
  const scheduler = createSnapshotScheduler(async (valid) => { const n = ++calls; if (n === 1) await gate.promise; if (valid()) applied.push(n); });
  scheduler.request(); scheduler.request(); scheduler.request(); gate.resolve(); await tick();
  assert.deepEqual(applied, [2]); assert.equal(calls, 2); scheduler.close();
});

test('snapshot records the server version belonging to the full presentation row, not its client timestamp', async () => {
  const presentation = { title: 'latest', updatedAt: 'old-client-clock', slides: [] };
  const client = fakeClient([ok(row()), ok({ updated_at: 'v2' }), ok({ updated_at: 'v3', data: presentation })]);
  const snapshot = await getSessionSyncSnapshot('s', 'p', 'v1', client);
  assert.equal(snapshot.presentationVersion, 'v3'); assert.equal(snapshot.presentation.title, 'latest');
  assert.deepEqual(client.queries.map(q => q.columns), ['id,presentation_id,join_code,status,current_slide_index,activity_status,created_at', 'updated_at', 'updated_at,data']);
});

test('unchanged presentation version is not downloaded again', async () => {
  const client = fakeClient([ok(row()), ok({ updated_at: 'v1' })]);
  const snapshot = await getSessionSyncSnapshot('s', 'p', 'v1', client);
  assert.equal(snapshot.presentation, undefined); assert.equal(client.queries.length, 2);
});

test('ending between session and presentation read survives presentation RLS denial', async () => {
  const client = fakeClient([ok(row()), { data: null, error: new Error('denied') }, ok(row('ended'))]);
  const snapshot = await getSessionSyncSnapshot('s', 'p', 'v1', client);
  assert.equal(snapshot.session.status, 'ended'); assert.equal(snapshot.presentationVersion, 'v1');
});

test('resume verifies anonymous identity and membership, and does not read an ended presentation', async () => {
  const wrong = fakeClient([], { id: 'other', is_anonymous: true });
  await assert.rejects(resumeStudentSession('s', 'u', wrong), /nicht mehr verfügbar/);
  assert.equal(wrong.queries.length, 0);
  const missing = fakeClient([ok(null)]);
  await assert.rejects(resumeStudentSession('s', 'u', missing), /nicht mehr verfügbar/);
  const ended = fakeClient([ok({ nickname: 'N' }), ok(row('ended'))]);
  const restored = await resumeStudentSession('s', 'u', ended);
  assert.equal(restored.session.status, 'ended'); assert.equal(restored.nickname, 'N');
  assert.equal(restored.presentation, undefined); assert.equal(ended.queries.length, 2);
});

test('resume of an active joined identity fetches membership and current bundle', async () => {
  const presentation = { title: 'Lesson', slides: [] };
  const client = fakeClient([ok({ nickname: 'N' }), ok(row()), ok(row()), ok({ data: presentation })]);
  const restored = await resumeStudentSession('s', 'u', client);
  assert.equal(restored.nickname, 'N'); assert.equal(restored.session.currentSlideIndex, 2);
  assert.equal(restored.presentation, presentation);
});


test('concurrent first submissions use the existing unique row after a 23505 conflict', async () => {
  const calls = []; let reads = 0;
  const saved = { id: 'r', session_id: 's', slide_id: 'slide', participant_id: 'u', nickname: 'N', answer_text: 'answer', answer_json: {}, created_at: 't' };
  const client = {
    auth: { async getUser() { return { data: { user: { id: 'u', is_anonymous: true } }, error: null }; } },
    from(table) {
      assert.equal(table, 'student_responses'); let action = 'read';
      return {
        select(columns) { calls.push(['select', columns]); return this; },
        eq(key, value) { calls.push(['eq', key, value]); return this; },
        insert(value) { action = 'insert'; calls.push(['insert', value]); return this; },
        update(value) { action = 'update'; calls.push(['update', value]); return this; },
        async maybeSingle() { if (action === 'update') return ok(saved); reads++; return ok(reads === 1 ? null : { id: 'r' }); },
        async single() { assert.equal(action, 'insert'); return { data: null, error: { code: '23505' } }; },
      };
    },
  };
  const result = await submitResponse({ sessionId: 's', slideId: 'slide', nickname: 'N', answerText: 'answer' }, client);
  assert.equal(result.id, 'r'); assert.equal(calls.filter(([kind]) => kind === 'insert').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'update').length, 1);
  const update = calls.find(([kind]) => kind === 'update')[1];
  assert.deepEqual(update, { answer_text: 'answer', answer_json: {} });
  assert.ok(calls.some(([kind, key, value]) => kind === 'eq' && key === 'reviewed' && value === false));
  assert.ok(calls.filter(([kind]) => kind === 'select').every(([,columns]) => !columns.includes('feedback') && !columns.includes('score')));
});

for (const race of [false, true]) {
  for (const matched of [false, true]) {
    test(`existing response update: ${race ? '23505 race' : 'normal path'}, ${matched ? 'unreviewed row' : 'zero rows'}`, async () => {
      const filters = []; let reads = 0; let updates = 0;
      const saved = { id: 'r', session_id: 's', slide_id: 'slide', participant_id: 'u', nickname: 'N', answer_text: 'new', answer_json: {}, created_at: 't' };
      const client = {
        auth: { async getUser() { return ok({ user: { id: 'u', is_anonymous: true } }); } },
        from(table) {
          assert.equal(table, 'student_responses'); let action = 'read';
          return {
            select() { return this; },
            eq(key, value) { if (action === 'update') filters.push([key, value]); return this; },
            update() { action = 'update'; updates++; return this; },
            insert() { action = 'insert'; return this; },
            async maybeSingle() {
              if (action === 'update') return ok(matched ? saved : null);
              reads++; return ok(race && reads === 1 ? null : { id: 'r' });
            },
            async single() { assert.equal(action, 'insert'); return { data: null, error: { code: '23505' } }; },
          };
        },
      };
      const send = submitResponse({ sessionId: 's', slideId: 'slide', nickname: 'N', answerText: 'new' }, client);
      if (matched) assert.equal((await send).id, 'r');
      else await assert.rejects(send, { message: 'Die Antwort kann nicht mehr geändert werden. Sie wurde möglicherweise bewertet oder die Stunde hat sich geändert.' });
      assert.equal(updates, 1);
      assert.deepEqual(filters, [['id', 'r'], ['participant_id', 'u'], ['reviewed', false]]);
    });
  }
}
