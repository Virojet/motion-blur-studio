# Validation status

Windows x64 checks on October 5, 2026:

- 26 unit tests and TypeScript checks passed, including engine setup integrity,
  literal arguments, reuse, download failures, output validation, queue behavior,
  process-tree cancellation, media range requests, and late preview seeking.
- Blur v2.45 produced real previews and exports with audio and without audio,
  retaining source dimensions and 60 FPS, with spaces and Chinese filenames.
- The current UI passed import, preview generation, synchronized playback,
  export, invalid input, and automatic engine detection through the existing
  Electron runtime. Playback recovery was checked with real generated preview files.
- A late sample with nonzero source timestamps and long GOPs retained synchronized
  three-second audio/video after direct input seeking.
- The v1.0.0 packaged app passed the complete desktop workflow. Windows Device
  Guard blocked startup of the unsigned v1.0.1 repackaged executable on this PC.
  This restriction must not be represented as a verified packaged workflow.

- The v1.1.0 standalone Runtime distribution passed the complete UI workflow
  with real engine processing and CPU settings. Its executable preserves the
  official Electron runtime bytes. The packaged v1.1.0 executable also passed
  import, real preview, synchronized playback, export, and error handling.
  Its setup helper passed a dry-run reuse check without modifying the engine.

The source workflow and unit tests do not prove a clean-machine setup wizard
installation. That remains unverified locally. GitHub Actions performs additional
real-engine checks on an isolated Windows runner. The project executables are
unsigned; Windows and organizational policies still apply.
