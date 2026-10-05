# Third-party software

The Motion Blur interface is MIT licensed; see LICENSE. It launches Tekno's Blur
as a separate program through its documented CLI. This project is not affiliated
with or endorsed by Tekno or the upstream Blur project.

## Tekno's Blur engine

Setup downloads the unchanged **Blur v2.45 Windows installer** from its official
GitHub release. The engine binaries are not stored in this repository or copied
into this project's release packages. An existing complete installation is reused.

- Project and documentation: https://github.com/f0e/blur
- Pinned release: https://github.com/f0e/blur/releases/tag/v2.45
- Engine license, GPL-3.0: https://github.com/f0e/blur/blob/v2.45/LICENSE
- Source at the installed version: https://github.com/f0e/blur/tree/v2.45
- Source archive: https://github.com/f0e/blur/archive/refs/tags/v2.45.zip
- Dependencies and their upstream source links: https://github.com/f0e/blur#dependencies

The engine's own installer supplies its runtime dependencies, including FFmpeg,
VapourSynth, interpolation plugins, and RIFE models. Their respective upstream
licenses apply. Installer downloads must keep the pinned SHA-256 validation.
If maintainers redistribute engine binaries in a future offline bundle, they
must review every bundled component's redistribution terms and provide the
corresponding source and notices required by those licenses.

## Interface runtime

Electron is MIT licensed and includes Chromium and other components with their
own licenses. The runtime ZIP preserves Electron's LICENSE and
LICENSES.chromium.html files. React is MIT licensed. Development dependencies
and their licenses are available through package.json and pnpm-lock.yaml.
