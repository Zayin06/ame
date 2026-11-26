import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Inspector } from '../components/Inspector'
import { FileTypeIcon } from '../components/FileTypeIcon'
import { fileTypeMeta, gitStatusMeta, splitFilePath } from '../scm-display'
import { languageFor } from '../state'

test('gitStatusMeta normalizes display codes while retaining semantic status and fallback', () => {
  for (const [raw, code, dataStatus, label] of [
    ['?', 'U', 'U', 'Untracked'], ['A', 'A', 'U', 'Added'], ['M', 'M', 'M', 'Modified'],
    ['D', 'D', 'D', 'Deleted'], ['R', 'R', 'U', 'Renamed'], ['C', 'C', 'U', 'Copied'],
    [' X ', 'X', 'M', 'Changed'], [' ', 'M', 'M', 'Changed'], [' M ', 'M', 'M', 'Modified'],
  ]) assert.deepEqual(gitStatusMeta(raw), { code, dataStatus, label })
})

test('splitFilePath separates root files and nested Windows, POSIX and mixed paths', () => {
  for (const [path, name, dir] of [
    ['README.md', 'README.md', ''], ['src/ui/app.ts', 'app.ts', 'src/ui'],
    ['src\\ui\\app.ts', 'app.ts', 'src/ui'], ['src\\ui/app.ts', 'app.ts', 'src/ui'], ['', '', ''],
  ]) assert.deepEqual(splitFilePath(path), { name, dir })
})

test('fileTypeMeta resolves test suffixes before language extensions using only the lowercase basename', () => {
  const types: [string[], string, string | undefined, string][] = [
    [['ts', 'mts', 'cts', 'tsx'], 'ts', 'TS', 'TypeScript'],
    [['test.ts', 'spec.ts', 'test.tsx', 'spec.tsx'], 'ts-test', 'TS', 'TypeScript Test'],
    [['js', 'mjs', 'cjs', 'jsx'], 'js', 'JS', 'JavaScript'],
    [['test.js', 'spec.js', 'test.jsx', 'spec.jsx'], 'js-test', 'JS', 'JavaScript Test'],
    [['md', 'mdx'], 'md', undefined, 'Markdown'], [['json', 'jsonc'], 'json', '{}', 'JSON'],
    [['css', 'scss', 'sass', 'less'], 'css', '#', 'Stylesheet'],
    [['html', 'htm', 'xml', 'svg'], 'markup', '<>', 'Markup'],
    [['yml', 'yaml', 'toml', 'env'], 'config', '⚙', 'Config'],
    [['py'], 'py', 'PY', 'Python'], [['kt', 'kts'], 'kt', 'KT', 'Kotlin'],
    [['java'], 'java', 'JV', 'Java'], [['go'], 'go', 'GO', 'Go'], [['rs'], 'rs', 'RS', 'Rust'],
    [['sh', 'ps1'], 'shell', '>_', 'Shell'],
    [['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico'], 'image', undefined, 'Image'],
  ]
  for (const [extensions, kind, glyph, label] of types) {
    for (const extension of extensions) {
      const expected = glyph ? { kind, glyph, label } : { kind, label }
      assert.deepEqual(fileTypeMeta(`src\\FILE.${extension.toUpperCase()}`), expected)
    }
  }
  assert.deepEqual(fileTypeMeta('.env'), { kind: 'config', glyph: '⚙', label: 'Config' })
  for (const path of ['unknown.bin', 'LICENSE', 'directory.test.ts/file', 'src.json\\file']) {
    assert.deepEqual(fileTypeMeta(path), { kind: 'file', label: 'File' })
  }
})

