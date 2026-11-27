import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagedCatalogGuard, EMPTY_MANAGED_CATALOG, ManagedCatalogSchema, normalizeManagedCatalog } from '../src/managed-catalog'

const root = { agent: 'ame-orchestrator', sessionID: 'root' }
const active = { agents: ['ios-lead', 'android-lead', 'third-agent', 'hidden', 'primary', 'missing'], skills: ['first-skill', 'second-skill'] }
const available = [
  { id: 'third-agent', description: 'Third capability', mode: 'subagent' },
  { id: 'android-lead', mode: 'all' },
  { id: 'ios-lead', mode: 'subagent' },
  { id: 'hidden', mode: 'subagent', hidden: true },
  { id: 'primary', mode: 'primary' },
  { id: 'explore', mode: 'subagent' },
  { id: 'general', mode: 'subagent' },
  { id: 'plan', mode: 'subagent' },
  { id: 'custom-other', mode: 'subagent' },
]
const skills = `<available_skills>
<skill><id>first-skill</id></skill>
<skill><name>second-skill</name></skill>
<skill id="second-skill"><description>By id attribute</description></skill>
<skill name='second-skill'><description>By name attribute</description></skill>
<skill><id>unmanaged</id></skill>
</available_skills>`
const context = (identity = root) => ({
  ...identity,
  tools: {
    subagent: { description: 'Delegate tasks.\n\nAvailable subagents:\n- explore\n- general\n- plan\n- custom-other', input: {} },
    skill: { description: skills, input: {} },
    other: { description: 'Untouched.\n\nAvailable subagents:\n- explore', input: {} },
  },
  system: [{ type: 'text', text: `Preserve policy\n${skills}` }, { type: 'text', text: 'Available subagents:\n- native' }],
})
const execute = (tool: string, input: unknown, identity = root) => ({ ...identity, tool, input })
const forbiddenAgent = (target: string) => ({ message: `MANAGED_SUBAGENT_FORBIDDEN: Subagent "${target}" không thuộc catalog đang kích hoạt của AME. Không fallback sang agent ngoài danh sách (như explore, general, plan); hãy báo rõ thành phần bị thiếu hoặc tự xử lý trong quyền hiện có.` })
const forbiddenSkill = (target: string) => ({ message: `MANAGED_SKILL_FORBIDDEN: Skill "${target}" không thuộc catalog đang kích hoạt của AME. Không fallback sang skill ngoài danh sách; hãy báo rõ thành phần bị thiếu hoặc tự xử lý trong quyền hiện có.` })
const emptySuffix = '\n\nAvailable subagents:\n(No managed subagents are currently active. Do not fall back to native agents such as explore, general, or plan; report the missing capability or handle the task directly within your own permissions.)'
const makeGuard = () => createManagedCatalogGuard({ getCatalog: () => active, getSession: async () => ({}), listAgents: async () => available })

test('strict bounded schema, empty default, and trim/drop/dedupe normalization', () => {
  assert.deepEqual(EMPTY_MANAGED_CATALOG, { agents: [], skills: [] })
  assert.deepEqual(normalizeManagedCatalog(), EMPTY_MANAGED_CATALOG)
  assert.deepEqual(normalizeManagedCatalog({ agents: [' third-agent ', '', 'third-agent', ' '], skills: [' second-skill ', 'second-skill'] }), { agents: ['third-agent'], skills: ['second-skill'] })
  for (const invalid of [{}, { ...active, extra: true }, { ...active, agents: [''] }, { ...active, skills: ['x'.repeat(201)] }, { ...active, agents: Array(201).fill('x') }, { ...active, skills: Array(201).fill('x') }, { ...active, skills: [1] }]) assert.equal(ManagedCatalogSchema.safeParse(invalid).success, false)
  assert.equal(ManagedCatalogSchema.safeParse({ agents: Array(200).fill('x'.repeat(200)), skills: [] }).success, true)
})

