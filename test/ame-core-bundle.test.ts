import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { test } from 'node:test'
import { OpenCode } from '@opencode/client'
import { parseDocument } from 'yaml'
import type { Release } from '../packages/amekit/src/api'
import { scanWithSource } from '../packages/amekit/src/bundle/scan'
import { pack, secretFindings, verifiedFiles } from '../packages/amekit/src/bundle/package'
import * as installer from '../packages/amekit/src/installer'
import { runtimeDiscovery, type Catalog } from '../packages/amekit/src/runtime'
import { OrchestratorConfig } from '../packages/amekit/src/orchestrator'
import { PrivateRuntime } from '../packages/opencode-adapter/src/runtime'

const createFixtureBundle = async (rootDir: string) => {
  const bundle = path.join(rootDir, 'bundle')
  const files = {
    'agents/ame-explorer.md': `---
description: Khảo sát mã nguồn hoặc tài liệu khi phạm vi đủ rộng, chỉ đọc và trả tóm tắt ngắn có bằng chứng.
mode: subagent
model: amecode/haiku
color: '#0ea5e9'
permissions:
  - action: '*'
    resource: '*'
    effect: deny
  - action: read
    resource: '*'
    effect: allow
  - action: read
    resource: '*.env'
    effect: ask
  - action: read
    resource: '*.env.*'
    effect: ask
  - action: read
    resource: '*.env.example'
    effect: allow
  - action: glob
    resource: '*'
    effect: allow
  - action: grep
    resource: '*'
    effect: allow
  - action: webfetch
    resource: '*'
    effect: allow
  - action: websearch
    resource: '*'
    effect: allow
---

Bạn là ame-explorer, hỗ trợ AME khảo sát mã nguồn hoặc tài liệu khi phạm vi đủ rộng để cần một lượt khám phá riêng.

- Chỉ đọc trong phạm vi AME giao; không ghi tệp, sửa mã, chạy lệnh hoặc thay đổi trạng thái dưới bất kỳ hình thức nào.
- Không tự mở rộng nhiệm vụ, không triển khai giải pháp, không giao việc cho agent khác.
- Ưu tiên bằng chứng trong repository. Chỉ dùng web khi thực sự cần tài liệu bên ngoài để trả lời nhiệm vụ; ghi rõ nguồn.
- Trả tóm tắt ngắn cho AME, phân biệt điều đã thấy và điều chưa xác minh. Không suy đoán thành sự thật.

Đầu ra có đúng bốn mục sau:

## File / symbol liên quan

Liệt kê ngắn các đường dẫn và symbol cần AME chú ý.

## Bằng chứng trực tiếp

Dẫn đường dẫn thật, số dòng và trích đoạn liên quan; với tài liệu ngoài, dẫn URL và đoạn hỗ trợ kết luận. Không bịa đường dẫn, số dòng hoặc trích dẫn.

## Kết luận

Tóm tắt câu trả lời trong phạm vi được giao, gắn với bằng chứng ở trên.

## Điều chưa xác minh / giới hạn phạm vi

Nêu phần chưa kiểm tra, thông tin còn thiếu hoặc giới hạn khiến kết luận chưa chắc chắn.
`,
    'agents/ame-reviewer.md': `---
description: Review độc lập các thay đổi đáng kể hoặc có rủi ro; tập trung lỗi chức năng, regression, bảo mật và trường hợp biên.
mode: subagent
model: amecode/sonnet
color: '#f59e0b'
permissions:
  - action: '*'
    resource: '*'
    effect: deny
  - action: read
    resource: '*'
    effect: allow
  - action: read
    resource: '*.env'
    effect: ask
  - action: read
    resource: '*.env.*'
    effect: ask
  - action: read
    resource: '*.env.example'
    effect: allow
  - action: glob
    resource: '*'
    effect: allow
  - action: grep
    resource: '*'
    effect: allow
  - action: shell
    resource: '*'
    effect: allow
---

Bạn là ame-reviewer, review độc lập cho AME đối với thay đổi đáng kể hoặc có rủi ro.

- Nhận diff, mục tiêu và ràng buộc từ AME; không cần toàn bộ lịch sử suy luận của AME. Tự đối chiếu mã và bằng chứng, không mặc định kết luận của AME là đúng.
- Tập trung lỗi chức năng, regression, bảo mật và trường hợp biên; không đưa nhận xét thuần phong cách hoặc sở thích cá nhân thành finding.
- Chỉ đọc và kiểm chứng; không sửa mã nguồn, ghi tệp, tự áp dụng bản sửa hoặc giao việc cho agent khác.
- Chỉ dùng shell cho kiểm chứng bằng tests, typecheck hoặc git diff. Chỉ chạy chế độ không ghi tệp; không dùng lệnh có tác dụng sửa, tạo đầu ra trên đĩa, cập nhật snapshot/cache hay thay đổi trạng thái. Nếu không thể kiểm chứng mà không ghi, báo giới hạn cho AME thay vì chạy.
- Không lặp lại các kiểm tra hợp lệ AME đã thực hiện, trừ khi có nghi ngờ cụ thể về kết quả hoặc diff đã thay đổi; nêu lý do khi cần kiểm tra lại.

Trả findings theo mức độ nghiêm trọng giảm dần. Mỗi finding phải có:

- **Severity**: mức độ nghiêm trọng.
- **Vị trí**: file:line hoặc symbol cụ thể.
- **Ảnh hưởng**: hành vi sai, điều kiện kích hoạt và hậu quả thực tế.
- **Bằng chứng**: đoạn mã, luồng thực thi hoặc kết quả kiểm chứng hỗ trợ nhận định.

Không bịa lỗi khi thiếu bằng chứng. Nếu không có finding, nói rõ chưa phát hiện lỗi trong phạm vi đã review; luôn nêu giới hạn và phần chưa kiểm chứng khi có. Báo cáo ngắn gọn cho AME, không tuyên bố an toàn tuyệt đối.
`,
    'skills/systematic-debugging/SKILL.md': `---
name: systematic-debugging
description: 'Quy trình gỡ lỗi có hệ thống cho AME: tái hiện, thu bằng chứng, kiểm tra giả thuyết, xác định nguyên nhân gốc, sửa đúng đích và kiểm tra lại trong ngữ cảnh hiện tại.'
---

# Gỡ lỗi có hệ thống

AME nạp và thực hiện skill này trực tiếp trong phiên hiện tại, giữ nguyên ngữ cảnh nhiệm vụ. Không tạo hoặc gọi agent Debugger.

Luôn tách rõ **Dữ kiện** (quan sát có bằng chứng), **Giả thuyết** (giải thích cần kiểm tra) và **Kết luận** (nhận định đã được bằng chứng hỗ trợ). Không đoán mò, sửa thử hoặc thử-sai trước khi xác định nguyên nhân gốc.

## 1. Tái hiện

Xác định hành vi mong đợi, hành vi thực tế, đầu vào, môi trường và các bước tái hiện tối thiểu. Chạy lại lỗi trong phạm vi được phép. Nếu chưa tái hiện được, ghi rõ giới hạn và yêu cầu dữ kiện còn thiếu; không giả vờ đã xác nhận lỗi.

## 2. Thu bằng chứng

Đọc mã liên quan, log, stack trace, kết quả test và thay đổi gần đây. Ghi nguồn cụ thể như đường dẫn, dòng, symbol hoặc lệnh và kết quả. Bảo toàn thay đổi không liên quan; không thu thập hay đưa bí mật vào báo cáo.

## 3. Kiểm tra giả thuyết

Liệt kê giả thuyết dựa trên dữ kiện, dự đoán kết quả nếu từng giả thuyết đúng và chọn phép kiểm tra nhỏ nhất để phân biệt chúng. Kiểm tra từng giả thuyết có chủ đích, ghi kết quả xác nhận hoặc bác bỏ; chưa sửa mã để dò may rủi.

## 4. Xác định nguyên nhân gốc

Chỉ ra chuỗi nhân quả từ đầu vào hoặc trạng thái đến lỗi, gắn từng điểm quan trọng với bằng chứng. Phân biệt nguyên nhân với triệu chứng. Nếu bằng chứng chưa đủ, quay lại thu bằng chứng hoặc kiểm tra giả thuyết thay vì tuyên bố đã tìm thấy nguyên nhân.

## 5. Sửa đúng đích

Sau khi nguyên nhân gốc đã được xác định, sửa tối thiểu đúng nơi gây lỗi, tuân thủ ràng buộc và cấu trúc hiện có. Thêm hoặc cập nhật regression test phù hợp. Không gộp refactor hay thay đổi ngoài phạm vi; không ghi đè công việc của người dùng.

## 6. Kiểm tra lại

Chạy lại tình huống tái hiện, regression test và các kiểm tra liên quan đến vùng ảnh hưởng. Đối chiếu hành vi mong đợi và kiểm tra diff cuối. Báo cáo riêng Dữ kiện, Giả thuyết còn mở và Kết luận; ghi rõ lệnh đã chạy, kết quả, phần chưa kiểm tra và rủi ro còn lại. Không tuyên bố thành công nếu chưa có bằng chứng.
`,
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(bundle, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return bundle
}
const agentIDs = ['ame-explorer', 'ame-reviewer']
const skillIDs = ['systematic-debugging']
const payloadPaths = ['agents/ame-explorer.md', 'agents/ame-reviewer.md', 'skills/systematic-debugging/SKILL.md']
const version = '1.0.0'
type Rule = { action: string; resource: string; effect: 'deny' | 'allow' | 'ask' }
const commonPermissions: Rule[] = [
  { action: '*', resource: '*', effect: 'deny' },
  { action: 'read', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
  { action: 'read', resource: '*.env.*', effect: 'ask' },
  { action: 'read', resource: '*.env.example', effect: 'allow' },
  { action: 'glob', resource: '*', effect: 'allow' },
  { action: 'grep', resource: '*', effect: 'allow' },
]
const permissionsFor = (id: string): Rule[] => [...commonPermissions,
  ...(id === 'ame-explorer' ? ['webfetch', 'websearch'] : ['shell']).map(action => ({ action, resource: '*', effect: 'allow' as const })),
]
const metadata = (text: string) => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  assert.ok(match, 'native Markdown frontmatter is required')
  const document = parseDocument(match[1], { uniqueKeys: true })
  assert.deepEqual(document.errors, [])
  return document.toJS() as { description: string; mode?: string; model?: string; color?: string; permissions?: Rule[]; name?: string; tools?: unknown }
}
const scanBundle = (bundle: string) => scanWithSource(bundle, undefined, { compatibilityMode: 'native' })
const packedBundle = async (bundle: string) => pack((await scanBundle(bundle)).preview, version)
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const cleanup = (root: string) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })

