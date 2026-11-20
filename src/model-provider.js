import { RunError } from './core.js';

/**
 * @param {{providerName?: string, model?: string, apiKey?: string, env?: NodeJS.ProcessEnv}} [options]
 */
export function modelConfig({ providerName, model, apiKey, env = process.env } = {}) {
  const name = providerName ?? env.ATM_PROVIDER ?? 'openai';
  if (!['openai', 'tinker'].includes(name)) throw new RunError('ATM_PROVIDER/--provider must be openai or tinker.');
  const keyVariable = name === 'tinker' ? 'TINKER_API_KEY' : 'OPENAI_API_KEY';
  const key = apiKey ?? env[keyVariable];
  const selectedModel = model ?? env.ATM_MODEL;
  return {
    providerName: name,
    model: selectedModel,
    apiKey: key,
    keyVariable,
    configured: Boolean(key?.trim() && selectedModel?.trim()),
    label: name === 'tinker' ? 'Tinker Messages API' : 'OpenAI Responses API',
  };
}

export function requireModelConfig(options) {
  const config = modelConfig(options);
  if (!config.configured)
    throw new RunError(`Configure ${config.keyVariable} and --model or ATM_MODEL for ${config.providerName}.`);
  return config;
}

// OpenAI structured output (strict + required:[all]) always returns every field;
// the Tinker Messages API does not force the model to populate omitted fields.
// Backfill schema-declared string properties the model left out, defaulting them
// to '' so the strict validator sees the same shape OpenAI would produce. Drive
// this purely from the tool's own schema: no contract-specific field names here.
// A missing discriminator backfilled to '' still fails the validator's enum check,
// so semantic validation is unchanged.
function backfillStringFields(schema, input) {
  const properties = schema?.properties;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !properties) return input;
  const result = { ...input };
  for (const [key, definition] of Object.entries(properties))
    if (definition?.type === 'string' && !Object.hasOwn(result, key)) result[key] = '';
  return result;
}

// This adapter accepts structured tool calls only. Page text never becomes an
// executable command, and provider bodies/errors are never copied into reports.
export function tinkerToolProvider({
  apiKey,
  model,
  tool,
  instructions,
  maxOutputTokens,
  validate,
  fetchImpl = fetch,
}) {
  ({ apiKey, model } = requireModelConfig({ providerName: 'tinker', apiKey, model }));
  return async ({ input, signal }) => {
    let response;
    try {
      response = await fetchImpl('https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1/messages', {
        method: 'POST',
        signal,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: maxOutputTokens,
          system: instructions,
          messages: [{ role: 'user', content: input }],
          tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }],
          tool_choice: { type: 'tool', name: tool.name, disable_parallel_tool_use: true },
        }),
      });
    } catch {
      throw new RunError(signal?.aborted ? 'Tinker request canceled or timed out.' : 'Could not reach Tinker.');
    }
    if (!response.ok) throw new RunError(`Tinker returned HTTP ${response.status}.`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new RunError('Tinker returned an invalid response.');
    }
    const counts = [
      body?.usage?.input_tokens,
      body?.usage?.output_tokens,
      body?.usage?.cache_read_input_tokens ?? 0,
      body?.usage?.cache_creation_input_tokens ?? 0,
    ];
    const total = counts.reduce((sum, count) => sum + count, 0);
    const tokens =
      counts.every(count => Number.isSafeInteger(count) && count >= 0) && Number.isSafeInteger(total)
        ? total
        : undefined;
    const failure = message => Object.assign(new RunError(message), tokens === undefined ? {} : { tokens });
    const calls = Array.isArray(body?.content) ? body.content.filter(item => item?.type === 'tool_use') : [];
    if (body?.stop_reason !== 'tool_use' || calls.length !== 1 || calls[0].name !== tool.name)
      throw failure('Tinker did not complete exactly one supported action.');
    let action;
    try {
      action = validate(backfillStringFields(tool.parameters, calls[0].input));
    } catch {
      throw failure('Tinker returned an invalid action.');
    }
    if (tokens === undefined) throw new RunError('Tinker omitted valid token accounting.');
    return {
      action,
      tokens,
      usage: { input_tokens: counts[0], output_tokens: counts[1], total_tokens: tokens },
      responseId: typeof body.id === 'string' ? body.id : undefined,
    };
  };
}

export function openAIToolProvider({
  apiKey,
  model,
  tool,
  instructions,
  maxOutputTokens,
  validate,
  fetchImpl = fetch,
}) {
  if (!apiKey || !model) throw new RunError('OpenAI requires OPENAI_API_KEY and an explicit model.');
  return async ({ input, signal }) => {
    let response;
    try {
      response = await fetchImpl('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          store: false,
          instructions,
          input,
          tools: [tool],
          tool_choice: { type: 'function', name: tool.name },
          parallel_tool_calls: false,
          max_output_tokens: maxOutputTokens,
        }),
      });
    } catch {
      throw new RunError(signal?.aborted ? 'OpenAI request canceled or timed out.' : 'Could not reach OpenAI.');
    }
    if (!response.ok) throw new RunError(`OpenAI returned HTTP ${response.status}.`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new RunError('OpenAI returned an invalid response.');
    }
    const total = body?.usage?.total_tokens;
    const tokens = Number.isSafeInteger(total) && total >= 0 ? total : undefined;
    const failure = message => Object.assign(new RunError(message), tokens === undefined ? {} : { tokens });
    const calls = Array.isArray(body?.output) ? body.output.filter(item => item?.type === 'function_call') : [];
    if (body?.status !== 'completed' || calls.length !== 1 || calls[0].name !== tool.name)
      throw failure('OpenAI did not complete exactly one supported action.');
    let action;
    try {
      action = validate(JSON.parse(calls[0].arguments));
    } catch {
      throw failure('OpenAI returned an invalid action.');
    }
    return {
      action,
      tokens,
      usage: body.usage,
      responseId: typeof body.id === 'string' ? body.id : undefined,
    };
  };
}

export const toolProvider = options =>
  (options.providerName === 'tinker' ? tinkerToolProvider : openAIToolProvider)(options);
