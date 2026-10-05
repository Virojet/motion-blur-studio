# Release procedure

1. Update package.json's stable version and CHANGELOG.md. If changing the engine
   pin, verify its official release URL, SHA-256, dependencies, and actual renders
   before editing src/shared/engine-release.ts.
2. Run `pnpm typecheck`, `pnpm test`, `pnpm package`, and `pnpm bundle` on Windows.
   Run real-engine and UI smoke checks as described in README.md.
3. Review the source allowlist and release files. Clips, jobs, preferences,
   machine-specific logs, engine binaries, node_modules, and design experiments
   are excluded from source publication. Source screenshots use synthetic fixtures.
4. Commit and push the release source. Push a version tag matching package.json,
   such as `git tag v1.1.0` then `git push origin v1.1.0`.
5. The release workflow builds on Windows and uploads the setup, portable EXE,
   runtime ZIP, setup package ZIP, source ZIP, and SHA256SUMS.txt to GitHub Releases.
6. Verify the workflow and published assets. For a manual release use GitHub's
   release UI or `gh release create TAG --notes-file release/RELEASE-NOTES.md` with
   the explicit release files. Keep private credentials out of source and notes.

The setup wizard calls the application's `--install-engine --silent` entry point.
The helper verifies downloads before execution and checks the installed engine
after completion. Failures return a nonzero status and write a setup log in
`%LOCALAPPDATA%\Motion Blur\setup\engine-setup.log`.

For a signed distribution, maintainers must provide their own valid Windows
code-signing certificate to electron-builder through its supported signing
configuration. This project does not contain signing credentials or change
Windows security policies. A successful build alone does not prove that a
particular machine allows unsigned executable startup.
