import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelConfig, requireModelConfig } from '../src/model-provider.js';
import { discoveryProvider } from '../src/discovery.js';
import { publicProvider } from '../src/agent.js';
import { cleanEnvironment } from '../src/process.js';
import { Run } from '../src/core.js';
import { Dashboard } from '../src/dashboard.js';

const action = {
  action: 'finish',
  target: '',
  value: '',
  title: '',
  reason: 'No app connected.',
  expectation: '',
  text: '',
};
const input = {
  observation: {},
  history: [],
  investigations: [],
  memory: [],
  remaining: {},
  signal: new AbortController().signal,
};
const body = () => ({
  id: 'msg-test',
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'tool_use', name: 'investigate_application', input: action },
  ],
  usage: { input_tokens: 17, output_tokens: 9 },
});
const provider = (reply = body(), fetchImpl = async () => ({ ok: true, json: async () => reply })) =>
  discoveryProvider({ providerName: 'tinker', apiKey: 'test-only-key', model: 'thinkingmachines/Inkling', fetchImpl });

test('provider config is explicit, defaults to OpenAI and selects only the matching key', () => {
  assert.equal(modelConfig({ env: {} }).providerName, 'openai');
  const env = {
    ATM_PROVIDER: 'tinker',
    ATM_MODEL: 'thinkingmachines/Inkling',
    TINKER_API_KEY: 'local-secret',
    OPENAI_API_KEY: 'other-secret',
  };
  assert.equal(requireModelConfig({ env }).apiKey, 'local-secret');
  assert.equal(modelConfig({ env, providerName: 'openai' }).apiKey, 'other-secret');
  assert.equal(modelConfig({ env: { ...env, TINKER_API_KEY: '' } }).configured, false);
  assert.throws(
    () => requireModelConfig({ env: { OPENAI_API_KEY: 'wrong', ATM_PROVIDER: 'tinker', ATM_MODEL: 'model' } }),
    /TINKER_API_KEY/,
  );
  assert.throws(() => modelConfig({ env, providerName: 'typo' }), /openai or tinker/);
  assert.throws(() => requireModelConfig({ env: { TINKER_API_KEY: 'secret', ATM_PROVIDER: 'tinker' } }), /ATM_MODEL/);
});

test('Tinker sends bounded Messages tool requests and normalizes token usage', async () => {
  let payload;
  const decide = provider(body(), async (url, options) => {
    assert.equal(url, 'https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1/messages');
    assert.equal(options.headers['x-api-key'], 'test-only-key');
    assert.equal(options.signal, input.signal);
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => body() };
  });
  const result = await decide(input);
  assert.deepEqual(result.action, action);
  assert.equal(result.tokens, 26);
  assert.equal(payload.model, 'thinkingmachines/Inkling');
  assert.equal(payload.max_tokens, 2000);
  assert.equal(payload.tools[0].input_schema.additionalProperties, false);
  assert.deepEqual(payload.tool_choice, {
    type: 'tool',
    name: 'investigate_application',
    disable_parallel_tool_use: true,
  });
  assert.equal(JSON.parse(payload.messages[0].content).goal, undefined);
  assert.equal(payload.system.includes('untrusted'), true);
  assert.equal(JSON.stringify(payload).includes('test-only-key'), false);
  assert.equal(JSON.stringify(result).includes('private reasoning'), false);
});

test('Tinker rejects truncated, duplicate, foreign and malformed actions', async () => {
  for (const mutate of [
    b => {
      b.stop_reason = 'max_tokens';
    },
    b => {
      b.content.push(b.content[1]);
    },
    b => {
      b.content[1].name = 'execute_shell';
    },
    b => {
      b.content[1].input = { ...action, command: 'arbitrary' };
    },
    b => {
      b.content = [{ type: 'text', text: JSON.stringify(action) }];
    },
  ]) {
    const b = body();
    mutate(b);
    await assert.rejects(provider(b)(input), e => e.status === 'inconclusive');
  }
  await assert.rejects(provider(null)(input), /supported action/);
});

test('Tinker requires token accounting, including cache usage when reported', async () => {
  for (const usage of [
    undefined,
    {},
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 1.5 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -1 },
  ]) {
    await assert.rejects(provider({ ...body(), usage })(input), /token accounting/);
  }
  const result = await provider({
    ...body(),
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 },
  })(input);
  assert.equal(result.tokens, 65);
});

test('provider failures never echo response bodies or transport errors containing keys', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 401, text: async () => 'test-only-key' }),
    async () => {
      throw new Error('bad x-api-key: test-only-key');
    },
    async () => ({
      ok: true,
      json: async () => {
        throw new Error('test-only-key');
      },
    }),
  ])
    await assert.rejects(
      provider(undefined, fetchImpl)(input),
      e => e.status === 'inconclusive' && !e.message.includes('test-only-key'),
    );
  const signal = AbortSignal.abort();
  await assert.rejects(
    provider(undefined, async () => {
      throw new Error();
    })({ ...input, signal }),
    /canceled/,
  );
});