test('only subagent description is rebuilt; skills are filtered only in system parts', async () => {
  const guard = makeGuard(), input = context(), original = structuredClone(input)
  await guard.filterContext(input)
  assert.equal(input.tools.subagent.description, 'Delegate tasks.\n\nAvailable subagents:\n- android-lead: Managed AME subagent.\n- ios-lead: Managed AME subagent.\n- third-agent: Third capability')
  assert.doesNotMatch(input.tools.subagent.description, /explore|general|plan|custom-other/)
  assert.deepEqual(input.tools.skill, original.tools.skill)
  assert.deepEqual(input.tools.other, original.tools.other)
  assert.equal(input.system[1].text, original.system[1].text)
  assert.match(input.system[0].text, /^Preserve policy/)
  assert.match(input.system[0].text, /first-skill/)
  assert.equal((input.system[0].text.match(/second-skill/g) ?? []).length, 3)
  assert.doesNotMatch(input.system[0].text, /unmanaged/)
  const description = input.tools.subagent.description
  await guard.filterContext(input)
  assert.equal(input.tools.subagent.description, description)
  input.tools.subagent.description = 'No existing suffix.'
  await guard.filterContext(input)
  assert.equal(input.tools.subagent.description, 'No existing suffix.' + description.slice('Delegate tasks.'.length))
})

test('empty context has exact suffix and replaces the entire skills wrapper', async () => {
  const guard = createManagedCatalogGuard({ getCatalog: () => EMPTY_MANAGED_CATALOG, getSession: async () => ({}), listAgents: async () => available })
  const input = context()
  await guard.filterContext(input)
  assert.equal(input.tools.subagent.description, 'Delegate tasks.' + emptySuffix)
  assert.equal(input.system[0].text, 'Preserve policy\nNo managed skills are currently active.')
  input.system[0].text = 'Before <available_skills>irrelevant</available_skills> after'
  await guard.filterContext(input)
  assert.equal(input.system[0].text, 'Before No managed skills are currently active. after')
})

test('skill identifiers match actual id/name attributes and elements, not suffixed XML names', async () => {
  const guard = makeGuard()
  const input = context()
  input.system[0].text = `<available_skills>
<skill data-id="first-skill"><id>unmanaged</id></skill>
<skill other-name="second-skill"><name>unmanaged</name></skill>
<skill ns:id="first-skill"><id>unmanaged</id></skill>
<skill><id-other>first-skill</id-other></skill>
<skill><id>first-skill</name></skill>
<skill id="first-skill"><description>Allowed</description></skill>
</available_skills>`
  await guard.filterContext(input)
  assert.equal(input.system[0].text, '<available_skills>\n<skill id="first-skill"><description>Allowed</description></skill>\n</available_skills>')
})

test('context without the subagent tool filters skills without listing agents', async () => {
  const guard = createManagedCatalogGuard({ getCatalog: () => EMPTY_MANAGED_CATALOG, getSession: async () => ({}), listAgents: async () => { assert.fail('no subagent tool to rewrite') } })
  const input = { ...root, tools: { skill: { description: skills, input: {} } }, system: [{ type: 'text', text: '<available_skills></available_skills>' }] }
  await guard.filterContext(input)
  assert.equal(input.tools.skill.description, skills)
  assert.equal(input.system[0].text, 'No managed skills are currently active.')
})

test('execute uses exactly agent/id fields, normalized tool names and trimmed targets', async () => {
  const guard = makeGuard()
  await guard.assertBeforeExecute(execute(' SuBaGeNt ', { agent: ' third-agent ' }))
  await guard.assertBeforeExecute(execute(' SKILL ', { id: ' second-skill ' }))
  for (const agent of ['explore', 'general', 'plan', 'custom-other', 'hidden', 'primary', 'missing', 'THIRD-AGENT']) await assert.rejects(guard.assertBeforeExecute(execute('subagent', { agent })), forbiddenAgent(agent))
  await assert.rejects(guard.assertBeforeExecute(execute('skill', { id: 'unmanaged' })), forbiddenSkill('unmanaged'))
  for (const input of [undefined, null, [], {}, { agent: 7, id: 7 }, { agent: ' ', id: ' ' }, { subagent_type: 'third-agent', name: 'second-skill' }]) {
    await assert.rejects(guard.assertBeforeExecute(execute('subagent', input)), forbiddenAgent('(trống)'))
    await assert.rejects(guard.assertBeforeExecute(execute('skill', input)), forbiddenSkill('(trống)'))
  }
  const noop = createManagedCatalogGuard({ getCatalog: () => { assert.fail('unrelated tool') }, getSession: async () => undefined, listAgents: async () => [] })
  for (const tool of ['shell', 'task', 'namespace.subagent', 'skill_extra']) await noop.assertBeforeExecute(execute(tool, {}))
})

