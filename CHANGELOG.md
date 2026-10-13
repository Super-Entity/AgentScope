# Changelog

## 0.7.4

- Create the package output directory before building, so packaging works from a fresh clone on Windows, macOS and Linux.

## 0.7.3

- Simplify the installation and usage guide.
- Add Marketplace installation and update guidance.

## 0.7.2

- Add the project icon to the Extensions list and extension details page.
- Update installation and contributor documentation.

## 0.7.1

- Restrict implicit Git metadata grants to dedicated canonical metadata locations; reject pointers that would widen a file selection to the project root or an ordinary content directory.
- Decode Git manifest continuations and mixed quoting correctly; refuse malformed or unsupported manifests before computing disabled-project boundaries.
- Replace managed TOML profiles in place and verify the semantic ownership of unrelated settings outside their markers.
- Preserve nested preset comments and metadata with field edits, and skip equivalent saves without writing the file.
- Protect preset Save/Delete from unsaved editors, including changes made during dialogs and transaction staging.
- Queue configuration watcher events during writes and reconcile them after operations finish; retain a matching applied preset during automatic revalidation.
- Clear removed workspace selections, block pending writes to removed targets and recheck workspace ownership before publication.
- Reject reserved project names before modifying the registry; failed additions preserve the previous draft.
- Detect ordinary workspace-root replacement using directory identity at Load, Reconfigure, planning and publication, without treating child changes as replacement.

## 0.7.0

- Add Read and Write checkboxes to the **Workspace files** parent, selecting current safe resources outside registered projects and showing partial selection without storing a whole-workspace grant.
- Place a direct **Reconfigure access** link beside configuration errors, with the same workspace trust and busy checks as other editing actions.
- Explain each file in Preview, label the current/proposed comparison and show a useful message when no configuration changes are pending. Release preview snapshots when their documents close.
- Preserve fail-closed access defaults when JSONC metadata contains prototype-named keys. Reject literal and canonical Git-metadata scopes, including aliases introduced after checkbox selection.
- Reject preset reads, writes and deletion when the selected workspace root has been redirected through a junction or symbolic link.
- Keep Restore available after recovery even when unrelated configuration errors prevent loading. Validate cached Undo targets and recheck unsaved editors after confirmation, including Windows path casing.
- Lock native path/configuration dialogs against concurrent workspace mutations and queue external file changes until selection finishes.
- Keep the previous Undo record when recovering an unchanged policy pair and report that no files changed.
- Upgrade the development packaging tool to `@vscode/vsce` 4, removing the vulnerable transitive dependency chain reported by npm audit. Document the hard-link limitation of path-based access checks.

## 0.6.0

- Save a complete validated policy pair in workspace-keyed VS Code extension storage, independently of `AGENTS.md`, `.agentscope/access.md` and presets.
- Add **Recover saved configuration** to restore the exact saved policy files after deletion or corruption, including from a configuration error panel. Preserve replaced contents for Undo and reject unsaved edits or file conflicts.
- Add **Reconfigure access** to start a fresh disabled draft, choose Read/Write scopes again and Apply a clean policy while preserving existing `AGENTS.md` user text.
- Keep the last valid checkpoint when policy files are missing or broken. Prepare recovery data before workspace writes and commit it only after Apply succeeds.
- Support ordinary new workspaces without previous configuration; first Apply creates the policy pair and its recovery checkpoint.
- Bootstrap older Apply backups only when both full valid policy outputs are present; keep incomplete or corrupt recovery data unavailable.

## 0.5.2

- Retain the selected workspace and show its actual configuration error when loading fails, instead of displaying an empty workspace panel.
- Keep configuration watchers active during errors so repaired files can reload the selected workspace automatically.
- Preserve saved access choices when `AGENTS.md` is deleted; show a warning and recreate its short reference only on Apply.
- Add **Open access policy** to inspect `.agentscope/access.md` from the panel and command palette.
- Keep conflicting inline and separate registries visible for review without implicitly merging access choices or deleting user prose.

## 0.5.1

- Copy legacy AgentScope settings into `.agentscope/access.md` while retaining all original `AGENTS.md` instructions, rules and inline JSON unchanged.
- Make the linked policy the sole current AgentScope access registry; retained inline settings are historical and cannot grant access.
- Replace only recognized generated reference text. Customized reference blocks stop loading and Apply with repair instructions rather than losing user text.
- Improve the Activity Bar icon's visibility at small sizes.

## 0.5.0

- Store access rules and the registry in `.agentscope/access.md`, using workspace-root-relative paths.
- Keep a short managed reference at the start of `AGENTS.md`, replacing it on subsequent applications while preserving user instructions.
- Migrate marked AgentScope legacy rules and registry through Preview/Apply; stop safely for ambiguous or user-owned registries and policy-file conflicts.
- Include the linked policy in generated filesystem reads, configuration change detection, atomic application and restoration.
- Improve Activity Bar icon sizing.

## 0.4.2

- Update the Activity Bar icon.
- Icon toolbar controls with tooltips and accessible labels.
- Sidebar-bounded Apply, Presets and More menus, with outside-click and Escape dismissal.
- Distinct applied/draft preset colors and responsive layout for narrow sidebars.

## 0.4.1

- Optimize the monochrome Activity Bar icon for 24px.

## 0.4.0

- Workspace files section for Read/Write selection of files and folders outside registered projects, including supporting instructions.
- Persist workspace selections in shared resources and keep existing selections visible in the tree.
- Independent Hide/Show controls for workspace paths, with registered-project boundaries respected.
- Collapse all expanded rows without changing draft permissions or stored configuration.
- Keep whole-workspace grants unavailable in the resources section and preserve managed configuration-read permissions.
- Named workspace presets with Save, Activate and Delete controls, including access, instruction, visibility and profile choices.
- Local preset storage, validation before activation and the regular Preview/Apply configuration flow.

## 0.3.0

- Single sidebar permissions tree with separate Read and Write checkboxes on every project, folder and file row.
- Native mixed checkboxes for partial selections, keyboard navigation and VS Code theme support.
- Independent project enable/disable, configuration and Explorer visibility controls.
- Preserve expanded folders during draft edits and reject stale workspace or directory responses.
- Local webview assets with restricted CSP, text-only workspace rendering and explicit trust/busy states.

## 0.2.0

- Expand projects into Read access and Write access trees with folder and individual-file checkboxes.
- Lazy immediate-directory browsing, inherited selection and partial folder indicators.
- Precise selection when enabling a disabled project; write access implies read access.
- Remove inherited child access by splitting parent grants while retaining sibling coverage.
- Keep checkbox changes as a draft until Apply and reject unsafe link-based splits.

## 0.1.0

- Initial release for local workspaces and Git submodules.
- Project access, read/write paths, selected workflow and independent folder visibility.
- Preview, managed AGENTS registry, JSONC exclusions and optional Codex permission profile.
- File conflict detection, rollback and restoration of the most recent applied configuration.
- Portable core tests and documentation.