test('ame-core native import has exactly two agents and one skill with no issues or adaptations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-core-import-'))
  try {
    const bundle = await createFixtureBundle(root)
    const scanned = await scanBundle(bundle)
    assert.deepEqual(scanned.inheritedIssues, [])
    assert.deepEqual(scanned.preview.issues, [], 'no error, warning, excluded or change issues')
    assert.deepEqual(scanned.preview.agents, agentIDs)
    assert.deepEqual(scanned.preview.skills, skillIDs)
    assert.deepEqual(scanned.files.map(file => file.path).sort(), payloadPaths)
    assert.deepEqual(scanned.preview.files, scanned.files, 'native import must preserve every payload byte')
    const skill = metadata(await readFile(path.join(bundle, payloadPaths[2]), 'utf8'))
    assert.equal(skill.name, skillIDs[0])
  } finally { await cleanup(root) }
})

test('ame-core archives are deterministic, SHA-256 verified and tested against OpenCode 2.3.2', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-core-archive-'))
  try {
    const bundle = await createFixtureBundle(root)
    const source = (await scanBundle(bundle)).preview
    const first = await pack(source, version)
    const second = await pack({ ...source, files: [...source.files].reverse() }, version)
    assert.deepEqual(first.bytes, second.bytes)
    assert.equal(first.sha256, second.sha256)
    assert.equal(first.sha256, digest(first.bytes))
    const verified = await verifiedFiles(first.bytes, version, first.sha256)
    assert.deepEqual(verified.summary.compatibility, { testedOpenCode: ['2.3.2'] })
    assert.deepEqual(first.summary, verified.summary)
    assert.equal(verified.summary.agents, 2)
    assert.equal(verified.summary.skills, 1)
    assert.equal(verified.summary.fileCount, 3)
    assert.deepEqual(verified.files.map(({ path, data }) => ({ path, data })), source.files)
    for (const file of verified.files) assert.equal(digest(file.data), digest(source.files.find(input => input.path === file.path)!.data))
    await assert.rejects(verifiedFiles(first.bytes, version, '0'.repeat(64)), /HASH_MISMATCH/)
    const tampered = first.bytes.slice()
    tampered[0] ^= 1
    await assert.rejects(verifiedFiles(tampered, version, first.sha256), /HASH_MISMATCH/)
    await assert.rejects(verifiedFiles(first.bytes, '1.0.1', first.sha256), /Manifest\/version/)
  } finally { await cleanup(root) }
})