test('languageFor recognizes normalized mobile, web, native and configuration filenames', () => {
  const languages: Record<string, string[]> = {
    kotlin: ['kt', 'kts'], java: ['java'], groovy: ['gradle', 'groovy'],
    xml: ['xml', 'svg', 'xaml', 'xsl', 'xsd', 'pom', 'plist', 'entitlements', 'storyboard', 'xib', 'xcscheme', 'xcworkspacedata'],
    properties: ['properties', 'pro'], proto: ['proto'], swift: ['swift'], 'objective-c': ['m'], 'objective-cpp': ['mm'],
    ini: ['ini', 'cfg', 'conf', 'xcconfig'], c: ['c', 'h', 'pbxproj'], ruby: ['rb', 'podspec'],
    json: ['json', 'webmanifest', 'xcstrings', 'arb'], dart: ['dart'], typescript: ['ts', 'mts', 'cts'], tsx: ['tsx'],
    javascript: ['js', 'mjs', 'cjs'], jsx: ['jsx'], jsonc: ['jsonc', 'json5'], css: ['css'], scss: ['scss'], sass: ['sass'], less: ['less'],
    html: ['html', 'htm'], vue: ['vue'], svelte: ['svelte'], astro: ['astro'], markdown: ['md'], mdx: ['mdx'], graphql: ['graphql', 'gql'],
    python: ['py', 'pyi'], rust: ['rs'], go: ['go'], cpp: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'], csharp: ['cs'], php: ['php'], sql: ['sql'],
    shellscript: ['sh', 'bash', 'zsh', 'ksh'], powershell: ['ps1', 'psm1', 'psd1'], bat: ['bat', 'cmd'], yaml: ['yaml', 'yml'], toml: ['toml'],
    makefile: ['mk'], cmake: ['cmake'], hcl: ['tf', 'hcl'], lua: ['lua'], r: ['r'], scala: ['scala'], elixir: ['ex', 'exs'], dockerfile: ['dockerfile'],
  }
  for (const [language, extensions] of Object.entries(languages)) {
    for (const extension of extensions) {
      for (const path of [`src/file.${extension}`, `src\\FILE.${extension.toUpperCase()}`]) {
        assert.equal(languageFor(path), language, path)
      }
    }
  }
  const basenames: Record<string, string[]> = {
    dotenv: ['.env', '.env.local', '.env.production'], dockerfile: ['Dockerfile', 'Dockerfile.dev'],
    makefile: ['Makefile', 'GNUMakefile'], cmake: ['CMakeLists.txt'],
    ruby: ['Podfile', 'Fastfile', 'Gemfile', 'Appfile', 'Matchfile', 'Rakefile'], shellscript: ['gradlew'],
    ini: ['.editorconfig', '.gitconfig', '.gitignore', '.gitattributes', '.dockerignore', '.npmignore'],
    plaintext: ['', 'LICENSE', 'unknown.bin', 'dockerfileish', '.envish', 'ts', 'src.ts/file', 'src.json\\file'],
  }
  for (const [language, names] of Object.entries(basenames)) {
    for (const name of names) {
      assert.equal(languageFor(name), language, name)
      assert.equal(languageFor(`src\\${name.toUpperCase()}`), language, name)
    }
  }
})

