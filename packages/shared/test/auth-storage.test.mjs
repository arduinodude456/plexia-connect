import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';

// Run the real backend with a controlled import.meta.env and client factory.
async function loadBackend(factory) {
  let source = await readFile(new URL('../src/backend.ts', import.meta.url), 'utf8');
  source = source.replace(/^import \{ createClient, type RealtimeChannel, type SupabaseClient \} from "@supabase\/supabase-js";$/m, 'const createClient = globalThis.__testCreateClient;');
  source = source.replace('import.meta.env ?? {}', 'globalThis.__testAuthEnv');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  globalThis.__testCreateClient = factory;
  globalThis.__testAuthEnv = { VITE_SUPABASE_URL: 'https://test.example', VITE_SUPABASE_ANON_KEY: 'public-test-key' };
  return import(`data:text/javascript;base64,${Buffer.from(js + `\n// ${Math.random()}`).toString('base64')}`);
}

globalThis.window = globalThis;
function memoryStorage() {
  const values = new Map(); const reads = [];
  return { values, reads, getItem(key) { reads.push(key); return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); } };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = (name, anonymous) => ({ access_token: `${name}-test-token`, refresh_token: `${name}-test-refresh`, expires_in: 3600, token_type: 'bearer', user: { id: name, is_anonymous: anonymous } });

test('separate real SDK storage keeps the teacher session through Connect join and local logout', async () => {
  const storage = memoryStorage();
  const legacy = 'sb-test-auth-token';
  storage.values.set(legacy, 'legacy-untrusted-test-value');
  const requests = []; let optionsSeen;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input)); requests.push([init.method ?? 'GET', url.pathname, url.searchParams.get('scope')]);
    if (url.pathname.endsWith('/auth/v1/token')) return json(session('teacher', false));
    if (url.pathname.endsWith('/auth/v1/signup')) return json(session('student', true));
    if (url.pathname.endsWith('/auth/v1/logout')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/rest/v1/class_sessions')) return json([]);
    if (url.pathname.endsWith('/rest/v1/rpc/student_join_classroom')) return json({ session: { id: 's', presentation_id: 'p', join_code: 'ABC', status: 'live', current_slide_index: 0, activity_status: 'running', created_at: 't' }, presentation: { id: 'p', slides: [] } });
    throw new Error(`Unexpected test endpoint ${url.pathname}`);
  };
  const factory = (url, key, options) => {
    optionsSeen = options;
    return createClient(url, key, { ...options, auth: { ...options.auth, storage, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
  };
  const backend = await loadBackend(factory);
  assert.equal(optionsSeen.auth.storageKey, 'plexia-connect-auth-v1');
  assert.equal(optionsSeen.auth.persistSession, true);
  assert.equal(optionsSeen.auth.autoRefreshToken, true);
  assert.equal((await backend.supabase.auth.getSession()).data.session, null);
  const studio = createClient('https://test.example', 'public-test-key', { auth: { storageKey: 'plexia-studio-auth-v1', storage, persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch } });
  assert.equal((await studio.auth.signInWithPassword({ email: 'test@example.invalid', password: 'test-only' })).error, null);
  // Force the previously dangerous case: a teacher session inside Connect.
  assert.equal((await backend.supabase.auth.signInWithPassword({ email: 'test@example.invalid', password: 'test-only' })).error, null);
  await backend.joinClassSession('abc', 'N');
  assert.equal((await studio.auth.getSession()).data.session.user.id, 'teacher');
  assert.equal((await backend.supabase.auth.getSession()).data.session.user.id, 'student');
  assert.ok(storage.values.has('plexia-studio-auth-v1'));
  assert.ok(storage.values.has('plexia-connect-auth-v1'));
  // Rejoining with an existing anonymous identity must neither log out nor create another identity.
  await backend.joinClassSession('abc', 'N');
  assert.equal(requests.filter(([, path]) => path.endsWith('/auth/v1/signup')).length, 1);
  assert.equal(requests.filter(([, path]) => path.endsWith('/auth/v1/logout')).length, 1);
  await backend.signOut();
  assert.equal((await studio.auth.getSession()).data.session.user.id, 'teacher');
  assert.equal((await backend.supabase.auth.getSession()).data.session, null);
  assert.equal(storage.values.get(legacy), 'legacy-untrusted-test-value');
  assert.ok(!storage.reads.includes(legacy));
  const logouts = requests.filter(([, path]) => path.endsWith('/auth/v1/logout'));
  assert.equal(logouts.length, 2);
  assert.ok(logouts.every(([, , scope]) => scope === 'local'));
  assert.ok(requests.every(([method, path]) => !(method === 'DELETE' && path.includes('/profiles'))));
});

test('wrong-role rejections sign out locally and never delete profiles', async () => {
  const calls = [];
  const client = {
    auth: {
      async signInWithPassword() { return { data: { user: { id: 'student' } }, error: null }; },
      async getUser() { return { data: { user: { id: 'student' } }, error: null }; },
      async signOut(options) { calls.push(['signOut', options]); return { error: null }; },
    },
    from(table) {
      assert.equal(table, 'profiles'); calls.push(['profileRead']);
      return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: { role: 'student' }, error: null }; } };
    },
  };
  const backend = await loadBackend(() => client);
  await assert.rejects(backend.signInTeacher('test@example.invalid', 'test-only'), /Schülerkonto/);
  await assert.rejects(backend.getCurrentUser(), /Schülerkonto/);
  assert.deepEqual(calls.filter(([kind]) => kind === 'signOut'), [['signOut', { scope: 'local' }], ['signOut', { scope: 'local' }]]);
  assert.equal(calls.filter(([kind]) => kind === 'profileRead').length, 2);
});

test('an explicit local sign-out error is propagated', async () => {
  const backend = await loadBackend(() => ({ auth: { async signOut(options) { assert.deepEqual(options, { scope: 'local' }); return { error: new Error('logout failed') }; } } }));
  await assert.rejects(backend.signOut(), /logout failed/);
});

test('a failed local logout aborts join without deleting profiles or creating a student identity', async () => {
  let signIns = 0;
  const backend = await loadBackend(() => ({
    auth: {
      async getSession() { return { data: { session: { user: { id: 'teacher', is_anonymous: false } } }, error: null }; },
      async signOut(options) { assert.deepEqual(options, { scope: 'local' }); return { error: new Error('logout failed') }; },
      async signInAnonymously() { signIns++; },
    },
    from() { assert.fail('no profile or other data must be touched'); },
  }));
  await assert.rejects(backend.joinClassSession('ABC', 'N'), /logout failed/);
  assert.equal(signIns, 0);
});

test('a stored student response exposes the reviewed flag without selecting score or feedback', async () => {
  let selected;
  const backend = await loadBackend(() => ({
    auth: { async getUser() { return { data: { user: { id: 'u', is_anonymous: true } }, error: null }; } },
    from(table) {
      assert.equal(table, 'student_responses');
      return {
        select(columns) { selected = columns.split(','); return this; },
        eq() { return this; },
        async maybeSingle() { return { data: { id: 'r', session_id: 's', slide_id: 'x', participant_id: 'u', reviewed: true }, error: null }; },
      };
    },
  }));
  const answer = await backend.getStudentResponse('s', 'x');
  assert.equal(answer.reviewed, true);
  assert.ok(selected.includes('reviewed'));
  assert.ok(!selected.includes('score') && !selected.includes('feedback'));
});
