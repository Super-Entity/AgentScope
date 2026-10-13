# Contributing to AgentScope

Use Node.js 22 or later and VS Code 1.95 or later.

```sh
npm ci
npm test
npm run package
```

On Windows, `npm.cmd` avoids PowerShell launcher restrictions. Press **F5** to run the extension in an Extension Development Host. `npm run watch` provides incremental compilation.

Keep runtime behavior portable across Windows, macOS and Linux. Derive paths and project names from the selected workspace. Visibility and access are separate controls; preserve existing instructions, JSONC comments and unrelated TOML settings when updating configuration.

Add regression tests for behavior that changes, especially malformed input, Read/Write boundaries, disabled projects, symlink or junction escapes, competing edits and recovery failures. Use isolated fixtures and clean them after tests.

Before submitting a change, run the tests and build a VSIX. For panel changes, check a local folder, a multi-root workspace and Restricted Mode. Exercise Preview, Apply, Restore and external-edit handling. When testing Codex integration, record the client version and inspect effective permissions in a fresh session.

Pull requests should explain the resulting behavior, relevant validation and any compatibility limits. CI runs tests and packaging on Windows, Linux and macOS. Tests cover parsing, selections, path boundaries, preservation, transactions and recovery; they do not verify a running Codex sandbox.

## Releases

Increase the version in `package.json` and `package-lock.json`, update the changelog, then build and test the package. Use a GitHub release tag matching the package version, such as `v0.7.3`, and attach `artifacts/agentscope-0.7.3.vsix`. Users install that file directly; they do not need a development environment.

Upload the same VSIX through the SuperEntity publisher in [Marketplace](https://marketplace.visualstudio.com/manage/publishers/superentity). Keep the publisher ID unchanged so GitHub and Marketplace packages share the extension ID `SuperEntity.agentscope`. Marketplace installations receive new versions when automatic updates are enabled. A GitHub release alone does not publish a Marketplace update.
