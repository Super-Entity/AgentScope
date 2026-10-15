<h1>
  <img src="media/icon.png" alt="AgentScope" width="96" align="middle" />
  &nbsp;&nbsp;&nbsp;AgentScope
</h1>


Manage Read and Write access, project instructions and Explorer visibility from a single VS Code panel. AgentScope works with local folders, Git submodules and multi-root workspaces on Windows, macOS and Linux, including VS Code running in WSL.

## Features

- Select projects, folders or individual files with separate Read and Write checkboxes.
- Manage workspace files outside registered projects without enabling those projects.
- Choose an additional instruction file for each project.
- Hide folders in Explorer and Search independently of access permissions.
- Save named presets and switch between them.
- Preview configuration changes before applying them, and restore the previous configuration.
- Recover saved policies after deletion or corruption, or start a fresh access configuration.

## Install

Install [AgentScope from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=SuperEntity.agentscope). In VS Code's Extensions view, search for `AgentScope`, choose the extension published by **SuperEntity**, and select **Install**. Marketplace installations update automatically when Auto Update is enabled.

You can also download a VSIX from [GitHub Releases](https://github.com/Super-Entity/AgentScope/releases). You do not need Node.js or npm to install or use it.

1. Open a release and download the file ending in `.vsix` from **Assets**.
2. In VS Code, open the Command Palette and run **Extensions: Install from VSIX…**.
3. Select the downloaded file and reload the window if prompted.

VS Code 1.95 or later is required. To update a VSIX installation, download a newer package and install it the same way.

You can also install from the folder containing the downloaded package with VS Code's CLI:

```sh
code --install-extension agentscope-0.7.6.vsix
```

## Getting started

1. Open a local workspace and select AgentScope in the Activity Bar. In a multi-root workspace, use **Select workspace** to choose the folder to configure.
2. A new container workspace, such as a folder holding several apps, lists its immediate ordinary folders as disabled projects. Git submodules are discovered when `.gitmodules` exists. An individual Git repository or a folder with a project manifest starts with its own disabled root instead. Use **Add folder** to register one or more other workspace folders; Git is optional.
3. Expand a project and check **Read** or **Write** for the paths it needs. A folder selection includes descendants; a mixed checkbox means only some paths are selected. Write also allows Read.
4. Use **Workspace files** for supporting files outside registered projects. Its parent checkboxes select all currently available resources. Use **Hide/Show** to change visibility separately.
5. Open **Preview**, choose a changed configuration file, and review the comparison. The current file is on the left; the proposed version is on the right.
6. Select **Apply** to save the draft. Start a new agent session to load changes to its instructions or permission profile.

Hover over toolbar icons for their labels. Folder arrows expand individual rows; **Collapse all** folds the tree without changing selections.

For example, opening `MyApps` with `frontend/`, `backend/` and `docs/` lets you choose access for each folder independently. Opening a single project lets you expand its root and choose `src/`, `tests/` or individual files. Existing saved project registrations and access choices are preserved when you refresh.

Installation and automatic refresh leave workspace files untouched. Background configuration errors appear in the panel without popups. Applying access settings, reconfiguring or recovering a policy is your choice. Multi-root workspaces keep separate settings for each selected folder.

## How selections work

Checkbox changes remain in the draft until Apply. A project's **Enable/Disable** button retains its saved paths. Checking a path in a disabled project starts a fresh precise selection instead of restoring old grants. The row's **⋯** action opens manual path and instruction settings.

Unchecking a child of a selected folder keeps its currently selected siblings. New siblings need their own selection; descendants of retained folders stay covered. Removing Read also removes Write. Removing Write keeps any separately selected Read access.

**Workspace files** excludes registered projects, including disabled ones, and does not save a whole-workspace `.` grant. Folders containing projects can be expanded to select other children. The parent checkbox selects current resource roots; new top-level entries need a new selection. A project registered at `.` uses its own tree, so the separate Workspace files section is omitted.

Selecting an instruction file requires existing Read access to it. Project Read/Write paths are relative to that project; instruction and shared-resource paths are relative to the selected workspace.

## Configuration files

| File | Purpose |
| --- | --- |
| `.agentscope/access.md` | Access policy and project registry |
| `AGENTS.md` | A short reference to the access policy alongside existing instructions |
| `.vscode/settings.json` | Explorer and Search visibility |
| `.codex/config.toml` | Optional Codex permission profile |
| `.vscode/agentscope-presets.json` | Named workspace presets |

Apply adds or updates its short reference in `AGENTS.md` and keeps your other instructions. If the file is missing, Apply creates it. Existing editor and Codex settings are preserved. Customized or conflicting policy blocks need review before Apply.

Preview lists only files that would change and leaves them untouched. With no pending changes, it shows a message. **More → Restore last apply** restores the previous contents if those files still match the applied version.

Save or discard unsaved configuration edits before applying changes. If a configuration file changes elsewhere, review the updated draft before trying again.

## Presets and recovery

Use **Presets → Save preset…** to name and save your current choices. **Activate preset…** loads them for review and Apply. Saving or deleting a preset does not change the applied configuration.

AgentScope also keeps the last complete, valid policy pair in local VS Code extension storage. **More → Recover saved configuration** restores that pair after either policy file is deleted or damaged. Recovery replaces the files with the saved version and keeps their prior contents available through Restore.

If a linked `.agentscope/access.md` is missing or damaged, the panel keeps the selected workspace and shows the error. **Recover saved configuration**, when available, restores the last valid policy; it is also available beside the error. To choose permissions again, use **Reconfigure access** beside the error or in More. It starts a draft with projects disabled and no Read/Write grants. Select the desired paths and Apply; existing `AGENTS.md` instructions are retained. Neither action runs automatically.

Recovery is local to this VS Code installation and workspace path. Keep important configuration files in version control or a separate backup. Errors in unrelated editor settings still need to be repaired before Apply.

## Settings

Search for `agentscope` in VS Code Settings.

| Setting | Default | Purpose |
| --- | --- | --- |
| `generateCodexProfile` | `true` | Generate a named Codex permission profile |
| `profileName` | `agentscope` | Profile name |
| `codexRuntime` | `auto` | Generate paths for the native OS or WSL; Auto follows Codex's WSL setting |
| `codexWorkspaceRoot` | empty | Optional absolute workspace path inside the Codex runtime, for custom drive mounts |
| `codexFilesystemMode` | `auto` | Windows compatibility for Windows runtime paths; strict read isolation for Linux, macOS and WSL |
| `excludeFromSearch` | `true` | Apply visibility choices to Search as well as Explorer |
| `allowCommandNetwork` | `false` | Request command network access in the generated profile |

Disable profile generation to manage policies and visibility without changing Codex configuration. Network settings concern local commands, not separate browsing or connector tools.

Native Codex sessions keep the selected workspace's Windows, macOS or Linux paths. A VS Code extension running inside WSL already uses Linux paths; Windows VS Code can map the same workspace to its WSL location as described below.

When VS Code runs on Windows and Codex runs in WSL, the profile needs Linux paths such as `/mnt/d/MyApps/.agentscope/access.md`. Auto detects `chatgpt.runCodexInWindowsSubsystemForLinux`; select `wsl` or `native` if needed. For a custom WSL mount, set `codexWorkspaceRoot` to the selected folder's Linux path. After changing the runtime or updating AgentScope, use **Preview → Apply** to regenerate its managed profile, then start a new Codex session.

Filesystem compatibility follows the generated runtime paths, independently of the extension host:

| Codex runtime | Auto filesystem mode | Sandbox boundary |
| --- | --- | --- |
| Native Windows, including Windows drive and UNC overrides | Windows compatibility | Broad reads; writes limited to selected paths and runtime temporary storage |
| Windows VS Code with Codex in WSL2 | Strict | Selected reads and writes, plus minimal runtime/configuration paths |
| VS Code inside WSL, Linux or macOS | Strict | Selected reads and writes, plus minimal runtime/configuration paths |

Native legacy Windows sandboxes can refuse to start with restricted root reads, reporting `elevated Windows sandbox requires effective ':root' read access`. **Auto** avoids this by generating a Windows-compatible profile. The panel, generated profile and Apply confirmation explain that files outside selected paths, including disabled projects, remain readable at the OS level. Read selections still govern the agent's instructions, but do not enforce read isolation in this mode. Selected write permissions are retained; AgentScope does not disable the sandbox or grant whole-workspace writes.

Use `codexFilesystemMode: strict` when Codex has a compatible native Windows sandbox such as MXC and you need OS-enforced read isolation. WSL2 uses strict mode automatically. Explicit `windows-compatible` remains strict when targeting POSIX paths, so presets can move between environments. Some legacy Windows backends cannot enforce writable descendants inside protected read-only carveouts or split write policies; unsupported layouts need a compatible sandbox or WSL2. AgentScope rejects known unsupported carveouts rather than widening writes.

Existing presets without the new filesystem option inherit the current setting. Explicit runtime choices and workspace-root overrides saved in a preset remain authoritative; `auto` follows the current Codex WSL setting each time you Preview or Apply. Switching between native and WSL runtimes requires another **Preview → Apply** and a new Codex session. The extension marks configuration changes as a pending draft without writing files automatically. One shared generated profile targets one runtime at a time.

## Access boundaries

Explorer exclusions hide paths; they do not restrict filesystem access. The policy describes the agent's expected behavior. A compatible Codex client must load and enforce the generated permission profile. Saving configuration does not confirm that a running session has activated it; check the client's effective permissions in a fresh session.

Changing settings requires a trusted workspace. AgentScope checks that selected paths stay within their project, resolves symbolic links and junctions, and checks for competing configuration edits. It rejects explicit Git metadata selections. Malformed or unsupported `.gitmodules` input stops discovery.

Folder grants cover descendants without inspecting every nested link or metadata directory. Hard links can expose the same file through two ordinary paths, so do not use them across an intended access boundary. Minimal configuration reads remain in generated profiles even when other resources are unchecked. Avoid concurrent configuration writers.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) to build, test or contribute to AgentScope.

The GitHub Actions workflow runs the test suite and builds the VSIX on Windows, macOS and Linux. WSL path translation also has dedicated unit tests.

Webview performance tests count element creation, listener bindings and table changes alongside access and keyboard behavior. Repeated states reuse existing rows; loading one folder adds its children while keeping other rows and controls. Sidebar refreshes in the same turn publish the latest model once.

## License

[MIT](LICENSE).
