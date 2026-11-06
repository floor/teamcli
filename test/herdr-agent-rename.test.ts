// herdr's agent rename, as the adapter reads it: a name is true only when the call answered with
// the success envelope (`{id, result}`, the herdr api schema protocol 22) and the agent list the
// adapter itself reads back shows the pane under that name. An unparseable answer, another
// envelope, a herdr error, or a list that never shows the name are all false. A pane the list
// already shows under the name is not renamed again. Pane ids, names and answers are synthetic;
// no live herdr is asked.
import { afterEach, describe, expect, test } from 'bun:test';
import { agentRename, setHerdrCapture, setHerdrRun } from '../src/herdr.ts';

const PANE = 'fixture-pane-one';
const SEAT = 'fixture-seat';
const OTHER = 'fixture-other-seat';
const SESSION = 'fixture-session';
const WORKSPACE = 'fixture-workspace';

afterEach(() => {
  setHerdrRun(null);
  setHerdrCapture(null);
});

type Call = { args: string[]; session?: string };

/** One agent as herdr's `agent list` result carries it. */
function listing(...agents: { name: string | null; pane?: string }[]): unknown {
  return {
    agents: agents.map((agent) => ({
      pane_id: agent.pane ?? PANE,
      name: agent.name,
      workspace_id: WORKSPACE,
      agent: 'claude',
      agent_status: 'idle',
      cwd: '/work/acme',
    })),
  };
}

const EMPTY = listing();

/** The adapter's two answers: the list read before the rename (`before`), the list read after it
 *  (`after`), and the rename's stdout. The list read after defaults to the one before, so a pane
 *  the host never lists under the name stays unlisted. */
function world(input: { before?: unknown; after?: unknown; answer?: string | null }): {
  captures: Call[];
  lists: Call[];
} {
  const captures: Call[] = [];
  const lists: Call[] = [];
  setHerdrRun((args, session) => {
    if (args.join(' ') !== 'agent list') throw new Error(`unexpected herdr call: ${args.join(' ')}`);
    lists.push({ args, ...(session === undefined ? {} : { session }) });
    return lists.length === 1 ? input.before ?? EMPTY : input.after ?? input.before ?? EMPTY;
  });
  setHerdrCapture((args, session) => {
    captures.push({ args, ...(session === undefined ? {} : { session }) });
    return input.answer ?? null;
  });
  return { captures, lists };
}

const SUCCESS = JSON.stringify({ id: 'fixture-1', result: { name: SEAT } });

describe('agentRename', () => {
  test('a pane the list already shows under the name is not renamed again', () => {
    const made = world({ before: listing({ name: SEAT }), answer: SUCCESS });
    expect(agentRename(PANE, SEAT)).toBe(true);
    expect(made.captures).toHaveLength(0);
    expect(made.lists).toHaveLength(1);
  });

  test('an answer that is not the success envelope is never a name', () => {
    const answers = [
      '',
      'not json',
      JSON.stringify({ type: 'oops' }),
      JSON.stringify({ id: 'fixture-1', error: { code: 'agent_not_found', message: 'no such agent' } }),
    ];
    for (const answer of answers) {
      const made = world({ answer });
      expect(agentRename(PANE, SEAT)).toBe(false);
      expect(made.captures).toHaveLength(1);
    }
  });

  test('the success envelope is a name only when the list read after it shows the name', () => {
    const made = world({ after: listing({ name: SEAT }), answer: SUCCESS });
    expect(agentRename(PANE, SEAT)).toBe(true);
    expect(made.captures).toEqual([{ args: ['agent', 'rename', PANE, SEAT] }]);
    // One list read before the call, one after: the second is where the name is proved.
    expect(made.lists).toHaveLength(2);
  });

  test('the success envelope with no listed name is false', () => {
    const made = world({ after: listing({ name: null }), answer: SUCCESS });
    expect(agentRename(PANE, SEAT)).toBe(false);
    expect(made.captures).toHaveLength(1);
    expect(made.lists).toHaveLength(2);
  });

  test('a list that keeps another name is not this seat the name', () => {
    const made = world({ before: listing({ name: OTHER }), after: listing({ name: OTHER }), answer: SUCCESS });
    expect(agentRename(PANE, SEAT)).toBe(false);
  });

  test('the session the caller names is the session both calls ask', () => {
    const made = world({ after: listing({ name: SEAT }), answer: SUCCESS });
    expect(agentRename(PANE, SEAT, SESSION)).toBe(true);
    expect(made.captures).toEqual([{ args: ['agent', 'rename', PANE, SEAT], session: SESSION }]);
    expect(made.lists.every((call) => call.session === SESSION)).toBe(true);
  });
});