test('live catalog and visibility changes apply without recreating guard', async () => {
  let catalog = { agents: ['ios-lead'], skills: ['first-skill'] }, agents = available
  const guard = createManagedCatalogGuard({ getCatalog: () => catalog, getSession: async () => ({}), listAgents: async () => agents })
  await assert.rejects(guard.assertBeforeExecute(execute('subagent', { agent: 'third-agent' })), forbiddenAgent('third-agent'))
  catalog = { agents: [' third-agent ', 'third-agent'], skills: [' second-skill '] }
  await guard.assertBeforeExecute(execute('subagent', { agent: 'third-agent' }))
  await guard.assertBeforeExecute(execute('skill', { id: 'second-skill' }))
  await assert.rejects(guard.assertBeforeExecute(execute('skill', { id: 'first-skill' })), forbiddenSkill('first-skill'))
  const input = context()
  await guard.filterContext(input)
  assert.match(input.tools.subagent.description, /third-agent/)
  assert.doesNotMatch(input.tools.subagent.description, /ios-lead/)
  agents = []
  await assert.rejects(guard.assertBeforeExecute(execute('subagent', { agent: 'third-agent' })), forbiddenAgent('third-agent'))
})

test('runtime sessions are always exempt, including catalog membership and AME children', async () => {
  const guard = createManagedCatalogGuard({ getCatalog: () => ({ agents: ['compaction', 'title', 'summary'], skills: [] }), getSession: async () => { assert.fail('runtime lookup') }, listAgents: async () => { assert.fail('runtime lookup') } })
  for (const agent of ['compaction', 'title', 'summary']) {
    const identity = { agent, sessionID: 'child' }, input = context(identity), original = structuredClone(input)
    await guard.filterContext(input)
    assert.deepEqual(input, original)
    await guard.assertBeforeExecute(execute('subagent', { agent: 'explore' }, identity))
    await guard.assertBeforeExecute(execute('skill', { id: 'unmanaged' }, identity))
  }
})

test('runtime exemptions return before reading the catalog', async () => {
  const guard = createManagedCatalogGuard({ getCatalog: () => { assert.fail('runtime catalog lookup') }, getSession: async () => { assert.fail('runtime session lookup') }, listAgents: async () => { assert.fail('runtime agent lookup') } })
  for (const agent of ['compaction', 'title', 'summary']) {
    const identity = { agent, sessionID: 'child' }, input = context(identity), original = structuredClone(input)
    assert.equal(await guard.isAmeWorkSession(agent, 'child'), false)
    await guard.filterContext(input)
    assert.deepEqual(input, original)
    await guard.assertBeforeExecute(execute('subagent', { agent: 'custom-other' }, identity))
    await guard.assertBeforeExecute(execute('skill', { id: 'unmanaged' }, identity))
  }
})

test('proven standalone special entrypoints and catalog agents remain untouched', async () => {
  const guard = makeGuard()
  for (const agent of ['build', 'AndroidTranslation', 'CommitAgent', 'BuildNotes', 'third-agent']) {
    const identity = { agent, sessionID: agent }, input = context(identity), original = structuredClone(input)
    await guard.filterContext(input)
    assert.deepEqual(input, original)
    await guard.assertBeforeExecute(execute('skill', { id: 'unmanaged' }, identity))
  }
})

