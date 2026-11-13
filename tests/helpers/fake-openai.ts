/*
 * A fake OpenAI-compatible Chat Completions server on 127.0.0.1 for runner tests (ADR-039).
 * No real provider and no real key is ever involved.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  readonly authorization: string | undefined;
  readonly body: {
    model: string;
    messages: { role: string; content: string }[];
    [k: string]: unknown;
  };
}

export type FakeReply =
  | {
      readonly content: string;
      readonly promptTokens?: number;
      readonly completionTokens?: number;
      readonly finish?: string;
    }
  | { readonly hang: true }
  | { readonly status: number; readonly error: string };

export interface FakeOpenAi {
  readonly baseURL: string;
  readonly requests: FakeRequest[];
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

export async function startFakeOpenAi(
  reply: (req: FakeRequest, index: number) => FakeReply,
): Promise<FakeOpenAi> {
  const requests: FakeRequest[] = [];
  const hanging = new Set<() => void>();
  const server: Server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const r: FakeRequest = {
        authorization: req.headers.authorization,
        body: JSON.parse(raw) as FakeRequest['body'],
      };
      requests.push(r);
      const out = reply(r, requests.length - 1);
      if ('hang' in out) {
        hanging.add(() => res.destroy());
        return;
      }
      if ('status' in out) {
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: out.error } }));
        return;
      }
      const prompt = out.promptTokens ?? 100;
      const completion = out.completionTokens ?? 50;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
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
            total_tokens: prompt + completion,
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${String(port)}/v1`,
    requests,
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
