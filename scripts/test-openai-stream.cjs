const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readOpenAIResponseStream, OpenAIStreamFailure } = require('../out/runtime/openaiStream');

const event = value => `data: ${JSON.stringify(value)}\n\n`;
const body = (...chunks) => new ReadableStream({
  start(controller) {
    for (const chunk of chunks) { controller.enqueue(new TextEncoder().encode(chunk)); }
    controller.close();
  }
});
const parse = (...chunks) => readOpenAIResponseStream(body(...chunks));

test('streamed deltas and finalized text are assembled once', async () => {
  const delta1 = event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'NX con' });
  const delta2 = event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'nection works.' });
  const done = event({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'NX connection works.' });
  const completed = event({ type: 'response.completed', response: { output: [] } });
  const source = delta1 + delta2 + done + completed;
  const result = await parse(source.slice(0, 25), source.slice(25, 111), source.slice(111));
  assert.deepEqual(result.text, ['NX connection works.']);
});

test('streamed deltas survive a completion with no response output', async () => {
  const result = await parse(
    event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello, ' }),
    event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'world!' }),
    event({ type: 'response.completed', response: {} }));
  assert.deepEqual(result.text, ['Hello, world!']);
});

test('completed response output is a safe fallback when no text events arrive', async () => {
  const result = await parse(event({ type: 'response.completed', response: { output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Final response text.' }] }
  ] } }));
  assert.deepEqual(result.text, ['Final response text.']);
});

test('reasoning items are not assistant text', async () => {
  const result = await parse(event({ type: 'response.completed', response: { output: [
    { type: 'reasoning', encrypted_content: 'opaque-reasoning' },
    { type: 'message', content: [{ type: 'output_text', text: 'Visible answer.' }] }
  ] } }));
  assert.deepEqual(result.text, ['Visible answer.']);
  assert.equal(result.output[0].type, 'reasoning');
});

test('function call output is preserved and never treated as text', async () => {
  const call = { type: 'function_call', call_id: 'call-1', name: 'nx_read', arguments: '{"path":"a.txt"}' };
  const result = await parse(event({ type: 'response.output_item.done', output_index: 0, item: call }),
    event({ type: 'response.completed', response: {} }));
  assert.deepEqual(result.text, []);
  assert.deepEqual(result.output, [call]);
});

test('genuinely textless completion remains textless', async () => {
  const result = await parse(event({ type: 'response.completed', response: { output: [{ type: 'reasoning', encrypted_content: 'opaque' }] } }));
  assert.deepEqual(result.text, []);
});

for (const [kind, payload] of [
  ['failed', { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }],
  ['incomplete', { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }],
  ['error', { type: 'error', code: 'server_error', message: 'private diagnostic' }]
]) {
  test(`${kind} terminal event is rejected without exposing the payload`, async () => {
    await assert.rejects(parse(event(payload)), error => {
      assert.ok(error instanceof OpenAIStreamFailure);
      assert.equal(error.kind, kind);
      assert.equal(error.message.includes('private diagnostic'), false);
      return true;
    });
  });
}

test('interrupted stream without response.completed is rejected', async () => {
  await assert.rejects(parse(event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' })),
    error => error instanceof OpenAIStreamFailure && error.kind === 'interrupted');
});

test('UI-03 deltas publish before completion and done/final fallback never duplicate text', async () => {
  let controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const chunks = [];
  let first;
  const arrived = new Promise(resolve => { first = resolve; });
  let completed = false;
  const parsing = readOpenAIResponseStream(stream, text => { chunks.push(text); first(); }).then(result => { completed = true; return result; });
  controller.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello' })));
  await arrived;
  assert.equal(completed, false);
  controller.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hello world' }) +
    event({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hello world' }] }] } })));
  const result = await parsing;
  assert.deepEqual(chunks, ['Hello', ' world']);
  assert.deepEqual(result.text, ['Hello world']);
});

test('UI-03 completion-only text publishes while reasoning/function payloads stay internal', async () => {
  const chunks = [];
  await readOpenAIResponseStream(body(event({ type: 'response.completed', response: { output: [
    { type: 'reasoning', encrypted_content: 'PRIVATE' }, { type: 'function_call', arguments: 'PRIVATE' },
    { type: 'message', content: [{ type: 'output_text', text: 'Visible' }] }
  ] } })), text => chunks.push(text));
  assert.deepEqual(chunks, ['Visible']);
});

test('UI-03 interrupted stream retains published partial text and fails terminal validation', async () => {
  const chunks = [];
  await assert.rejects(readOpenAIResponseStream(body(event({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' })), text => chunks.push(text)),
    error => error.kind === 'interrupted');
  assert.deepEqual(chunks, ['partial']);
});

test('UI-03 sparse output_item.done indices do not duplicate an already streamed message', async () => {
  const chunks = [];
  const result = await readOpenAIResponseStream(body(
    event({ type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: 'Once' }),
    event({ type: 'response.output_item.done', output_index: 2, item: { type: 'message', content: [{ type: 'output_text', text: 'Once' }] } }),
    event({ type: 'response.completed', response: {} })), text => chunks.push(text));
  assert.deepEqual(result.text, ['Once']);
  assert.deepEqual(chunks, ['Once']);
});
