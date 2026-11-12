import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { interactiveApprovals, unattendedApprovals } from './index.js';

const req = (detail: string) => ({ taskId: 't', action: 'delete-files' as const, detail });

describe('CLI approvals', () => {
  it('asks one question at a time and only "y"/"yes" approves', async () => {
    const input = new PassThrough();
    const asked: string[] = [];
    const { gate, close } = interactiveApprovals({ input, ask: (l) => asked.push(l) });
    const a = gate.request(req('one'));
    const b = gate.request(req('two'));
    const c = gate.request(req('three'));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(1); // waits for the person
    input.write('yes\n');
    input.write('n\n');
    input.write('sure\n');
    expect(await Promise.all([a, b, c])).toEqual(['approved', 'denied', 'denied']);
    expect(asked.map((l) => /: (one|two|three)\n/.exec(l)?.[1])).toEqual(['one', 'two', 'three']);
    close();
  });

  it('end of input is a denial; unattended is always unavailable', async () => {
    const input = new PassThrough();
    const { gate, close } = interactiveApprovals({ input, ask: () => undefined });
    const pending = gate.request(req('x'));
    input.end();
    expect(await pending).toBe('denied');
    close();
    expect(await unattendedApprovals().request(req('x'))).toBe('unavailable');
  });
});
