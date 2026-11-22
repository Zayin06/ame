# Third-party notices and provenance

This app uses supplied local references:

- `../agy-html/agy-html`: layout reference; CSS tokens and reference styles copied into `packages/ui/styles`. No license file was found at the supplied prototype root. No license or redistribution permission is inferred; obtain appropriate permission before public redistribution.
- `../opencode-amekit`: API, model policy, encrypted vault, runtime and bundle installation code adapted into `packages/amekit`; server policy/model gateway adapted into `packages/amekit-server`. No license file was found at the supplied root. Preserve any source notices and confirm ownership/redistribution permission before publishing.
- OpenCode 2.3.2 (`anomalyco/opencode`, tag `v2.3.2`, commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`): backend API consumed through its published client. Native Pairing wire format/UI flow adapted with an automatically managed OpenTunnel SDK route; QR encoder in `apps/desktop/src/renderer/qr.ts` and its reference test fixture copied from upstream. Native session snapshot review and completed-turn projection are adapted for React; patch normalization and checksum are copied/adapted in `apps/desktop/src/renderer/opencode-session-diff.ts`. Copyright (c) 2025 opencode, MIT; see [full license](references/OPENCODE_LICENSE.txt), included in packaged app files. The QR source credits Project Nayuki's MIT QR Code generator and retains that attribution. No upstream background service or tunnel daemon is installed. See [pinned references](references/README.md).
- Build resources include an unmodified platform executable of OpenCode 2.3.2, staged from a trusted local installation or `AME_OPENCODE_CLI`. Its version/hash check establishes consistency, not redistribution rights. No executable license files were found beside the supplied installed CLI. Public distribution is blocked until the executable's applicable license, notices and redistribution permissions are confirmed and included, together with the supplied source permissions above.

The interactive terminal uses published [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`, `@xterm/addon-fit`) and Microsoft's [node-pty](https://github.com/microsoft/node-pty), the upstream terminal foundations also used by VS Code. No VS Code Workbench terminal implementation is copied. Their original MIT license files are retained in the packaged dependency directories, including the unpacked native node-pty files.

## Direct dependencies

The session review renderer uses `@pierre/diffs@1.6.1` (Apache-2.0). Its [original license](references/PIERRE_DIFFS_LICENSE.txt) is included in packaged app files.

Versions/licenses below are read from installed package metadata. Original copyright and license texts remain in the respective `node_modules` packages and must accompany redistribution as required. This summary does not replace those texts or cover the complete transitive license inventory.

| Package | Pinned version | License metadata |
| --- | --- | --- |
| @monaco-editor/react | 4.7.0 | MIT |
| @opencode/client | 2.3.2 | MIT |
| @opentunnel/client | 0.6.2 | MIT |
| @pierre/diffs | 1.6.1 | Apache-2.0 |
| @opencode/plugin / @opencode/schema | 2.3.2 | MIT |
| @xterm/xterm | 6.0.0 | MIT |
| @xterm/addon-fit | 0.11.0 | MIT |
| node-pty | 1.1.0 | MIT |
| fflate | 0.8.2 | MIT |
| monaco-editor | 0.55.1 | MIT |
| react / react-dom | 19.2.0 | MIT |
| simple-git | 3.30.0 | MIT |
| yaml | 2.8.3 | ISC |
| zod | 4.6.7 | MIT |
| @types/node | 22.10.2 | MIT |
| @types/react / @types/react-dom | 19.2.2 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| electron | 45.4.1 | MIT (also bundled Chromium/Node notices) |
| electron-builder | 26.0.12 | MIT |
| electron-vite | 4.0.1 | MIT |
| tsx | 4.20.6 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 6.4.6 | MIT |

Electron distributions contain additional licenses/Chromium notices. Do not remove them from packaged output. Public release requires a full transitive notice review and resolution of the supplied source permissions above.
