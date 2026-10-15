export interface ScopedChatEntry {
  name: string;
  profileName: string;
}

export interface ScopedChatDependencies {
  choose(entries: ScopedChatEntry[]): Promise<ScopedChatEntry | undefined>;
  publish(): Promise<void>;
  open(): Promise<void>;
  /** Ask the user to select this profile in Codex's permissions menu before sending. */
  guide(entry: ScopedChatEntry): Promise<void>;
}

/**
 * Prepare named profiles before opening the native Codex chat.
 * Codex's public new-chat command cannot bind a permission profile, so callers
 * must explain the required manual selection in guide().
 */
export async function chooseAndOpenScopedChat(
  entries: ScopedChatEntry[],
  deps: ScopedChatDependencies,
): Promise<boolean> {
  const offered = entries.map(({ name, profileName }) => ({ name, profileName }));
  const selection = await deps.choose(offered.map((entry) => ({ ...entry })));
  if (!selection) return false;

  const matches = (entry: ScopedChatEntry): boolean =>
    entry.name === selection.name && entry.profileName === selection.profileName;
  const selected = offered.find(matches);
  if (!selected || !entries.some(matches)) {
    throw new Error('The selected preset changed or is no longer available. Choose it again.');
  }

  await deps.publish();
  await deps.open();
  await deps.guide({ ...selected });
  return true;
}
