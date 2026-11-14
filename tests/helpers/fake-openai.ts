/*
 * A fake model server on 127.0.0.1 for runner tests (ADR-039, ADR-040). It speaks OpenAI Chat
 * Completions (`/v1/chat/completions`, Bearer auth) by default, or the Anthropic Messages API
 * (`/v1/messages`, x-api-key and anthropic-version headers, content blocks, input_tokens /
 * output_tokens) with `{ format: 'anthropic' }`. No real provider and no real key is involved.
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
  | { readonly status: number; readonly error: string };

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
  model: string;
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
  [k: string]: unknown;
}
const text = (c: string | { type: string; text?: string }[]): string =>
  typeof c === 'string' ? c : c.map((b) => b.text ?? '').join('');

export async function startFakeOpenAi(
  reply: (req: FakeRequest, index: number) => FakeReply,
  options: { readonly format?: 'openai' | 'anthropic' } = {},
): Promise<FakeOpenAi> {
  const anthropic = options.format === 'anthropic';
  const requests: FakeRequest[] = [];
  const hanging = new Set<() => void>();
  let aborted = 0;
  const server: Server = createServer((req, res) => {
    let answered = false;
    res.on('close', () => {
      if (!answered) aborted++;
    });
    void readBody(req).then((raw) => {
      const body = JSON.parse(raw) as RawBody;
      const r: FakeRequest = {
        path: req.url ?? '',
        authorization: req.headers.authorization,
        headers: req.headers,
        body: { ...body, messages: body.messages.map((m) => ({ ...m, content: text(m.content) })) },
      };
      requests.push(r);
      const out = reply(r, requests.length - 1);
      if ('hang' in out) {
        hanging.add(() => res.destroy());
        return;
      }
      const send = (status: number, payload: unknown) => {
        if (res.destroyed) return;
        answered = true;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if ('status' in out) {
        send(
          out.status,
          anthropic
            ? { type: 'error', error: { type: 'api_error', message: out.error } }
            : { error: { message: out.error } },
        );
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
    baseURL: `http://127.0.0.1:${String(port)}/v1`,
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