test('fileTypeMeta provides glyph-backed mobile and additional source icons without CSS dependencies', () => {
  const types: [string[], string, string, string][] = [
    [['file.swift'], 'swift', 'SW', 'Swift'], [['file.dart'], 'dart', 'DT', 'Dart'],
    [['build.gradle', 'file.groovy'], 'groovy', 'GR', 'Groovy'],
    [['file.m'], 'objc', 'OC', 'Objective-C'], [['file.mm'], 'objcpp', 'OC++', 'Objective-C++'],
    [['Info.plist', 'Main.storyboard', 'View.xib', 'app.entitlements', 'app.xcscheme', 'contents.xcworkspacedata'], 'markup', '<>', 'Markup'],
    [['file.rb', 'app.podspec', 'Podfile', 'Fastfile', 'Gemfile', 'Appfile', 'Matchfile', 'Rakefile'], 'ruby', 'RB', 'Ruby'],
    [['Dockerfile', 'Dockerfile.dev', 'app.dockerfile'], 'docker', 'DK', 'Dockerfile'],
    [['file.proto'], 'proto', 'PB', 'Protocol Buffers'], [['file.c', 'file.h', 'project.pbxproj'], 'c', 'C', 'C'],
    [['file.cpp', 'file.cc', 'file.cxx', 'file.hpp', 'file.hh', 'file.hxx'], 'cpp', 'C++', 'C++'],
    [['file.cs'], 'csharp', 'C#', 'C#'], [['file.php'], 'php', 'PHP', 'PHP'], [['file.sql'], 'sql', 'SQL', 'SQL'],
    [['file.bat', 'file.cmd'], 'bat', '>_', 'Batch'], [['file.properties', 'file.pro'], 'properties', '⚙', 'Properties'],
    [['file.vue'], 'vue', 'V', 'Vue'], [['file.svelte'], 'svelte', 'S', 'Svelte'],
    [['strings.xcstrings', 'strings.arb', 'app.webmanifest', 'file.json5'], 'json', '{}', 'JSON'],
    [['.env.local', '.editorconfig', '.gitignore', 'app.xcconfig', 'Makefile', 'CMakeLists.txt'], 'config', '⚙', 'Config'],
    [['gradlew', 'file.bash', 'file.zsh', 'file.ksh', 'file.psm1', 'file.psd1'], 'shell', '>_', 'Shell'],
  ]
  for (const [names, kind, glyph, label] of types) {
    for (const name of names) {
      for (const path of [`src/${name}`, `src\\${name.toUpperCase()}`]) {
        assert.deepEqual(fileTypeMeta(path), { kind, glyph, label }, path)
        const html = renderToStaticMarkup(createElement(FileTypeIcon, { path }))
        assert.ok(html.includes(`file-type-icon--${kind}" aria-hidden="true"`), path)
        assert.match(html, /class="file-type-icon__glyph"/)
        assert.doesNotMatch(html, /<svg/)
      }
    }
  }
  for (const path of ['Dockerfile.ts/file', 'Podfile/file', 'folder.swift\\unknown', '.env.local/file']) {
    assert.deepEqual(fileTypeMeta(path), { kind: 'file', label: 'File' })
  }
})

test('Inspector SSR renders rich staged/working rows without changing diff or wand contracts', () => {
  const html = renderToStaticMarkup(createElement(Inspector, {
    projectID: 'project', connected: true, tab: 'git', generation: 0,
    git: { branch: 'main', changes: [
      { path: 'src/app.ts', index: 'M', working: ' ' },
      { path: 'src/app.test.ts', index: ' ', working: 'M' },
      { path: 'docs/README.md', index: '?', working: '?' },
      { path: 'config/package.json', index: ' ', working: 'D' },
    ] }, gitError: '',
    setTab() {}, refresh() {}, onOpen() {}, onRename() {}, onDelete() {}, onDiff() {}, onHide() {}, report() {},
  }))
  assert.match(html, /class="scm-count-pill">1<\/span>/)
  assert.match(html, /class="scm-count-pill">3<\/span>/)
  assert.equal((html.match(/class="scm-list"/g) || []).length, 2)
  assert.equal((html.match(/class="scm-section__toggle" aria-expanded="true"/g) || []).length, 2)
  const rows = [...html.matchAll(/<div class="scm-file-row" data-status="([MUD])">([\s\S]*?)(?=<div class="scm-file-row"|<\/section>)/g)]
  assert.equal(rows.length, 4)
  for (const [index, [path, status, code, label, kind]] of [
    ['src/app.ts', 'M', 'M', 'Modified', 'ts'],
    ['src/app.test.ts', 'M', 'M', 'Modified', 'ts-test'],
    ['docs/README.md', 'U', 'U', 'Untracked', 'md'],
    ['config/package.json', 'D', 'D', 'Deleted', 'json'],
  ].entries()) {
    const row = rows[index][2], { name, dir } = splitFilePath(path)
    assert.equal(rows[index][1], status)
    assert.ok(row.includes(`title="${index === 0 ? 'Staged' : 'Changes'}: ${path}"`))
    assert.ok(row.includes(`<span class="scm-file-name">${name}</span><span class="scm-file-dir">${dir}</span>`))
    assert.ok(row.includes(`class="file-type-icon file-type-icon--${kind}" aria-hidden="true"`))
    assert.ok(row.includes(`class="git-badge git-badge--${status}" title="${label}">${code}</span>`))
    assert.ok(row.includes(`aria-label="${index === 0 ? 'Bỏ stage' : 'Stage'} ${path}"`))
    assert.equal(row.includes(`aria-label="Discard ${path}"`), index !== 0)
  }
  assert.doesNotMatch(html, /class="git-badge[^"]*"[^>]*>\?</)
  assert.match(html, /class="scm-section__actions"/)
  assert.match(html, /aria-label="Unstage All"/)
  assert.match(html, /aria-label="Stage All"/)
  assert.match(html, /class="scm-enhance-icon-btn"[^>]*data-testid="scm-enhance-btn"/)
  assert.ok(html.includes('m15 4 5 5L7 22l-5-5Z'))
})