test('AME children and grandchildren are guarded regardless of current agent', async () => {
  const guard = createManagedCatalogGuard({ getCatalog: () => active, getSession: async id => id === 'root' ? { agent: root.agent } : { agent: 'build', parentID: id === 'grandchild' ? 'child' : 'root' }, listAgents: async () => available })
  for (const sessionID of ['child', 'grandchild']) for (const agent of ['build', 'AndroidTranslation', 'CommitAgent', 'BuildNotes', 'third-agent']) {
    await assert.rejects(guard.assertBeforeExecute(execute('subagent', { agent: 'explore' }, { agent, sessionID })), forbiddenAgent('explore'))
    await assert.rejects(guard.assertBeforeExecute(execute('skill', { id: 'unmanaged' }, { agent, sessionID })), forbiddenSkill('unmanaged'))
  }
  const standalone = createManagedCatalogGuard({ getCatalog: () => active, getSession: async id => id === 'root' ? { agent: 'third-agent' } : { parentID: 'root' }, listAgents: async () => available })
  assert.equal(await standalone.isAmeWorkSession('third-agent', 'child'), false)
})

test('missing/failed ancestry fails closed for any active catalog without caching decisions', async () => {
  for (const fails of [false, true]) {
    let catalog = { agents: ['third-agent'], skills: [] as string[] }
    const guard = createManagedCatalogGuard({ getCatalog: () => catalog, getSession: async () => { if (fails) throw Error('lookup'); return undefined }, listAgents: async () => available })
    const identity = { agent: 'unlisted-agent', sessionID: 'unknown' }
    await assert.rejects(guard.assertBeforeExecute(execute('skill', { id: 'unmanaged' }, identity)), forbiddenSkill('unmanaged'))
    catalog = { agents: [], skills: [] }
    await guard.assertBeforeExecute(execute('skill', { id: 'unmanaged' }, identity))
    catalog = { agents: ['third-agent'], skills: [] }
    await assert.rejects(guard.assertBeforeExecute(execute('skill', { id: 'unmanaged' }, identity)), forbiddenSkill('unmanaged'))
    catalog = { agents: [], skills: ['first-skill'] }
    await assert.rejects(guard.assertBeforeExecute(execute('subagent', { agent: 'explore' }, identity)), forbiddenAgent('explore'))
  }
})

test('agent lookup errors deny execution and show exact empty suffix', async () => {
  const guard = createManagedCatalogGuard({ getCatalog: () => active, getSession: async () => ({}), listAgents: async () => { throw Error('lookup') } })
  await assert.rejects(guard.assertBeforeExecute(execute('subagent', { agent: 'third-agent' })), forbiddenAgent('third-agent'))
  const input = context()
  await guard.filterContext(input)
  assert.equal(input.tools.subagent.description, 'Delegate tasks.' + emptySuffix)
})

test('session facts cache is bounded to 500 and ancestry to six ancestors, with cycle protection', async () => {
  const lookups: string[] = []
  const guard = createManagedCatalogGuard({ getCatalog: () => active, getSession: async id => { lookups.push(id); return {} }, listAgents: async () => available })
  for (let index = 0; index < 501; index++) assert.equal(await guard.isAmeWorkSession('build', String(index)), false)
  await guard.isAmeWorkSession('build', '500')
  assert.equal(lookups.length, 501)
  await guard.isAmeWorkSession('build', '0')
  assert.equal(lookups.length, 502)
  let count = 0
  const deep = createManagedCatalogGuard({ getCatalog: () => active, getSession: async id => { count++; return { agent: 'build', parentID: String(Number(id) + 1) } }, listAgents: async () => available })
  assert.equal(await deep.isAmeWorkSession('third-agent', '0'), true)
  assert.equal(count, 7)
  assert.equal(await deep.isAmeWorkSession('unlisted-agent', '0'), true)
  const emptyDeep = createManagedCatalogGuard({ getCatalog: () => EMPTY_MANAGED_CATALOG, getSession: async id => ({ parentID: id + 'x' }), listAgents: async () => available })
  assert.equal(await emptyDeep.isAmeWorkSession('unlisted-agent', '0'), false)
  const sixth = createManagedCatalogGuard({ getCatalog: () => active, getSession: async id => ({ agent: id === '6' ? root.agent : 'build', parentID: String(Number(id) + 1) }), listAgents: async () => available })
  assert.equal(await sixth.isAmeWorkSession('build', '0'), true)
  const cycle = createManagedCatalogGuard({ getCatalog: () => active, getSession: async id => ({ parentID: id }), listAgents: async () => available })
  assert.equal(await cycle.isAmeWorkSession('third-agent', 'cycle'), true)
})
