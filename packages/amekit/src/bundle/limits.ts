// Adapted from opencode-amekit/src/bundle/limits.ts; see ../docs/amekit.md for provenance.
// Keep in sync with amecode-api/src/amekit/limits.ts.
export const MAX_PAYLOAD_FILES = 1023
export const MAX_ARCHIVE_ENTRIES = MAX_PAYLOAD_FILES + 1
export const MAX_MANIFEST = 512 * 1024
export const MAX_FILE = 4 * 1024 * 1024
export const MAX_EXPANDED = 24 * 1024 * 1024
export const MAX_ZIP = 8 * 1024 * 1024
export const BUNDLE_ARCHIVE_LIMITS = {
  compressed: MAX_ZIP, expanded: MAX_EXPANDED, file: MAX_FILE,
  files: MAX_ARCHIVE_ENTRIES, entries: MAX_ARCHIVE_ENTRIES, ratio: 100, strict: true,
}
