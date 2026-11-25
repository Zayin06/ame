// Adapted from OpenCode 2.3.2 session-ui/session-diff.ts and util/encode.ts.
// Copyright (c) 2025 opencode. MIT; see references/OPENCODE_LICENSE.txt.
import { parseDiffFromFile, parsePatchFiles, processFile, type FileDiffMetadata } from "@pierre/diffs"

import type { FileDiffInfo } from "@opencode/client/promise"


type LegacyDiff = {
  file: string
  patch?: string
  before?: string
  after?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}

type ReviewDiff = FileDiffInfo | LegacyDiff

export type DiffSource = Pick<LegacyDiff, "file" | "patch" | "before" | "after">

export type ViewDiff = {
  file: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
  fileDiff: FileDiffMetadata
  eolNormalized?: boolean
  eolOnly?: boolean
  parseFailed?: boolean
}

const diffCacheLimit = 64

const fileDiffCache = new Map<string, FileDiffMetadata>()

function countHunkChanges(fileDiff: FileDiffMetadata) {
  let additions = 0
  let deletions = 0
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines
    deletions += hunk.deletionLines
  }
  return { additions, deletions }
}

function normalizeContentPair(
  file: string,
  before: string,
  after: string,
  rawCounts?: { additions: number; deletions: number },
) {
  const beforeLF = before.replace(/\r\n/g, "\n")
  const afterLF = after.replace(/\r\n/g, "\n")
  if (beforeLF === before && afterLF === after) return
  if (beforeLF === afterLF) {
    return {
      fileDiff: emptyFileDiff(file),
      additions: 0,
      deletions: 0,
      eolNormalized: true,
      eolOnly: true,
    }
  }
  const lfDiff = fileDiffFromContent(file, beforeLF, afterLF)
  const lfCounts = countHunkChanges(lfDiff)
  const baseline = rawCounts ?? countHunkChanges(fileDiffFromContent(file, before, after))
  if (lfCounts.additions + lfCounts.deletions < baseline.additions + baseline.deletions) {
    return {
      fileDiff: lfDiff,
      additions: lfCounts.additions,
      deletions: lfCounts.deletions,
      eolNormalized: true,
    }
  }
  return
}

function resolveDiffResult(
  diff: DiffSource & { additions?: number; deletions?: number },
  context = hunkContext,
): { fileDiff: FileDiffMetadata; additions: number; deletions: number; eolNormalized?: boolean; eolOnly?: boolean; parseFailed?: boolean } {
  const fallbackAdditions = diff.additions ?? 0
  const fallbackDeletions = diff.deletions ?? 0
  if (diff.patch == null) {
    const before = diff.before ?? ""
    const after = diff.after ?? ""
    const normalized = normalizeContentPair(diff.file, before, after)
    if (normalized) return normalized
    const fileDiff = fileDiffFromContent(diff.file, before, after)
    const counts = countHunkChanges(fileDiff)
    return {
      fileDiff,
      additions: diff.additions ?? counts.additions,
      deletions: diff.deletions ?? counts.deletions,
    }
  }

  const key = context === hunkContext ? `${diff.file}\0${diff.patch}` : `${diff.file}\0${diff.patch}\0${context}`
  const complete = completePatch(diff.patch)
  if (complete) {
    const rawDiff = fileDiffFromCompletePatch(diff.file, complete, context)
    const rawCounts = countHunkChanges(rawDiff)
    const normalized = normalizeContentPair(diff.file, complete.before, complete.after, rawCounts)
    if (normalized) return normalized
    rawDiff.cacheKey = highlightKey(key)
    return {
      fileDiff: rawDiff,
      additions: diff.additions ?? rawCounts.additions,
      deletions: diff.deletions ?? rawCounts.deletions,
    }
  }

  if (diff.patch.includes("\r\n")) {
    const normalizedPartial = normalizePartialPatchCrlf(diff.file, diff.patch, fallbackAdditions, fallbackDeletions)
    if (normalizedPartial) return normalizedPartial
  }

  const partial = partialFileDiff(diff.file, trimContext(diff.patch, context))
  if (!partial || (diff.patch.trim().length > 0 && partial.hunks.length === 0)) {
    return {
      fileDiff: emptyFileDiff(diff.file),
      additions: fallbackAdditions,
      deletions: fallbackDeletions,
      parseFailed: diff.patch.trim().length > 0,
    }
  }
  partial.cacheKey = highlightKey(key)
  const counts = countHunkChanges(partial)
  return {
    fileDiff: partial,
    additions: diff.additions ?? counts.additions,
    deletions: diff.deletions ?? counts.deletions,
  }
}

