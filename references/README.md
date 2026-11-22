# Pinned references

- [Local architecture plan](../../AME-IDE-architecture-plan.md): scoped implementation follows its vertical-slice-first guidance.
- [Local HTML prototype](../../agy-html/agy-html/index.html): layout/tokens, not a runtime dependency.
- [Local AmeKit](../../opencode-amekit/README.md) and [its SDK investigation](../../opencode-amekit/docs/sdk-research.md): Account, model-policy and bundle source/reference.
- [OpenCode v2.3.2 release](https://github.com/anomalyco/opencode/releases/tag/v2.3.2), release source pinned by the supplied SDK investigation to [`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`](https://github.com/anomalyco/opencode/tree/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1).
- Installed `@opencode/client@2.3.2` generated Promise client declarations and implementation are the integration contract actually checked by adapter tests. Do not replace them with legacy SDK examples.

Session changes follow the same pinned OpenCode source:

- `packages/core/src/session/diff.ts`: snapshot range semantics (`from` / `to` user-message IDs). An unbounded request means the latest turn; the IDE queries the first/last user IDs to request the whole session.
- `packages/gui-plugins/src/review/model.ts`: session review uses `session.diff`, independently from `vcs.diff`.
- `packages/session-ui/src/timeline/projection.ts`: completed execution summaries collect assistant `snapshot.files` until `idle`, retaining the opener across steered prompts.
- `packages/app/src/session/timeline/turn-diffs.ts` and `turn-diff-machine.ts`: lazy finished-turn requests, timeout, retry and stale-result handling.
- `packages/session-ui/src/components/session-diff.ts` and `packages/util/src/encode.ts`: patch normalization/checksum ported into `apps/desktop/src/renderer/opencode-session-diff.ts`; imports adapted and `findLastIndex` expressed as an equivalent ES2022 reduction. React uses the same pinned `@pierre/diffs@1.6.1` renderer instead of the upstream Solid wrapper.

The IDE consumes upstream public APIs; it does not patch upstream server/CLI or claim that mobile end-to-end compatibility has been tested. Local provenance does not confer a redistribution license; see [notices](../THIRD_PARTY_NOTICES.md).
