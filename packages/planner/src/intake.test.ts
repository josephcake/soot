import { describe, expect, it } from 'vitest';
import { ContractValidationError } from '@soot/task-graph';
import { PromptIntakeError, createPromptIntake, promptBytes } from './index.js';

const fixedNow = () => new Date('2026-11-12T08:00:00.000Z');

describe('prompt intake (M1-02)', () => {
  it.each([
    ['plain ASCII', 'Change the page title to HELLO WORLD.'],
    ['leading/trailing whitespace and CRLF', '  line one\r\nline two\t \n\n'],
    ['unicode, emoji, and combining marks', 'Make it 💜 — café vs cafe\u0301, 日本語'],
    ['byte-order mark', '\uFEFFupdate the button'],
  ])('round-trips %s byte-for-byte', (_name, prompt) => {
    const intake = createPromptIntake({ prompt, now: fixedNow });
    expect(intake.originalPrompt).toBe(prompt);
    expect(Buffer.from(promptBytes(intake)).equals(Buffer.from(prompt, 'utf8'))).toBe(true);
  });

  it('round-trips raw UTF-8 bytes exactly, including a BOM', () => {
    const bytes = Buffer.from('\uFEFF  Ünïcode\r\n', 'utf8');
    const intake = createPromptIntake({ prompt: bytes });
    expect(Buffer.from(promptBytes(intake)).equals(bytes)).toBe(true);
  });

  it('identifies the prompt by the SHA-256 of its bytes (different bytes, different id)', () => {
    const a = createPromptIntake({ prompt: 'café' });
    const b = createPromptIntake({ prompt: 'cafe\u0301' }); // same glyphs, different bytes
    expect(a.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.promptSha256).not.toBe(b.promptSha256);
    expect(createPromptIntake({ prompt: 'café' }).promptSha256).toBe(a.promptSha256);
  });

  it('is deeply immutable', () => {
    const intake = createPromptIntake({
      prompt: 'Fix the bug',
      context: { references: [{ kind: 'issue', id: '#42' }] },
    });
    expect(Object.isFrozen(intake)).toBe(true);
    expect(() => {
      (intake as { originalPrompt: string }).originalPrompt = 'changed';
    }).toThrow(TypeError);
    expect(() => {
      const ref = intake.context.references?.[0] as { id: string };
      ref.id = '#43';
    }).toThrow(TypeError);
    expect(intake.originalPrompt).toBe('Fix the bug');
  });

  it('attaches validated project context', () => {
    const context = {
      name: 'demo-app',
      files: ['src/pages/index.html'],
      references: [{ kind: 'issue' as const, id: '#42', note: 'login loop' }],
      notes: 'React app',
    };
    expect(createPromptIntake({ prompt: 'x', context }).context).toEqual(context);
    expect(() => createPromptIntake({ prompt: 'x', context: { files: ['/abs'] } })).toThrow(
      ContractValidationError,
    );
    expect(() => createPromptIntake({ prompt: 'x', context: { secretKey: 'sk-...' } })).toThrow(
      /project context/,
    );
  });

  it('captures the intended outcome from the caller, or records that it is the prompt itself', () => {
    expect(
      createPromptIntake({ prompt: 'Do X', intendedOutcome: ' X is live ' }).intendedOutcome,
    ).toEqual({
      statement: 'X is live',
      source: 'user',
    });
    expect(createPromptIntake({ prompt: 'Do X' }).intendedOutcome).toEqual({
      statement: 'Do X',
      source: 'prompt',
    });
  });

  it('records when the prompt was received', () => {
    expect(createPromptIntake({ prompt: 'x', now: fixedNow }).receivedAt).toBe(
      '2026-11-12T08:00:00.000Z',
    );
  });

  it('rejects empty prompts, invalid UTF-8, and lone surrogates', () => {
    expect(() => createPromptIntake({ prompt: ' \n ' })).toThrow(PromptIntakeError);
    expect(() => createPromptIntake({ prompt: Uint8Array.from([0xc3, 0x28]) })).toThrow(
      /not valid UTF-8/,
    );
    expect(() => createPromptIntake({ prompt: 'bad \uD800 surrogate' })).toThrow(/surrogates/);
  });
});