/** `context` is how many unchanged lines a diff built from complete contents keeps around each change. */
export function resolveFileDiff(diff: DiffSource, context = hunkContext) {
  return resolveDiffResult(diff, context).fileDiff
}

export function normalize(diff: ReviewDiff, context?: number): ViewDiff {
  const resolved = resolveDiffResult(diff, context)
  return {
    file: diff.file,
    additions: resolved.additions,
    deletions: resolved.deletions,
    status: diff.status,
    fileDiff: resolved.fileDiff,
    ...(resolved.eolNormalized ? { eolNormalized: true } : {}),
    ...(resolved.eolOnly ? { eolOnly: true } : {}),
    ...(resolved.parseFailed ? { parseFailed: true } : {}),
  }
}

export function text(diff: ViewDiff, side: "deletions" | "additions") {
  if (side === "deletions") return diff.fileDiff.deletionLines.join("")

  return diff.fileDiff.additionLines.join("")
}

function fileDiffFromPatch(file: string, patch: string, context: number) {
  const key = context === hunkContext ? `${file}\0${patch}` : `${file}\0${patch}\0${context}`

  return cachedFileDiff(`patch\0${key}`, () => {
    const complete = completePatch(patch)

    const value = complete
      ? fileDiffFromCompletePatch(file, complete, context)
      : (partialFileDiff(file, trimContext(patch, context)) ?? emptyFileDiff(file))

    // The patch text fixes both the content and the producer's alignment, so equal keys always mean equal hunks.
    value.cacheKey = highlightKey(key)

    return value
  })
}

function cachedFileDiff(key: string, parse: () => FileDiffMetadata) {
  const hit = fileDiffCache.get(key)

  if (hit) {
    fileDiffCache.delete(key)
    fileDiffCache.set(key, hit)

    return hit
  }

  const value = parse()
  fileDiffCache.set(key, value)

  while (fileDiffCache.size > diffCacheLimit) fileDiffCache.delete(fileDiffCache.keys().next().value!)

  return value
}

export function completePatchContents(patch: string) {
  const complete = completePatch(patch)

  if (!complete) return

  return { before: complete.before, after: complete.after }
}

function reconstructHunkSides(
  bodyLines: readonly string[],
  deletionCount: number,
  additionCount: number,
  stripCR = false,
) {
  const lines: string[] = []
  const before: Array<{ text: string; newline: boolean }> = []
  const after: Array<{ text: string; newline: boolean }> = []
  let previous: "-" | "+" | " " | undefined

  for (const raw of bodyLines) {
    if (before.length >= deletionCount && after.length >= additionCount && !raw.startsWith("\\")) break
    const line = stripCR && raw.endsWith("\r") ? raw.slice(0, -1) : raw
    lines.push(line)

    if (line.startsWith("\\")) {
      if (previous === "-" || previous === " ") {
        const value = before.at(-1)
        if (value) value.newline = false
      }
      if (previous === "+" || previous === " ") {
        const value = after.at(-1)
        if (value) value.newline = false
      }
      continue
    }

    if (line.startsWith("-")) {
      before.push({ text: line.slice(1), newline: true })
      previous = "-"
      continue
    }

    if (line.startsWith("+")) {
      after.push({ text: line.slice(1), newline: true })
      previous = "+"
      continue
    }

    if (!line.startsWith(" ")) continue
    before.push({ text: line.slice(1), newline: true })
    after.push({ text: line.slice(1), newline: true })
    previous = " "
  }

  const text = (items: Array<{ text: string; newline: boolean }>) =>
    items.map((item) => item.text + (item.newline ? "\n" : "")).join("")

  return { before: text(before), after: text(after), lines }
}