test('public journey uses the same Tinker adapter and strict action validation', async () => {
  const decide = publicProvider({
    providerName: 'tinker',
    apiKey: 'test',
    model: 'tinker://custom/checkpoint',
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(request.body);
      assert.equal(payload.max_tokens, 800);
      assert.equal(payload.model, 'tinker://custom/checkpoint');
      assert.equal(payload.tools[0].name, 'browser_action');
      return {
        ok: true,
        json: async () => ({
          ...body(),
          content: [{ type: 'tool_use', name: 'browser_action', input: { action: 'done', role: 'link', name: '' } }],
        }),
      };
    },
  });
  assert.equal((await decide(input)).action.action, 'done');
});

test('Tinker keys stay out of child environments and dashboard snapshots', async t => {
  const previous = process.env.TINKER_API_KEY;
  process.env.TINKER_API_KEY = 'local-test-secret';
  t.after(() => {
    if (previous === undefined) delete process.env.TINKER_API_KEY;
    else process.env.TINKER_API_KEY = previous;
  });
  assert.equal(cleanEnvironment().TINKER_API_KEY, undefined);
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-tinker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = new Dashboard({ repo: root, root, providerName: 'tinker', model: 'thinkingmachines/Inkling' });
  await app.initialize();
  t.after(() => app.close());
  const snapshot = await app.snapshot();
  assert.equal(snapshot.project.aiConfigured, true);
  assert.equal(snapshot.project.provider, 'tinker');
  assert.equal(JSON.stringify(snapshot).includes('local-test-secret'), false);
});

test('dashboard launches discovery with the selected provider and rejects a missing Tinker key', async t => {
  const previous = process.env.TINKER_API_KEY;
  process.env.TINKER_API_KEY = 'test-only';
  t.after(() => {
    if (previous === undefined) delete process.env.TINKER_API_KEY;
    else process.env.TINKER_API_KEY = previous;
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-tinker-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let received;
  const app = new Dashboard({
    repo: root,
    root,
    providerName: 'tinker',
    model: 'thinkingmachines/Inkling',
    resolve: async () => 'a'.repeat(40),
    explorer: async options => {
      received = options;
      const run = await Run.create(root, {}, ['done']);
      options.onCreated(run);
      await run.step('done', async () => ({}));
      await run.finish();
    },
  });
  await app.initialize();
  t.after(() => app.close());
  await app.start({ mode: 'exploration' });
  await app.active?.completion;
  assert.equal(received.providerName, 'tinker');
  assert.equal(received.model, 'thinkingmachines/Inkling');
  delete process.env.TINKER_API_KEY;
  await assert.rejects(app.start({ mode: 'exploration' }), /TINKER_API_KEY/);
});

test('rejected and truncated Tinker actions retain valid usage on the error', async () => {
  const malformed = body();
  malformed.content[1].input = { ...action, extra: 'unsupported' };
  for (const reply of [malformed, { ...body(), stop_reason: 'max_tokens' }]) {
    await assert.rejects(provider(reply)(input), e => e.tokens === 26 && e.status === 'inconclusive');
  }
});

test('Tinker backfills missing schema string fields so strict validation passes', async () => {
  const reply = body();
  // A well-formed action whose meaningful fields are present but several
  // schema-declared string fields were omitted by the model.
  reply.content[1].input = { action: 'finish', reason: 'No app connected.', value: '', target: '' };
  const result = await provider(reply)(input);
  assert.deepEqual(result.action, {
    action: 'finish',
    target: '',
    value: '',
    title: '',
    reason: 'No app connected.',
    expectation: '',
    text: '',
  });
  assert.equal(result.tokens, 26);
});

test('Tinker backfill does not mask a missing discriminator', async () => {
  const reply = body();
  reply.content[1].input = { reason: 'because' };
  await assert.rejects(
    provider(reply)(input),
    e => /Tinker returned an invalid action\./.test(e.message) && e.status === 'inconclusive' && e.tokens === 26,
  );
});

test('OpenAI transport, malformed and unaccounted responses stay inconclusive without echoing the key', async () => {
  const openai = fetchImpl =>
    discoveryProvider({ providerName: 'openai', apiKey: 'sk-test-only-key', model: 'test-model', fetchImpl });
  const reply = (value, ok = true) => openai(async () => ({ ok, status: 500, json: async () => value }));
  const call = { type: 'function_call', name: 'investigate_application', arguments: JSON.stringify(action) };
  for (const [decide, pattern] of [
    [
      openai(async () => {
        throw new Error('connect ECONNREFUSED sk-test-only-key');
      }),
      /Could not reach OpenAI/,
    ],
    [openai(async () => ({ ok: true, json: async () => JSON.parse('{') })), /invalid response/],
    [reply({ status: 'incomplete', output: [call] }), /exactly one supported action/],
    [reply({ status: 'completed', output: [{ ...call, arguments: '{}' }] }), /invalid action/],
    [reply({ status: 'completed', output: [call] }), /omitted token accounting/],
    [reply({}, false), /HTTP 500/],
  ])
    await assert.rejects(
      decide(input),
      error => pattern.test(error.message) && error.status === 'inconclusive' && !error.message.includes('sk-test'),
    );
  for (const value of [
    { status: 'incomplete', output: [call], usage: { total_tokens: 7 } },
    { status: 'completed', output: [{ ...call, arguments: '{}' }], usage: { total_tokens: 7 } },
  ])
    await assert.rejects(reply(value)(input), error => error.tokens === 7);
  const decision = await reply({ status: 'completed', output: [call], usage: { total_tokens: 12 } })(input);
  assert.equal(decision.tokens, 12);
  assert.deepEqual(decision.action, action);
});
