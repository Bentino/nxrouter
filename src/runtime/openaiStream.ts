/** Parses the public Responses API SSE stream without retaining raw event payloads. */
export interface OpenAIOutputItem {
  id?: string;
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
}

export class OpenAIStreamFailure extends Error {
  constructor(readonly kind: 'failed' | 'incomplete' | 'error' | 'interrupted' | 'malformed', readonly code?: string) {
    super(kind === 'incomplete' ? 'OpenAI response was incomplete. Retry the request.' :
      kind === 'interrupted' ? 'OpenAI response ended before completion.' :
      kind === 'malformed' ? 'OpenAI response stream was invalid.' : 'OpenAI response failed. Retry the request.');
  }
}

interface TextSlot { delta: string; done?: string; emitted?: string }
interface ResponseEvent {
  type?: string;
  output_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
  item?: OpenAIOutputItem;
  response?: { output?: OpenAIOutputItem[]; error?: { code?: string } };
  code?: string;
}

export interface OpenAIStreamResult { text: string[]; output: OpenAIOutputItem[] }

export async function readOpenAIResponseStream(body: ReadableStream<Uint8Array>, onText?: (text: string) => void): Promise<OpenAIStreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const slots = new Map<string, TextSlot>();
  const outputItems = new Map<number, OpenAIOutputItem>();
  let buffer = '';
  let completed: ResponseEvent['response'];
  let terminal = false;
  const key = (outputIndex: number, contentIndex: number) => `${outputIndex}:${contentIndex}`;
  const publish = (slot: TextSlot, text: string): void => {
    if (!onText) { return; }
    const emitted = slot.emitted ?? '';
    if (!text.startsWith(emitted)) { throw new OpenAIStreamFailure('malformed'); }
    if (text.length > emitted.length) { onText(text.slice(emitted.length)); }
    slot.emitted = text;
  };
  const accept = (frame: string): void => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') { return; }
    let event: ResponseEvent;
    try { event = JSON.parse(data) as ResponseEvent; } catch { throw new OpenAIStreamFailure('malformed'); }
    if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      if (!Number.isInteger(event.output_index) || !Number.isInteger(event.content_index)) { throw new OpenAIStreamFailure('malformed'); }
      const id = key(event.output_index!, event.content_index!);
      const slot = slots.get(id) ?? { delta: '' };
      if (event.type === 'response.output_text.delta') {
        if (typeof event.delta !== 'string') { throw new OpenAIStreamFailure('malformed'); }
        slot.delta += event.delta;
        publish(slot, slot.delta);
      } else {
        if (typeof event.text !== 'string') { throw new OpenAIStreamFailure('malformed'); }
        slot.done = event.text;
        publish(slot, slot.done);
      }
      slots.set(id, slot);
    } else if (event.type === 'response.output_item.done') {
      if (Number.isInteger(event.output_index) && event.item && typeof event.item === 'object') {
        outputItems.set(event.output_index!, event.item);
      }
    } else if (event.type === 'response.completed') {
      if (!event.response || typeof event.response !== 'object') { throw new OpenAIStreamFailure('malformed'); }
      completed = event.response;
      terminal = true;
    } else if (event.type === 'response.failed') {
      throw new OpenAIStreamFailure('failed', event.response?.error?.code);
    } else if (event.type === 'response.incomplete') {
      throw new OpenAIStreamFailure('incomplete', event.response?.error?.code);
    } else if (event.type === 'error') {
      throw new OpenAIStreamFailure('error', event.code);
    }
  };
  try {
    while (!terminal) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) { accept(frame); if (terminal) { break; } }
      if (chunk.done) { if (buffer.trim()) { accept(buffer); } break; }
    }
    if (!completed) { throw new OpenAIStreamFailure('interrupted'); }
    const entries: Array<[number, OpenAIOutputItem]> = Array.isArray(completed.output) && completed.output.length
      ? completed.output.map((item, index) => [index, item]) : [...outputItems.entries()].sort(([a], [b]) => a - b);
    const output = entries.map(([, item]) => item);
    const text: string[] = [];
    const used = new Set<string>();
    entries.forEach(([outputIndex, item]) => {
      if (item.type !== 'message' || !Array.isArray(item.content)) { return; }
      item.content.forEach((content, contentIndex) => {
        if (content.type !== 'output_text') { return; }
        const id = key(outputIndex, contentIndex);
        const slot = slots.get(id);
        const value = slot?.done ?? slot?.delta ?? content.text;
        if (typeof value === 'string' && value) { text.push(value); publish(slot ?? { delta: '' }, value); }
        used.add(id);
      });
    });
    for (const [id, slot] of [...slots.entries()].sort(([a], [b]) => {
      const [ao, ac] = a.split(':').map(Number), [bo, bc] = b.split(':').map(Number);
      return ao - bo || ac - bc;
    })) {
      if (!used.has(id)) { const value = slot.done ?? slot.delta; if (value) { text.push(value); } }
    }
    return { text, output };
  } finally { try { await reader.cancel(); } catch { /* The stream may already be closed. */ } reader.releaseLock(); }
}