function completePatch(patch: string) {
  const parsed = splitPatch(patch)

  if (!parsed) return

  // Snapshot and VCS producers request full context. Tool patches use jsdiff's shorter default context.
  if (!parsed.header.startsWith("diff --git ") && !/^--- [^\n]*\t\r?\n\+\+\+ [^\n]*\t(?:\r?\n|$)/m.test(parsed.header))
    return

  // Full patches collapse into one leading hunk. Separated hunks omit ranges and must stay partial.
  if (parsed.hunks.length !== 1) return

  const hunk = parsed.hunks[0]!

  // An empty side's start names the line before the hunk, so `-1,0` begins after line 1.
  if (hunk.deletionStart + (hunk.deletionCount ? 0 : 1) > 1 || hunk.additionStart + (hunk.additionCount ? 0 : 1) > 1)
    return

  return reconstructHunkSides(parsed.body.split("\n").slice(1), hunk.deletionCount, hunk.additionCount)
}

// Splits a one-file patch at its first hunk. Pierre's strict parser checks the hunks behind a fixed header, so a
// malformed hunk rejects the patch while unusual file headers stay readable.
function splitPatch(patch: string) {
  const start = patch.search(/^@@ /m)
  const header = start === -1 ? patch : patch.slice(0, start)
  const body = start === -1 ? "" : patch.slice(start)

  const parse = (input: string) =>
    input
      ? (processFile(`--- a\n+++ a\n${input}`, { isGitDiff: false, throwOnError: true })?.hunks ?? [])
      : []

  try {
    return { header, body, hunks: parse(body) }
  } catch {
    const lfBody = body.replace(/\r\n/g, "\n")
    if (lfBody !== body) {
      try {
        return { header: header.replace(/\r\n/g, "\n"), body: lfBody, hunks: parse(lfBody) }
      } catch {
        return
      }
    }
    return
  }
}

// A complete patch already carries the producer's line diff. Splitting its single full-context hunk at long
// unchanged runs yields, in linear time, the collapsed hunks Pierre would get by diffing the reconstructed files
// again whenever both algorithms choose the same alignment.
function fileDiffFromCompletePatch(
  file: string,
  patch: { before: string; after: string; lines: string[] },
  context: number,
) {
  // Pierre reads names back from header text, so a fixed header keeps tabs, quotes, and newlines in `file` intact.
  const value =
    processFile(`--- a\n+++ a\n${splitHunk(patch.lines, context)}`, {
      isGitDiff: false,
      oldFile: { name: file, contents: patch.before },
      newFile: { name: file, contents: patch.after },
    }) ?? emptyFileDiff(file)

  value.name = file

  return value
}

// Pierre's file diffs use jsdiff's default of four context lines; longer unchanged runs end one hunk and start the next.
const hunkContext = 4

function splitHunk(lines: string[], context: number) {
  const rows = lines.reduce<{ line: string; marker?: string }[]>((result, line) => {
    const previous = result.at(-1)

    // A marker annotates the line before it; completePatch ignores a marker with nothing to annotate.
    if (line.startsWith("\\")) {
      if (previous) previous.marker = line

      return result
    }

    result.push({ line })

    return result
  }, [])

  const changes = rows.flatMap((row, index) => (row.line.startsWith(" ") ? [] : [index]))

  const ranges = changes.reduce<{ start: number; end: number }[]>((result, index) => {
    const previous = result.at(-1)
    const start = Math.max(0, index - context)
    const end = Math.min(rows.length - 1, index + context)

    if (previous && start <= previous.end + 1) {
      previous.end = end

      return result
    }

    result.push({ start, end })

    return result
  }, [])

  const positions = rows.reduce<{ old: number; new: number }[]>(
    (result, row) => {
      const current = result.at(-1)!

      result.push({
        old: current.old + (row.line.startsWith("+") ? 0 : 1),
        new: current.new + (row.line.startsWith("-") ? 0 : 1),
      })

      return result
    },
    [{ old: 0, new: 0 }],
  )

  return ranges
    .map((range) => {
      const start = positions[range.start]!
      const end = positions[range.end + 1]!
      const oldCount = end.old - start.old
      const newCount = end.new - start.new

      const body = rows
        .slice(range.start, range.end + 1)
        .map((row) => (row.marker ? `${row.line}\n${row.marker}` : row.line))
        .join("\n")

      return `@@ -${oldCount === 0 ? start.old : start.old + 1},${oldCount} +${newCount === 0 ? start.new : start.new + 1},${newCount} @@\n${body}`
    })
    .join("\n")
}

