import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const STREAM_IDLE_MS = Number(process.env.RELAY_UPSTREAM_TIMEOUT_MS || 90 * 1000);

function textOf(x) {
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

function mapFinish(fr) {
  if (fr === 'stop') return 'end_turn';
  if (fr === 'length') return 'max_tokens';
  if (fr === 'tool_calls') return 'tool_use';
  return 'end_turn';
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

export function toOpenAIRequest(a, model) {
  const messages = [];

  if (a.system) {
    messages.push({ role: 'system', content: textOf(a.system) });
  }

  for (const m of (a.messages || [])) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }

    if (!Array.isArray(m.content)) continue;

    const textBlocks = m.content.filter(b => b.type === 'text');
    const toolUseBlocks = m.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = m.content.filter(b => b.type === 'tool_result');

    const textStr = textBlocks.map(b => b.text).join('\n') || null;

    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: textStr };
      if (toolUseBlocks.length > 0) {
        msg.tool_calls = toolUseBlocks.map(block => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          },
        }));
      }
      messages.push(msg);
    } else {
      for (const block of toolResultBlocks) {
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: textOf(block.content),
        });
      }
      if (textStr) {
        messages.push({ role: 'user', content: textStr });
      }
    }
  }

  const req = { model, messages };

  if (a.max_tokens != null) req.max_tokens = a.max_tokens;
  if (a.temperature != null) req.temperature = a.temperature;
  if (a.top_p != null) req.top_p = a.top_p;
  if (a.stop_sequences != null) req.stop = a.stop_sequences;
  if (a.stream != null) req.stream = a.stream;
  if (a.stream === true) req.stream_options = { include_usage: true };

  if (a.tools) {
    req.tools = a.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }

  if (a.tool_choice) {
    const tc = a.tool_choice;
    if (tc.type === 'auto') req.tool_choice = 'auto';
    else if (tc.type === 'any') req.tool_choice = 'required';
    else if (tc.type === 'tool') req.tool_choice = { type: 'function', function: { name: tc.name } };
  }

  return req;
}

export function fromOpenAIResponse(o, model, reqID) {
  const choice = o.choices?.[0];
  const msg = choice?.message || {};
  const content = [];

  if (msg.content && typeof msg.content === 'string' && msg.content.length > 0) {
    content.push({ type: 'text', text: msg.content });
  }

  if (msg.tool_calls) {
    msg.tool_calls.forEach((tc, i) => {
      content.push({
        type: 'tool_use',
        id: tc.id || ('toolu_' + reqID + '_' + i),
        name: tc.function?.name || '',
        input: safeParse(tc.function?.arguments),
      });
    });
  }

  return {
    id: o.id || ('msg_' + reqID),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapFinish(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: o.usage?.prompt_tokens || 0,
      output_tokens: o.usage?.completion_tokens || 0,
    },
  };
}

export async function streamOpenAIToAnthropic(webBody, res, model, reqID) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
  });

  const send = (type, obj) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(obj) + '\n\n');

  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_' + reqID,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let nextBlock = 0;
  let textIdx = -1;
  let textOpen = false;
  const toolMap = new Map();
  let finish = null;
  let outTokens = 0;

  const nodeStream = Readable.fromWeb(webBody);
  const decoder = new StringDecoder('utf8');
  let buf = '';
  let idleTimer = setTimeout(() => nodeStream.destroy(new Error('stream idle timeout')), STREAM_IDLE_MS);
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => nodeStream.destroy(new Error('stream idle timeout')), STREAM_IDLE_MS);
  };

  const finalize = () => {
    clearTimeout(idleTimer);
    if (finish === null) {
      console.warn('[' + reqID + '] stream ended without finish_reason -> error');
      send('error', { type: 'error', error: { type: 'api_error', message: 'upstream stream ended prematurely' } });
      res.end();
      return;
    }
    if (textOpen) {
      send('content_block_stop', { type: 'content_block_stop', index: textIdx });
    }
    for (const bi of toolMap.values()) {
      send('content_block_stop', { type: 'content_block_stop', index: bi });
    }
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapFinish(finish), stop_sequence: null },
      usage: { output_tokens: outTokens },
    });
    send('message_stop', { type: 'message_stop' });
    res.end();
  };

  res.on('close', () => { clearTimeout(idleTimer); nodeStream.destroy(); });

  try {
    for await (const chunk of nodeStream) {
      bumpIdle();
      buf += decoder.write(chunk);
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).replace(/\r$/, '');
        if (payload === '[DONE]') {
          finalize();
          return;
        }

        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }

        if (parsed.error) {
          console.warn('[' + reqID + '] stream upstream error: ' + JSON.stringify(parsed.error).slice(0, 200));
          send('error', { type: 'error', error: { type: 'api_error', message: 'upstream stream error' } });
          res.end();
          return;
        }

        const d = parsed.choices?.[0]?.delta;
        const fr = parsed.choices?.[0]?.finish_reason;

        if (parsed.usage) {
          outTokens = parsed.usage.completion_tokens || outTokens;
        }

        if (d?.content && typeof d.content === 'string' && d.content.length > 0) {
          if (!textOpen) {
            textIdx = nextBlock++;
            send('content_block_start', {
              type: 'content_block_start',
              index: textIdx,
              content_block: { type: 'text', text: '' },
            });
            textOpen = true;
          }
          send('content_block_delta', {
            type: 'content_block_delta',
            index: textIdx,
            delta: { type: 'text_delta', text: d.content },
          });
        }

        if (d?.tool_calls) {
          for (const tc of d.tool_calls) {
            if (tc.index == null) continue;
            if (!toolMap.has(tc.index)) {
              if (textOpen) {
                send('content_block_stop', { type: 'content_block_stop', index: textIdx });
                textOpen = false;
              }
              const bi = nextBlock++;
              toolMap.set(tc.index, bi);
              send('content_block_start', {
                type: 'content_block_start',
                index: bi,
                content_block: {
                  type: 'tool_use',
                  id: tc.id || ('toolu_' + reqID + '_' + bi),
                  name: tc.function?.name || '',
                  input: {},
                },
              });
            }
            if (tc.function?.arguments && tc.function.arguments.length > 0) {
              send('content_block_delta', {
                type: 'content_block_delta',
                index: toolMap.get(tc.index),
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              });
            }
          }
        }

        if (fr) finish = fr;
      }
    }
    buf += decoder.end();
    finalize();
  } catch (e) {
    clearTimeout(idleTimer);
    console.warn('[' + reqID + '] stream crash: ' + e.message);
    if (!res.writableEnded) {
      try { send('error', { type: 'error', error: { type: 'api_error', message: 'upstream stream error' } }); } catch {}
      res.end();
    }
  }
}
