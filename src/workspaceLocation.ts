import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** A selected folder disappeared or was replaced by something other than a directory. */
export class WorkspaceLocationError extends Error {
  readonly code = 'WORKSPACE_LOCATION_UNAVAILABLE';

  constructor(readonly root: string, readonly reason: 'missing' | 'not-directory', cause?: unknown) {
    super(`${reason === 'missing' ? 'The workspace folder no longer exists' : 'The workspace location is not a directory'}: ${root}. ` +
      'Reopen the folder at its current location in VS Code, then start a new Codex chat. ' +
      'Existing chats keep their original working directory. If Codex runs in WSL, check that its Linux workspace path also matches the new location.',
    cause === undefined ? undefined : { cause });
    this.name = 'WorkspaceLocationError';
  }
}

/**
 * Diagnose a moved folder without choosing another location or changing trust.
 * Identity and link-containment guards remain the caller's responsibility.
 */
export async function assertWorkspaceLocation(root: string): Promise<void> {
  const selected = path.resolve(root);
  let info;
  try { info = await fs.stat(selected); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new WorkspaceLocationError(selected, 'missing', error);
    throw error;
  }
  if (!info.isDirectory()) throw new WorkspaceLocationError(selected, 'not-directory');
}