// A tool patch carries jsdiff's context around each hunk. Asking for less drops the outer unchanged lines of each hunk
// and moves its ranges to match; context between two changes stays, as the hunk already joined them.
function trimContext(patch: string, context: number) {
  if (context >= hunkContext) return patch
  const lines = patch.split("\n")

  return lines
    .reduce<{ out: string[]; skip: number }>(
      (result, line, index) => {
        if (index < result.skip) return result
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)

        if (!header) {
          result.out.push(line)

          return result
        }

        const end = lines.findIndex((next, at) => at > index && !/^[ +\-\\]/.test(next))
        const body = lines.slice(index + 1, end === -1 ? lines.length : end)
        const first = body.findIndex((row) => row.startsWith("+") || row.startsWith("-"))
        const last = body.reduce((last, row, index) => row.startsWith("+") || row.startsWith("-") ? index : last, -1)
        const lead = first === -1 ? 0 : Math.max(0, first - context)
        // The first lines of trailing context, each with the no-newline marker that may annotate it.
        const tail = body.slice(last + 1)

        const keepTail = tail.filter(
          (row, at) =>
            tail.slice(0, at + (row.startsWith("\\") ? 0 : 1)).filter((item) => item.startsWith(" ")).length <= context,
        )

        const dropTail =
          tail.filter((row) => row.startsWith(" ")).length - keepTail.filter((row) => row.startsWith(" ")).length

        const kept = first === -1 ? body : [...body.slice(lead, last + 1), ...keepTail]
        const shrink = first === -1 ? 0 : lead + dropTail
        const oldStart = Number(header[1]) + (first === -1 ? 0 : lead)
        const newStart = Number(header[3]) + (first === -1 ? 0 : lead)
        const oldCount = Number(header[2] ?? 1) - shrink
        const newCount = Number(header[4] ?? 1) - shrink

        result.out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${header[5]}`, ...kept)
        result.skip = index + 1 + body.length

        return result
      },
      { out: [], skip: 0 },
    )
    .out.join("\n")
}

function collapseConcatenatedHeaders(file: string, patch: string) {
  const sections = patch.split(/^(?=diff --git )/m)
  if (sections.length <= 1) return patch
  const hunks = sections.flatMap((section) => {
    const at = section.search(/^@@ /m)
    // Only remove separator newlines; spaces and tabs belong to the final patch line.
    return at === -1 ? [] : [section.slice(at).replace(/(?:\r?\n)+$/, "")]
  })
  if (!hunks.length) return patch
  return `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${hunks.join("\n")}\n`
}

function partialFileDiff(file: string, patch: string) {
  const normalizedInput = collapseConcatenatedHeaders(file, patch)
  const parsed = splitPatch(normalizedInput)
  if (parsed) {
    if (/^(?:Index:|diff(?: -r \w+)+|---|\+\+\+)\s/m.test(parsed.header)) {
      const fromHeader = parsePatchFiles(normalizedInput, undefined, false)[0]?.files[0]
      if (fromHeader?.hunks.length) return fromHeader
    }
    if (parsed.hunks.length) {
      const synthesized = `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${parsed.body}`
      const fromBody = parsePatchFiles(synthesized, undefined, false)[0]?.files[0]
      if (fromBody?.hunks.length) return fromBody
    }
  }
  const lf = normalizedInput.replace(/\r\n/g, "\n")
  if (lf !== normalizedInput) {
    const fallback = parsePatchFiles(lf, undefined, false)[0]?.files[0]
    if (fallback?.hunks.length) return fallback
  }
  return
}

function emitHunkLines(subHunk: FileDiffMetadata["hunks"][number], subDiff: FileDiffMetadata) {
  const out: string[] = []
  const emit = (prefix: " " | "-" | "+", line: string | undefined) => {
    const value = line ?? ""
    if (value.endsWith("\n")) {
      out.push(`${prefix}${value.slice(0, -1)}`)
      return
    }
    out.push(`${prefix}${value}`, "\\ No newline at end of file")
  }
  for (const content of subHunk.hunkContent) {
    if (content.type === "context") {
      for (let i = 0; i < content.lines; i++) emit(" ", subDiff.additionLines[content.additionLineIndex + i])
      continue
    }
    for (let i = 0; i < content.deletions; i++) emit("-", subDiff.deletionLines[content.deletionLineIndex + i])
    for (let i = 0; i < content.additions; i++) emit("+", subDiff.additionLines[content.additionLineIndex + i])
  }
  return out
}

function normalizePartialPatchCrlf(file: string, patch: string, reportedAdditions: number, reportedDeletions: number) {
  const collapsed = collapseConcatenatedHeaders(file, patch)
  const start = collapsed.search(/^@@ /m)
  if (start === -1) return
  const sections = collapsed.slice(start).split(/^(?=@@ )/m)
  const emittedHunks: string[] = []
  let rawAdds = 0
  let rawDels = 0
  let lfAdds = 0
  let lfDels = 0

  for (const section of sections) {
    const lines = section.split("\n")
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[0] ?? "")
    if (!header) return
    const delStart = Number(header[1])
    const delCount = header[2] === undefined ? 1 : Number(header[2])
    const addStart = Number(header[3])
    const addCount = header[4] === undefined ? 1 : Number(header[4])
    const bodyLines = lines.slice(1)
    for (const line of bodyLines) {
      if (line.startsWith("+")) rawAdds++
      else if (line.startsWith("-")) rawDels++
    }
    const sides = reconstructHunkSides(bodyLines, delCount, addCount, true)
    if (sides.before === sides.after) continue
    const subDiff = parseDiffFromFile({ name: file, contents: sides.before }, { name: file, contents: sides.after })
    const oldBase = delCount === 0 ? delStart : delStart - 1
    const newBase = addCount === 0 ? addStart : addStart - 1
    for (const subHunk of subDiff.hunks) {
      lfAdds += subHunk.additionLines
      lfDels += subHunk.deletionLines
      const oldStart = oldBase + subHunk.deletionStart
      const newStart = newBase + subHunk.additionStart
      emittedHunks.push(
        `@@ -${oldStart},${subHunk.deletionCount} +${newStart},${subHunk.additionCount} @@`,
        ...emitHunkLines(subHunk, subDiff),
      )
    }
  }

  const baselineTotal = Math.max(rawAdds + rawDels, reportedAdditions + reportedDeletions)
  if (lfAdds + lfDels === 0) {
    return { fileDiff: emptyFileDiff(file), additions: 0, deletions: 0, eolNormalized: true, eolOnly: true }
  }
  if (lfAdds + lfDels >= baselineTotal) return
  const cleanedPatch = `Index: ${file}\n===================================================================\n--- ${file}\t\n+++ ${file}\t\n${emittedHunks.join("\n")}\n`
  const fileDiff = partialFileDiff(file, cleanedPatch)
  if (!fileDiff || !fileDiff.hunks.length) return
  fileDiff.cacheKey = highlightKey(`${file}\0lf\0${cleanedPatch}`)
  return { fileDiff, additions: lfAdds, deletions: lfDels, eolNormalized: true }
}

function fileDiffFromContent(file: string, before: string, after: string) {
  if (!before && !after) return emptyFileDiff(file)
  const key = `${file}\0${before}\0${after}`

  return cachedFileDiff(`content\0${key}`, () => {
    const value = parseDiffFromFile({ name: file, contents: before }, { name: file, contents: after })
    value.cacheKey = highlightKey(key)

    return value
  })
}

// Pierre reuses and dedups worker highlighting only for diffs that carry a cacheKey, and it treats diffs with equal
// keys as the same target. Derive the key from every input that shapes the highlighted output: the file name selects
// the language and the content selects the lines.
function highlightKey(value: string) {
  return `${value.length}:${checksum(value) ?? 0}`
}

function emptyFileDiff(file: string) {
  return parseDiffFromFile({ name: file, contents: "" }, { name: file, contents: "" })
}

function checksum(content: string): string | undefined {
  if (!content) return
  let hash = 0x811c9dc5
  for (let index = 0; index < content.length; index++) {
    hash ^= content.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
