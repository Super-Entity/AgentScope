import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseAndOpenScopedChat, ScopedChatDependencies, ScopedChatEntry } from '../chatEntry';

const entries = (): ScopedChatEntry[] => [
  { name: 'Writing', profileName: 'agentscope-writing' },
  { name: 'Review', profileName: 'agentscope-review' },
];

function dependencies(events: string[]): ScopedChatDependencies {
  return {
    choose: async (available) => { events.push('choose'); return available[1]; },
    publish: async () => { events.push('publish'); },
    open: async () => { events.push('open'); },
    guide: async (entry) => { events.push(`guide:${entry.profileName}`); },
  };
}

test('Scoped chat cancellation does not publish profiles or open a chat', async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.choose = async () => { events.push('choose'); return undefined; };
  assert.equal(await chooseAndOpenScopedChat(entries(), deps), false);
  assert.deepEqual(events, ['choose']);
});

test('Scoped chat publishes before opening and then guides manual native profile selection', async () => {
  const events: string[] = [];
  const available = entries();
  const deps = dependencies(events);
  deps.choose = async (offered) => {
    events.push('choose');
    assert.deepEqual(offered, available);
    return { ...offered[1] };
  };
  assert.equal(await chooseAndOpenScopedChat(available, deps), true);
  assert.deepEqual(events, ['choose', 'publish', 'open', 'guide:agentscope-review']);
  assert.deepEqual(available, entries());
});

test('Scoped chat publication failure propagates without opening or guiding', async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  const failure = new Error('Configuration changed');
  deps.publish = async () => { events.push('publish'); throw failure; };
  await assert.rejects(chooseAndOpenScopedChat(entries(), deps), (error) => error === failure);
  assert.deepEqual(events, ['choose', 'publish']);
});

test('Scoped chat rejects an unavailable selection before publication', async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.choose = async () => ({ name: 'Other', profileName: 'agentscope-review' });
  await assert.rejects(chooseAndOpenScopedChat(entries(), deps), /selected preset changed or is no longer available/);
  assert.deepEqual(events, []);
});

test('Scoped chat rejects a stale profile mapping before publication', async () => {
  const events: string[] = [];
  const available = entries();
  const deps = dependencies(events);
  deps.choose = async (offered) => {
    available[1].profileName = 'agentscope-review-updated';
    return offered[1];
  };
  await assert.rejects(chooseAndOpenScopedChat(available, deps), /selected preset changed or is no longer available/);
  assert.deepEqual(events, []);
});

test('Scoped chat does not trust mutations to entries offered to the picker', async () => {
  const events: string[] = [];
  const available = entries();
  const deps = dependencies(events);
  deps.choose = async (offered) => {
    offered[1].profileName = ':danger-full-access';
    return offered[1];
  };
  await assert.rejects(chooseAndOpenScopedChat(available, deps), /selected preset changed or is no longer available/);
  assert.deepEqual(available, entries());
  assert.deepEqual(events, []);
});

test('Scoped chat open failure propagates without displaying successful guidance', async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  const failure = new Error('Codex command is unavailable');
  deps.open = async () => { events.push('open'); throw failure; };
  await assert.rejects(chooseAndOpenScopedChat(entries(), deps), (error) => error === failure);
  assert.deepEqual(events, ['choose', 'publish', 'open']);
});
