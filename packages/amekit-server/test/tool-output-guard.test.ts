import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createToolOutputGuard, type ToolAfterExecuteInput } from '../src/tool-output-guard'

test('bounds oversized grep TextContent[] once per call, preserves line boundaries and file parts, and records metadata', () => {
  const guard = createToolOutputGuard({ toolLimits: { grep: 100, glob: 80, read: 120 }, maxTurnChars: 300, minFloorChars: 40 })
  const lines = Array.from({ length: 12 }, (_, i) => `res/values-${i}/strings.xml: line ${i} matches value`).join('\n')
  const filePart = { type: 'file' as const, uri: 'file:///demo.txt', mime: 'text/plain', name: 'demo.txt' }
  const input: ToolAfterExecuteInput = {
    tool: 'grep',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    status: 'completed',
    result: {
      content: [{ type: 'text', text: lines }, filePart],
      metadata: { matches: 12 },
    },
  }
  guard.truncateAfterExecute(input)
  const content = input.result!.content as Array<{ type: string; text?: string; uri?: string }>
  assert.equal(content.length, 2)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text!, /amekit-output-guard/)
  assert.match(content[0].text!, /vượt trần 1 lệnh/)
  assert.match(content[0].text!, /limit <= 200/)
  assert.deepEqual(content[1], filePart)
  assert.equal(input.result!.metadata?.matches, 12)
  assert.equal(input.result!.metadata?.amekitTruncated, true)
  assert.equal(input.result!.metadata?.truncationReason, 'per-tool')
  assert.equal(input.result!.metadata?.originalChars, lines.length)
})

test('enforces aggregate per-turn budget across multiple reads while honoring the minimum floor and resetting on new turn', () => {
  const guard = createToolOutputGuard({ toolLimits: { grep: 100, glob: 100, read: 100 }, maxTurnChars: 130, minFloorChars: 35 })

  const first = {
    tool: 'read',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    status: 'completed' as const,
    result: { content: 'a'.repeat(90) },
  }
  guard.truncateAfterExecute(first)
  assert.equal(first.result.content, 'a'.repeat(90))
  assert.equal((first.result as { metadata?: Record<string, unknown> }).metadata?.amekitTruncated, undefined)

  // Remaining turn budget is 40 chars (130 - 90), so 80-char read hits per-turn cap.
  const second = {
    tool: 'read',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    status: 'completed' as const,
    result: { content: 'b'.repeat(80), output: '' },
  }
  guard.truncateAfterExecute(second)
  assert.equal((second.result as { metadata?: Record<string, unknown> }).metadata?.amekitTruncated, true)
  assert.equal((second.result as { metadata?: Record<string, unknown> }).metadata?.truncationReason, 'per-turn')
  assert.equal((second.result as { metadata?: Record<string, unknown> }).metadata?.keptChars, 40)

  // Once budget reaches 0, third read still preserves minFloorChars (35).
  const third = {
    tool: 'read',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    status: 'completed' as const,
    result: { output: 'c'.repeat(80) },
  }
  guard.truncateAfterExecute(third)
  assert.equal((third.result as { metadata?: Record<string, unknown> }).metadata?.keptChars, 35)

  // New message turn receives a fresh budget.
  const nextTurn = {
    tool: 'read',
    sessionID: 'ses-1',
    messageID: 'msg-2',
    status: 'completed' as const,
    result: { content: 'd'.repeat(90) },
  }
  guard.truncateAfterExecute(nextTurn)
  assert.equal(nextTurn.result.content, 'd'.repeat(90))
})

test('ignores unguarded tools, error calls, and small outputs, and avoids splitting UTF-16 surrogate pairs', () => {
  const guard = createToolOutputGuard({ toolLimits: { glob: 11 } })
  const emoji = '😀' // 2 UTF-16 code units; index 10..11 is mid-pair!
  const globInput = {
    tool: 'glob',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    status: 'completed' as const,
    result: { content: '0123456789' + emoji + 'tail' },
  }
  guard.truncateAfterExecute(globInput)
  const keptPrefix = (globInput.result.content as string).split('\n\n[amekit-output-guard:')[0]
  assert.equal(keptPrefix, '0123456789')

  const shellInput = {
    tool: 'shell',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    status: 'completed' as const,
    result: { content: 'x'.repeat(200_000) },
  }
  guard.truncateAfterExecute(shellInput)
  assert.equal(shellInput.result.content.length, 200_000)

  const errInput = {
    tool: 'grep',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    status: 'error' as const,
    error: { message: 'boom' },
  }
  guard.truncateAfterExecute(errInput as any)
  assert.equal((errInput as any).result, undefined)
})


test('mirrors identical content and output without double counting or emptying output', () => {
  const guard = createToolOutputGuard({ toolLimits: { read: 100 }, maxTurnChars: 180, minFloorChars: 40 })
  const text = 'x'.repeat(140)
  const input: ToolAfterExecuteInput = {
    tool: 'read',
    sessionID: 'ses-dup',
    messageID: 'msg-1',
    status: 'completed',
    result: {
      content: [{ type: 'text', text }],
      output: text,
    },
  }
  guard.truncateAfterExecute(input)
  const content = input.result!.content as Array<{ type: string; text?: string }>
  assert.equal(input.result!.metadata?.originalChars, 140)
  assert.equal(input.result!.metadata?.keptChars, 100)
  assert.equal(input.result!.metadata?.amekitTruncated, true)
  assert.match(content[0].text!, /amekit-output-guard/)
  assert.ok(typeof input.result!.output === 'string' && input.result!.output.length > 0, 'output field must not be emptied')
  assert.equal(input.result!.output.slice(0, 100), 'x'.repeat(100))
  assert.match(input.result!.output, /amekit-output-guard/)

  // Remaining step budget should be 180 - 100 = 80 (not 180 - 200), so a 70-char read fits untruncated.
  const followUp: ToolAfterExecuteInput = {
    tool: 'read',
    sessionID: 'ses-dup',
    messageID: 'msg-1',
    status: 'completed',
    result: { content: 'y'.repeat(70), output: 'y'.repeat(70) },
  }
  guard.truncateAfterExecute(followUp)
  assert.equal(followUp.result!.metadata?.amekitTruncated, undefined)
  assert.equal(followUp.result!.output, 'y'.repeat(70))
})
