<h1>
  <img src="media/icon.png" alt="AgentScope" width="96" align="middle" />
  &nbsp;&nbsp;&nbsp;AgentScope
</h1>

Manage Codex filesystem permissions and Explorer visibility from one VS Code panel. Save project presets and select their permission profiles for individual Codex chats. AgentScope supports local folders, Git submodules and multi-root workspaces on Windows, macOS and Linux, including WSL.

## Features

- Select projects, folders or individual files with separate Read and Write checkboxes.
- Select supporting workspace files outside registered projects.
- Hide folders in Explorer and Search independently of permissions.
- Export saved presets as separate named Codex permission profiles.
- Choose a preset before opening a chat through AgentScope, with an optional Ctrl+N shortcut.
- Preview changes, restore the last Apply and recover saved configuration.
- Verify MXC support for native Windows and use strict filesystem permissions when available.

## Install

Install [AgentScope from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=SuperEntity.agentscope), published by **SuperEntity**. Marketplace installations update automatically when Auto Update is enabled.

Alternatively, download a `.vsix` from [GitHub Releases](https://github.com/Super-Entity/AgentScope/releases), then run **Extensions: Install from VSIX...** in VS Code. You do not need Node.js or npm to use the extension. VS Code 1.95 or later is required.

```sh
code --install-extension agentscope-0.8.2.vsix
```

## Getting started

1. Open a local workspace and select AgentScope in the Activity Bar. For multi-root workspaces, use **Select workspace** to choose the folder to configure.
2. New container workspaces list immediate ordinary folders as disabled projects. Git submodules are discovered from `.gitmodules`. An individual repository or project starts with its own disabled root. Use **Add folder** to register other workspace folders; Git is optional.
3. Expand a project and check **Read** or **Write** for the paths it needs. A folder includes its descendants; a mixed checkbox means only some paths are selected. Write also allows Read.
4. Use **Workspace files** for supporting files outside registered projects. Use **Hide/Show** to change visibility separately.
5. Save useful selections with **Presets → Save preset...**. Use **Preview** to review the proposed configuration, then **Apply** to publish it.
6. Click **New Codex chat** on the AgentScope panel and choose a saved preset. In the opened Codex chat, select its **Preset name - AgentScope** entry in Permissions before sending a message.

Installation, refresh and checkbox changes leave workspace configuration untouched. Access and visibility changes remain a draft until Apply; Save preset stores its snapshot immediately. Background configuration errors appear in the panel. Each selected folder in a multi-root workspace has its own configuration.

## Presets and individual chats

Apply exports saved presets to separate entries in `.codex/config.toml`. Codex's native permissions menu displays short names such as **Review - AgentScope**, so two chats can select different project scopes without switching a shared instruction file. Selecting a profile applies to that chat; saving an AgentScope preset alone does not activate it in a running chat.

Each preset has one readable profile name without hashes or revision numbers. **Update preset...** saves the current editor selections over an existing preset after a Replace confirmation; other presets keep their snapshots. Use Apply to publish the update. Updating a preset updates that named profile, so chats using the same preset can receive its new permissions when Codex reloads configuration. Use separate presets when chats need independently maintained scopes.

Save, Update and Delete check that the preset file still matches the revision used to open their dialogs. If another writer changes it while a dialog is open, the operation stops so you can review the new version. Apply exports the same preset revision that its write guards verify.

Apply migrates AgentScope's older hashed preset entries to these readable names. Existing chats using an older identifier must select the new entry in Codex Permissions. Unrelated user-created profiles are preserved. The `windows.sandbox` backend remains a workspace-wide setting; profiles must match the active runtime and backend.

Use the **New Codex chat** button on the main AgentScope panel, or run **AgentScope: New Codex chat** (`agentscope.newChat`). This action always asks you to choose a saved preset before opening Codex. Enable `agentscope.promptPresetForNewChat` in Settings or the AgentScope menu to use the same preset flow for Ctrl+N while Codex's new-chat shortcut is active. Cancelling the picker opens no chat and publishes no changes.

**After the chat opens, select the chosen profile in Codex's native permissions menu before sending.** Codex's public new-chat command does not accept a permission-profile argument. AgentScope cannot bind the selection automatically or intercept Codex's internal **+** button. Changing `default_permissions` is insufficient because Codex can remember a different menu selection. The picker and subsequent guidance make this manual step explicit.

The chat must also use the workspace folder configured in AgentScope as its working directory. In a multi-root workspace, select that folder in Codex so it can discover the exported profiles. Codex's public new-chat command does not let AgentScope set the chat's working directory.

Presets contain access, visibility and runtime options. Older presets inherit settings that were not present when they were saved. **Activate preset...** loads its choices into the editor for review and Apply.

## How selections work

A project's **Enable/Disable** button retains its saved paths. Checking a path in a disabled project starts a fresh precise selection. The row's **⋯** action opens manual path settings.

Unchecking a child of a selected folder keeps its currently selected siblings. New siblings need their own selection; descendants of retained folders stay covered. Removing Read also removes Write. Removing Write keeps separately selected Read access.

**Workspace files** excludes registered projects, including disabled ones, and does not save a whole-workspace `.` grant. Folders containing projects can be expanded to select other children. Its parent checkbox selects current resource roots; new top-level entries need a new selection. A project registered at `.` uses its own tree instead.

Project Read/Write paths are relative to the project. Shared-resource paths are relative to the selected workspace. Explorer and Search visibility do not enforce filesystem permissions.

For native Windows profiles, path casing does not create separate permissions. Equivalent paths within one project merge their grants; project registrations or grants that overlap another project's boundary through different casing are rejected.

## Configuration files and migration

| File | Purpose |
| --- | --- |
| `.vscode/agentscope.json` | AgentScope editor state and project registry |
| `.vscode/agentscope-presets.json` | Named preset snapshots |
| `.vscode/settings.json` | Explorer and Search visibility |
| `.codex/config.toml` | Codex runtime permission profiles and selected sandbox settings |

Codex enforces the selected permission profile from `config.toml`; `.vscode/agentscope.json` is extension storage. AgentScope no longer generates or maintains `AGENTS.md`, `.agentscope/access.md` or project instruction-file references. Your own `AGENTS.md` can still supply optional instructions independently of AgentScope.

When no new editor-state file exists, AgentScope can import a recognized legacy configuration. The first Apply saves `.vscode/agentscope.json` and removes only recognized canonical AgentScope-generated blocks from an existing `AGENTS.md`. User prose remains, and the legacy `.agentscope/access.md` is left as a backup. Customized or ambiguous blocks require review instead of being deleted automatically. Later configuration uses the new state file and does not depend on the legacy policy pair.

Preview lists only files that would change and leaves them untouched. Existing JSONC comments, unrelated editor settings and user-owned Codex profiles are preserved. **Restore last apply** restores previous contents when the affected files still match the applied version.

Save or discard unsaved configuration edits before Apply. Apply and Restore recheck file contents and parent links after awaiting their final write guard. If another writer changes a file, review the updated draft before trying again. **Recover saved configuration** restores a valid local checkpoint when available; **Reconfigure access** starts a fresh disabled draft. Neither runs automatically. Keep important configuration in version control or a separate backup.

## Runtime and Windows sandbox

Auto runtime selection follows Codex's `chatgpt.runCodexInWindowsSubsystemForLinux` setting on Windows. A VS Code extension running inside WSL already uses Linux paths. For custom WSL mounts, set `codexWorkspaceRoot` to the workspace's absolute path inside that runtime, such as `/mnt/d/MyApps`.

| Codex runtime | Auto filesystem behavior |
| --- | --- |
| Native Windows with verified MXC | Strict selected reads and writes; pin the MXC backend |
| Native Windows without verified MXC | Legacy Windows compatibility: broad reads and selected writes |
| Windows VS Code with Codex in WSL2 | Strict selected reads and writes |
| VS Code inside WSL, Linux or macOS | Strict selected reads and writes |

Native Windows Auto mode checks version eligibility and runs a bounded Codex sandbox probe with MXC explicitly selected. A successful probe enables strict profiles and writes `[windows] sandbox = "mxc"` to the workspace Codex configuration. This avoids silently falling back to a legacy backend for profiles requiring restricted reads.

MXC needs supported Windows 11 builds, Codex support and an available native capability; Windows 11 alone is insufficient. AgentScope's capability probe is decisive. See the [official Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox).

When MXC cannot be verified, Auto uses Windows compatibility and explains the broad read access in the panel, profile and Apply confirmation. Files outside selected paths, including disabled projects, remain readable by local commands in this mode. Selected writes remain restricted. No generated instruction file adds read isolation to this fallback.

Explicit **Strict** mode requires a compatible sandbox. **Windows-compatible** remains strict for POSIX runtime paths. Some legacy Windows backends cannot enforce writable descendants inside protected read-only paths or split write layouts; unsupported layouts need MXC or WSL2. AgentScope rejects known unsupported layouts without widening writes.

After switching native/WSL runtimes or changing a runtime path, use **Preview → Apply**, then select the exported profile in a new session. Profiles contain runtime-specific paths and must match the runtime actually running Codex.

## Settings

Search for `agentscope` in VS Code Settings.

| Setting | Default | Purpose |
| --- | --- | --- |
| `generateCodexProfile` | `true` | Export Codex permission profiles on Apply |
| `profileName` | `agentscope` | Base profile for the current editor selections |
| `codexRuntime` | `auto` | Target the native OS or WSL runtime |
| `codexWorkspaceRoot` | empty | Override the absolute workspace path inside the Codex runtime |
| `codexFilesystemMode` | `auto` | Verify native Windows MXC, fall back to Windows compatibility, or choose an explicit mode |
| `codexWindowsSandbox` | `auto` | Verify MXC and use it when available; `mxc` requires successful verification, while `legacy` selects the elevated Windows backend |
| `promptPresetForNewChat` | `false` | Route Codex's Ctrl+N through AgentScope's preset picker; the main New Codex chat button always shows the picker |
| `excludeFromSearch` | `true` | Apply visibility choices to Search as well as Explorer |
| `allowCommandNetwork` | `false` | Request network access for local commands |

Disable profile generation to save editor choices and visibility without exporting Codex permissions.

## Access boundaries

A compatible Codex client must load the selected profile. These profiles control local commands; they do not scope independent remote tools, MCP servers, browsers or connectors. See [Codex permissions](https://learn.chatgpt.com/docs/permissions). Inspect the active profile in each chat before using it.

Configuration changes require a trusted workspace. AgentScope checks selected project boundaries, symbolic links, junctions and competing edits, and rejects explicit Git metadata selections. Malformed or unsupported `.gitmodules` input stops discovery.

Folder grants cover descendants without inspecting every nested link or metadata directory. Hard links can expose the same file through ordinary paths on both sides of an intended boundary. Generated profiles retain minimal runtime/configuration reads and temporary-storage allowances. Avoid concurrent configuration writers.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) to build, test or contribute. GitHub Actions runs the test suite and builds the VSIX on Windows, macOS and Linux. Tests cover WSL path translation, native sandbox detection, preset export, migration, configuration conflicts and webview behavior.

## License

[AGPL-3.0-only](LICENSE).
