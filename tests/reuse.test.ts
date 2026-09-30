import { describe, expect, it } from 'vitest';
import { factLines, factStubText, RAIL_TIERS, reuseFirstLines, reusedTokens, type Message } from '../src/index.js';

const listing = Array.from({ length: 200 }, (_, i) => `run job-${4100 + i} queued on worker`).join('\n');
const messages: Message[] = [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'jobs list' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: listing }] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b', tool: 'Bash', input: { command: 'jobs logs job-4150' } }] },
];

describe('reuse-first fact lines (Claude hook)', () => {
  it('finds a token an output introduced and a later tool input used', () => {
    const reused = reusedTokens(messages);
    expect(reused.has('job-4150')).toBe(true);
    expect(reused.has('job-4151')).toBe(false);
  });
  it('keeps the line the agent acted on in the stub', () => {
    const reused = reusedTokens(messages);
    expect(factLines(listing, 60).join('\n')).not.toContain('job-4150');
    expect(reuseFirstLines(listing, 60, reused).join('\n')).toContain('job-4150');
    expect(factStubText(listing, false, 300, 400, 'a', RAIL_TIERS[2], reused)).toContain('job-4150');
  });
});