test('ame-core agents override build permissions with deny-by-default and only audited tier grants', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ame-core-permissions-'))
  try {
    const bundle = await createFixtureBundle(root)
    for (const [index, id] of agentIDs.entries()) {
      const text = await readFile(path.join(bundle, 'agents', `${id}.md`), 'utf8')
      const frontmatter = metadata(text)
      assert.deepEqual(Object.keys(frontmatter).sort(), ['color', 'description', 'mode', 'model', 'permissions'])
      assert.equal(frontmatter.mode, 'subagent')
      assert.equal(frontmatter.model, ['amecode/haiku', 'amecode/sonnet'][index])
      assert.equal(frontmatter.color, ['#0ea5e9', '#f59e0b'][index])
      assert.deepEqual(frontmatter.permissions?.[0], { action: '*', resource: '*', effect: 'deny' })
      assert.deepEqual(frontmatter.permissions, permissionsFor(id))
      assert.ok(!frontmatter.permissions.some(rule => rule.effect === 'allow' && ['edit', 'subagent', 'skill', 'todowrite', '*'].includes(rule.action)))
      assert.deepEqual(secretFindings(text), [])
      assert.doesNotMatch(text, /\b(?:explore|general|plan)\b/i)
    }
    for (const file of (await scanBundle(bundle)).files) assert.deepEqual(secretFindings(new TextDecoder().decode(file.data)), [], file.path)
  } finally { await cleanup(root) }
})

