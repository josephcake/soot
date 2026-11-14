/*
 * A fake model server on 127.0.0.1 for runner tests (ADR-039, ADR-040, ADR-049). It speaks
 * OpenAI Chat Completions (`/v1/chat/completions`, Bearer auth) by default, the Anthropic
 * Messages API (`/v1/messages`) with `{ format: 'anthropic' }`, Gemini generateContent
 * (`/v1beta/models/:id:generateContent`) with `{ format: 'gemini' }`, or OpenRouter Chat
 * Completions (including HTTP-200 `{error}` bodies) with `{ format: 'openrouter' }`.
 * No real provider and no real key is involved.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: {
    model: string;
    /** Normalised: Anthropic content blocks are joined into one string. */
    messages: { role: string; content: string }[];
    system?: unknown;
    [k: string]: unknown;
  };
}

export type FakeReply =
  | {
      readonly content: string;
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly finish?: string;
      /**
       * Reasoning tokens. `inside` (OpenAI's convention): part of completion_tokens.
       * `outside` (xAI's, seen live): reported separately, and only total_tokens includes them.
       */
      readonly reasoning?: { readonly tokens: number; readonly counted: 'inside' | 'outside' };
      /** Answer only after this many ms (a slow model). */
      readonly delayMs?: number;
    }
  | { readonly hang: true }
  | {
      readonly status: number;
      readonly error: string;
      /** OpenRouter: send HTTP 200 with `{error}` and no `choices`. */
      readonly inBody?: boolean;
      readonly errorCode?: number | string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export interface FakeOpenAi {
  readonly baseURL: string;
  readonly requests: FakeRequest[];
  /** Requests whose connection the client closed before an answer was sent. */
  readonly aborted: () => number;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });

interface RawBody {
  model?: string;
  messages?: { role: string; content: string | { type: string; text?: string }[] }[];
  contents?: { role?: string; parts?: { text?: string }[] }[];
  systemInstruction?: { parts?: { text?: string }[] };
  [k: string]: unknown;
}
const text = (c: string | { type: string; text?: string }[]): string =>
  typeof c === 'string' ? c : c.map((b) => b.text ?? '').join('');

const geminiModelId = (path: string): string => {
  const match = /\/models\/([^/:]+):/.exec(path);
  return match?.[1] ?? '';
};

const normalize = (raw: RawBody, path: string, format: string): FakeRequest['body'] => {
  if (format === 'gemini') {
    const messages = (raw.contents ?? []).map((c) => ({
      role: c.role === 'model' ? 'assistant' : 'user',
      content: (c.parts ?? []).map((part) => part.text ?? '').join(''),
    }));
    const system =
      raw.systemInstruction?.parts?.map((part) => part.text ?? '').join('') ?? raw.system;
    return { ...raw, model: geminiModelId(path), messages, system };
  }
  return {
    ...raw,
    model: raw.model ?? '',
    messages: (raw.messages ?? []).map((m) => ({ ...m, content: text(m.content) })),
  };
};

export async function startFakeOpenAi(
  reply: (req: FakeRequest, index: number) => FakeReply,
  options: {
    readonly format?: 'openai' | 'anthropic' | 'gemini' | 'openrouter';
    readonly listModels?: unknown;
  } = {},
): Promise<FakeOpenAi> {
  const format = options.format ?? 'openai';
  const anthropic = format === 'anthropic';
  const gemini = format === 'gemini';
  const requests: FakeRequest[] = [];
  const hanging = new Set<() => void>();
  let aborted = 0;
  const server: Server = createServer((req, res) => {
    let answered = false;
    res.on('close', () => {
      if (!answered) aborted++;
    });
    void readBody(req).then((raw) => {
      const path = req.url ?? '';
      const sendEarly = (
        status: number,
        payload: unknown,
        headers: Record<string, string> = {},
      ) => {
        if (res.destroyed) return;
        answered = true;
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (
        req.method === 'GET' &&
        (path.split('?')[0] === '/v1/models' || path.split('?')[0] === '/v1beta/models')
      ) {
        const listing = options.listModels ?? (gemini ? { models: [] } : { data: [] });
        sendEarly(200, listing);
        return;
      }
      const body = JSON.parse(raw === '' ? '{}' : raw) as RawBody;
      const r: FakeRequest = {
        path,
        authorization: req.headers.authorization,
        headers: req.headers,
        body: normalize(body, path, format),
      };
      requests.push(r);
      const out = reply(r, requests.length - 1);
      if ('hang' in out) {
        hanging.add(() => res.destroy());
        return;
      }
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        if (res.destroyed) return;
        answered = true;
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if ('status' in out) {
        const inBody = format === 'openrouter' && out.inBody === true;
        const payload = anthropic
          ? { type: 'error', error: { type: 'api_error', message: out.error } }
          : gemini
            ? { error: { code: out.status, message: out.error, status: 'UNKNOWN' } }
            : format === 'openrouter'
              ? { error: { code: out.errorCode ?? out.status, message: out.error } }
              : { error: { message: out.error } };
        send(inBody ? 200 : out.status, payload, out.headers ?? {});
        return;
      }
      const prompt = out.promptTokens ?? 100;
      const completion = out.completionTokens ?? 50;
      const payload = anthropic
        ? {
            id: `msg_${String(requests.length)}`,
            type: 'message',
            role: 'assistant',
            model: r.body.model,
            content: [{ type: 'text', text: out.content }],
            stop_reason: out.finish === 'length' ? 'max_tokens' : 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: prompt, output_tokens: completion },
          }
        : gemini
          ? {
              candidates: [
                {
                  content: { role: 'model', parts: [{ text: out.content }] },
                  finishReason: out.finish === 'length' ? 'MAX_TOKENS' : 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: prompt,
                candidatesTokenCount: completion,
                totalTokenCount: prompt + completion,
              },
              modelVersion: r.body.model,
            }
          : {
              id: `chatcmpl-${String(requests.length)}`,
              object: 'chat.completion',
              created: 1_800_000_000,
              model: r.body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: out.content },
                  finish_reason: out.finish ?? 'stop',
                },
              ],
              usage: {
                prompt_tokens: prompt,
                completion_tokens: completion,
                total_tokens:
                  prompt +
                  completion +
                  (out.reasoning?.counted === 'outside' ? out.reasoning.tokens : 0),
                ...(out.reasoning === undefined
                  ? {}
                  : { completion_tokens_details: { reasoning_tokens: out.reasoning.tokens } }),
              },
            };
      if (out.delayMs === undefined) send(200, payload);
      else {
        const t = setTimeout(() => {
          send(200, payload);
        }, out.delayMs);
        hanging.add(() => {
          clearTimeout(t);
          res.destroy();
        });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: gemini
      ? `http://127.0.0.1:${String(port)}/v1beta`
      : `http://127.0.0.1:${String(port)}/v1`,
    requests,
    aborted: () => aborted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const h of hanging) h();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The task id the runner put in its first user message (`Task <id>: ...`). */
export const taskIdOf = (r: FakeRequest): string =>
  /^Task ([a-z0-9-]+):/m.exec(r.body.messages.find((m) => m.role === 'user')?.content ?? '')?.[1] ??
  '';