test('Inspector uses group-specific status and omits directory suffix for root files', () => {
  const html = renderToStaticMarkup(createElement(Inspector, {
    projectID: 'project', tab: 'git', generation: 0, gitError: '',
    git: { branch: 'main', changes: [
      { path: 'both.ts', index: 'A', working: 'M' },
      { path: 'README.md', index: '?', working: ' ' },
    ] },
    setTab() {}, refresh() {}, onOpen() {}, onRename() {}, onDelete() {}, onDiff() {}, onHide() {}, report() {},
  }))
  assert.match(html, /git-badge--U" title="Added">A<\/span>/)
  assert.match(html, /git-badge--M" title="Modified">M<\/span>/)
  assert.match(html, /git-badge--U" title="Untracked">U<\/span>/)
  assert.doesNotMatch(html, /class="scm-file-dir"/)
})

test('Inspector sync bar displays remote counts and publish state without depending on OpenCode', () => {
  const props = {
    projectID: 'project', connected: false, tab: 'git' as const, generation: 0, gitError: '',
    setTab() {}, refresh() {}, onOpen() {}, onRename() {}, onDelete() {}, onDiff() {}, onHide() {}, report() {},
  }
  for (const [git, pull, push, disabled] of [
    [undefined, 'Pull', 'Push', true],
    [{ branch: 'main', changes: [], hasRemote: false }, 'Pull', 'Push', true],
    [{ branch: 'main', changes: [], hasRemote: true, tracking: 'origin/main', ahead: 2, behind: 3 }, 'Pull ↓3', 'Push ↑2', false],
    [{ branch: 'main', changes: [], hasRemote: true, tracking: 'origin/main' }, 'Pull', 'Push', false],
    [{ branch: 'main', changes: [], hasRemote: true }, 'Pull', 'Publish', false],
  ] satisfies [Parameters<typeof Inspector>[0]['git'], string, string, boolean][]) {
    const html = renderToStaticMarkup(createElement(Inspector, { ...props, git }))
    assert.match(html, /data-testid="scm-sync-bar"/)
    for (const [id, text] of [['fetch', 'Fetch'], ['pull', pull], ['push', push]]) {
      const button = html.match(new RegExp(`<button[^>]*data-testid="scm-${id}-btn"([^>]*)>([^<]*)<\\/button>`))!
      assert.ok(button)
      assert.equal(button[1].includes('disabled=""'), disabled)
      assert.equal(button[2], text)
    }
    assert.match(html, /title="Fetch từ remote"/)
    assert.match(html, /aria-label="Lịch sử commit"/)
    assert.match(html, /aria-label="Quản lý Stash"/)
    assert.match(html, /data-testid="scm-expand-commit-btn"/)
  }
  for (const extra of [{ projectID: undefined }, { tab: 'files' as const }, { tab: 'search' as const }]) {
    assert.doesNotMatch(renderToStaticMarkup(createElement(Inspector, { ...props, ...extra })), /data-testid="scm-sync-bar"/)
  }
})

test('FileTypeIcon renders crisp decorative SVG icons and escaped typographic marks', () => {
  for (const [path, kind] of [['README.md', 'md'], ['image.png', 'image'], ['unknown.bin', 'file']]) {
    const html = renderToStaticMarkup(createElement(FileTypeIcon, { path }))
    assert.ok(html.includes(`file-type-icon--${kind}" aria-hidden="true"`))
    assert.match(html, /<svg/)
  }
  assert.match(renderToStaticMarkup(createElement(FileTypeIcon, { path: 'page.html' })), /&lt;&gt;/)
})