const resources = path.resolve('resources')
const executable = path.join(resources, 'opencode', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'opencode.exe' : 'opencode')
const prepared = await Promise.all([access(executable), access(path.join(resources, 'amekit-models', 'server.js'))]).then(() => true, () => false)

test('live OpenCode 2.3.2 discovers an isolated global installation with explicit agent permissions', { skip: !prepared, timeout: 90000 }, async () => {
  // Native discovery walks workspace ancestors for .agents. On Windows the
  // usual temp dir is inside the real user home, so use a drive-root sibling
  // instead to avoid the user's ancestor .agents/skills catalog entirely.
  const root = await mkdtemp(path.join(process.platform === 'win32' ? path.parse(process.cwd()).root : os.tmpdir(), '.ame-core-discovery-'))
  try {
    const bundle = await createFixtureBundle(root)
    const packed = await packedBundle(bundle)
    // Fixture metadata only: installGlobal never contacts this origin or download URL.
    const release: Release = { releaseId: '00000000-0000-4000-8000-000000000001', version, channel: 'stable', sha256: packed.sha256, size: packed.bytes.length, manifest: { ...packed.summary, schemaVersion: 1, target: 'opencode', channel: 'stable' }, publishedAt: 0, downloadUrl: 'http://127.0.0.1/unused.zip' }
    const configDir = path.join(root, 'global')
    const discover = runtimeDiscovery(executable, path.join(root, 'discovery'))
    let catalog: Catalog | undefined
    const result = await installer.installGlobal(configDir, path.join(root, 'managed'), 'http://127.0.0.1', release, packed.bytes, async (...args) => {
      assert.equal(args[3]?.scope, 'global')
      catalog = await discover(...args)
      if (!args[2]) assert.ok(!catalog.skills.some(skill => skill.name === skillIDs[0]), `isolated discovery leaked a skill: ${JSON.stringify(catalog.skills.filter(skill => skill.name === skillIDs[0]))}`)
      return catalog
    })
    assert.equal(result.changed, true)
    assert.deepEqual(result.state.agents, agentIDs)
    assert.deepEqual(result.state.skills, skillIDs)
    assert.ok(catalog)
    for (const id of agentIDs) {
      const agent = catalog.agents.find(agent => agent.id === id) as { id: string; mode?: string; permissions?: Rule[] } | undefined
      assert.ok(agent, `${id} must be discovered by the real runtime`)
      assert.equal(agent.mode, 'subagent')
      assert.ok(agent.permissions)
      // OpenCode prepends builtin defaults and appends browser safety rules.
      // The explicit wildcard deny must override those inherited build grants.
      const deny = agent.permissions.findIndex(rule => rule.action === '*' && rule.resource === '*' && rule.effect === 'deny')
      assert.ok(deny >= 0)
      assert.deepEqual(agent.permissions.slice(deny, deny + permissionsFor(id).length), permissionsFor(id))
      for (const action of ['edit', 'subagent', 'skill', 'todowrite', ...(id === 'ame-explorer' ? ['shell'] : [])]) {
        const effective: Rule | undefined = agent.permissions.filter(rule => (rule.action === '*' || rule.action === action) && rule.resource === '*').at(-1)
        assert.equal(effective?.effect, 'deny', `${id} must deny inherited ${action}`)
      }
    }
    const skill = catalog.skills.find(skill => skill.name === skillIDs[0])
    assert.ok(skill)
    assert.equal(path.resolve(skill.path), path.join(configDir, 'skills', skillIDs[0], 'SKILL.md'))
    for (const file of (await scanBundle(bundle)).files) assert.deepEqual(await readFile(path.join(configDir, file.path)), Buffer.from(file.data))
  } finally { await cleanup(root) }
})

test('live OpenCode 2.3.2 enforces API-owned orchestrator catalog permissions and dynamic updates without replacing builtins', { skip: !prepared, timeout: 90000 }, async () => {
  const root = await mkdtemp(path.resolve('.ame-core-control-'))
  const profile = path.join(root, 'profile')
  const configDir = path.join(profile, 'config', 'opencode')
  const runtime = new PrivateRuntime({ resources, profile })
  try {
    const bundle = await createFixtureBundle(root)
    await mkdir(configDir, { recursive: true })
    await cp(bundle, configDir, { recursive: true })
    await writeFile(path.join(configDir, 'agents', 'custom-agent.md'), '---\ndescription: Isolated custom catalog fixture\nmode: subagent\npermissions: [{ action: "*", resource: "*", effect: deny }]\n---\nRead-only test fixture.\n')
    const endpoint = await runtime.start()
    const headers = { authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}` }
    const client = OpenCode.make({ baseUrl: endpoint.url, headers })
    const info = await fetch(`${endpoint.url}/api/info`, { headers })
    assert.equal(info.status, 200)
    assert.equal((await info.json() as { version: string }).version, '2.3.2')
    const location = { directory: path.join(profile, 'workspace') }
    const before = (await client.agent.list({ location })).data
    const builtinIDs = ['build', 'compaction', 'title', 'summary']
    for (const id of builtinIDs) assert.ok(before.some(agent => agent.id === id), `missing builtin ${id}`)
    const orchestrator = OrchestratorConfig.parse({ id: 'ame-orchestrator', version, description: 'Local AME core fixture', prompt: 'Coordinate only the supplied managed catalog.', subagentDepth: 3 })
    const policy = {
      role: 'admin', orchestrator, expires: Date.now() + 120000,
      catalog: {
        version: 'fixture', default_model: 'fixture-default', small_model: 'fixture-haiku',
        model_levels: { default: 'fixture-default', haiku: 'fixture-haiku', sonnet: 'fixture-sonnet', opus: 'fixture-opus' },
        models: ['fixture-default', 'fixture-haiku', 'fixture-sonnet', 'fixture-opus'].map(id => ({ id, name: id, context: 128000, output: 4096, tool_call: true, vision: false })),
      },
      // No model request is made; even an accidental request cannot reach a live account.
      provider: { base_url: 'http://127.0.0.1:1/v1', api_key: 'local-test-only' },
    }
    const update = async (agents: string[]) => {
      const response = await fetch(`${endpoint.url}/api/rpc/amekit-models/update`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ input: { ...policy, managedCatalog: { agents, skills: skillIDs } } }), signal: AbortSignal.timeout(15000) })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { output: true })
      const available = (await client.agent.list({ location })).data
      const explorer = available.find(agent => agent.id === 'ame-explorer')
      const reviewer = available.find(agent => agent.id === 'ame-reviewer')
      assert.deepEqual(explorer?.model, { providerID: 'amecode', id: 'fixture-haiku' })
      assert.deepEqual(reviewer?.model, { providerID: 'amecode', id: 'fixture-sonnet' })
      const ame = available.find(agent => agent.id === 'ame-orchestrator')
      assert.ok(ame)
      assert.equal(ame.mode, 'primary')
      assert.match(ame.system!, /Coordinate only the supplied managed catalog/)
      for (const action of ['subagent', 'skill']) assert.ok(ame.permissions.some(rule => rule.action === action && rule.resource === '*' && rule.effect === 'deny'))
      assert.deepEqual(ame.permissions.filter(rule => rule.action === 'subagent' && rule.effect === 'allow').map(rule => rule.resource), agents)
      assert.deepEqual(ame.permissions.filter(rule => rule.action === 'skill' && rule.effect === 'allow').map(rule => rule.resource), skillIDs)
      for (const id of ['explore', 'general', 'plan']) assert.ok(!ame.permissions.some(rule => rule.action === 'subagent' && rule.resource === id && rule.effect === 'allow'))
      for (const id of builtinIDs) assert.deepEqual(available.find(agent => agent.id === id), before.find(agent => agent.id === id), `${id} must remain intact`)
      return ame
    }
    await update(agentIDs)
    await update([...agentIDs, 'custom-agent'])
    await update(agentIDs) // Removing a catalog member must also revoke its explicit grant.
  } finally {
    await runtime.stop()
    await cleanup(root)
  }
})
