import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type * as Monaco from 'monaco-editor'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
import darkPlus from '@shikijs/themes/dark-plus'
import lightPlus from '@shikijs/themes/light-plus'
import { ensureMonacoShikiLanguage, shikiThemeName } from '../monaco-shiki'
import { languageFor } from '../state'

test('languageFor recognizes Android, Apple, Flutter, web, systems and DevOps paths', () => {
  const extensions: Record<string, string> = {
    kotlin: 'kt kts', java: 'java', groovy: 'gradle groovy', xml: 'xml svg xaml xsl xsd pom plist entitlements storyboard xib xcscheme xcworkspacedata',
    properties: 'properties pro', proto: 'proto', swift: 'swift', 'objective-c': 'm', 'objective-cpp': 'mm', ini: 'xcconfig ini cfg conf editorconfig gitconfig gitignore gitattributes dockerignore npmignore',
    c: 'pbxproj c h', ruby: 'podspec rb', json: 'xcstrings arb json webmanifest', dart: 'dart', typescript: 'ts mts cts', tsx: 'tsx', javascript: 'js mjs cjs', jsx: 'jsx',
    jsonc: 'jsonc json5', css: 'css', scss: 'scss', sass: 'sass', less: 'less', html: 'html htm', vue: 'vue', svelte: 'svelte', astro: 'astro', markdown: 'md', mdx: 'mdx', graphql: 'graphql gql',
    python: 'py pyi', rust: 'rs', go: 'go', cpp: 'cpp cc cxx hpp hh hxx', csharp: 'cs', php: 'php', sql: 'sql', shellscript: 'sh bash zsh ksh', powershell: 'ps1 psm1 psd1', bat: 'bat cmd', yaml: 'yaml yml',
    toml: 'toml', dotenv: 'env', dockerfile: 'dockerfile', makefile: 'mk', cmake: 'cmake', hcl: 'tf hcl', lua: 'lua', r: 'r', scala: 'scala', elixir: 'ex exs',
  }
  for (const [language, suffixes] of Object.entries(extensions)) for (const extension of suffixes.split(' ')) {
    // Ignore-file names and editor/git config are basename rules, not arbitrary suffixes.
    const basename = ['editorconfig', 'gitconfig', 'gitignore', 'gitattributes', 'dockerignore', 'npmignore'].includes(extension) ? `.${extension}` : `file.${extension}`
    for (const path of [`src/${basename}`, `C:\\PROJECT\\${basename.toUpperCase()}`]) assert.equal(languageFor(path), language, path)
  }
  for (const [language, names] of Object.entries({ ruby: ['Podfile', 'Fastfile', 'Gemfile', 'Appfile', 'Matchfile', 'Rakefile'], shellscript: ['gradlew'], dotenv: ['.env', '.env.local', '.env.production.local'], dockerfile: ['Dockerfile', 'Dockerfile.dev', 'build.dockerfile'], makefile: ['Makefile', 'GNUmakefile'], cmake: ['CMakeLists.txt'] })) {
    for (const name of names) for (const path of [name, `src\\${name.toUpperCase()}`]) assert.equal(languageFor(path), language, path)
  }
  for (const path of ['', 'LICENSE', 'file.unknown', 'file.constructor', 'file.__proto__', 'src.swift/README', 'src.ts\\unknown', 'notDockerfile', 'not.env.local']) assert.equal(languageFor(path), 'plaintext', path)
})

function monacoStub() {
  const providers = new Map<string, Monaco.languages.TokensProvider>()
  const registrations = new Map<string, number>(), configurations = new Map<string, Monaco.languages.LanguageConfiguration>()
  const themes = new Map<string, Monaco.editor.IStandaloneThemeData>()
  const calls: string[] = []
  const api = {
    languages: {
      getLanguages: () => [...registrations.keys()].map(id => ({ id })),
      register: ({ id }: { id: string }) => { registrations.set(id, (registrations.get(id) ?? 0) + 1) },
      setLanguageConfiguration: (id: string, config: Monaco.languages.LanguageConfiguration) => { assert.ok(!configurations.has(id), `duplicate configuration: ${id}`); configurations.set(id, config) },
      setTokensProvider: (id: string, provider: Monaco.languages.TokensProvider) => { assert.ok(!providers.has(id), `duplicate provider: ${id}`); providers.set(id, provider); return { dispose() {} } },
    },
    editor: {
      defineTheme: (id: string, theme: Monaco.editor.IStandaloneThemeData) => { assert.ok(!themes.has(id), `duplicate theme: ${id}`); themes.set(id, theme) },
      setTheme: (id: string) => { calls.push(id) },
      colorize: async () => '',
      create() {},
    },
  }
  return { api: api as unknown as typeof Monaco, providers, registrations, configurations, themes, calls }
}

const samples: Record<string, string> = {
  kotlin: '// comment\nval greeting = "hello"', swift: '// comment\nlet greeting = "hello"', groovy: '// comment\ndef greeting = "hello"',
  xml: '<!-- comment -->\n<root name="hello">text</root>', tsx: '// comment\nconst greeting = <div title="hello">world</div>', dart: '// comment\nfinal greeting = "hello";',
  toml: '# comment\ngreeting = "hello"\ncount = 42', properties: '# comment\ngreeting = hello\ncount = 42', shellscript: '# comment\nif true; then echo "hello"; fi', dotenv: '# comment\nGREETING="hello"\nCOUNT=42',
}

test('real JS regex grammars highlight representative keywords, strings and comments without WASM', async () => {
  const originalCompile = WebAssembly.compile, originalInstantiate = WebAssembly.instantiate
  WebAssembly.compile = (() => { throw new Error('WASM forbidden') }) as typeof WebAssembly.compile
  WebAssembly.instantiate = (() => { throw new Error('WASM forbidden') }) as typeof WebAssembly.instantiate
  const highlighter = await createHighlighterCore({ themes: [darkPlus, lightPlus], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })
  try {
    assert.deepEqual(highlighter.getLoadedLanguages(), [])
    for (const [lang, code] of Object.entries(samples)) {
      await highlighter.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages])
      for (const theme of ['dark-plus', 'light-plus']) {
        const lines = highlighter.codeToTokensBase(code, { lang, theme })
        const colors = new Set(lines.flat().filter(token => token.content.trim()).map(token => token.color))
        assert.ok(colors.size >= 3, `${lang}/${theme}: ${[...colors]}`)
        assert.ok(lines[0].every(token => token.color === lines[0][0].color), `${lang}: comment color`)
      }
    }
  } finally {
    highlighter.dispose()
    WebAssembly.compile = originalCompile
    WebAssembly.instantiate = originalInstantiate
  }
  const source = readFileSync(new URL('../monaco-shiki.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"](?:shiki['"]|.*(?:engine\/oniguruma|wasm)['"])/)
})

test('Monaco bridge deduplicates concurrent loads/providers/configuration and handles fallback themes', async () => {
  const stub = monacoStub()
  assert.equal(shikiThemeName('dark', false), 'vs-dark')
  assert.equal(shikiThemeName('light', false), 'light')
  assert.equal(shikiThemeName('dark', true), 'dark-plus')
  assert.equal(shikiThemeName('light', true), 'light-plus')
  assert.equal(await ensureMonacoShikiLanguage(stub.api, 'plaintext'), true)
  assert.equal(stub.providers.size, 0)
  assert.deepEqual([...stub.themes.keys()], ['dark-plus', 'light-plus'])
  const create = stub.api.editor.create, setTheme = stub.api.editor.setTheme
  const ids = [...Object.keys(samples), 'jsx', 'proto', 'ruby', 'makefile', 'cmake', 'vue', 'svelte', 'astro']
  const results = await Promise.all(ids.flatMap(id => Array.from({ length: 3 }, () => ensureMonacoShikiLanguage(stub.api, id))))
  assert.ok(results.every(Boolean))
  assert.equal(stub.api.editor.create, create)
  assert.equal(stub.api.editor.setTheme, setTheme)
  assert.equal(stub.providers.size, ids.length)
  for (const id of ids) assert.equal(stub.registrations.get(id), 1, id)
  for (const id of ['tsx', 'jsx', 'proto', 'groovy', 'toml', 'dotenv', 'properties', 'shellscript', 'makefile', 'cmake', 'ruby', 'vue', 'svelte', 'astro', 'dart', 'swift', 'kotlin']) assert.ok(stub.configurations.has(id), id)
  for (const theme of ['dark-plus', 'light-plus', 'vs-dark', 'light']) {
    stub.api.editor.setTheme(theme)
    for (const [id, code] of Object.entries(samples)) {
      const provider = stub.providers.get(id)!
      let state = provider.getInitialState()
      const scopes = new Set<string>()
      for (const line of code.split('\n')) {
        const result = provider.tokenize(line, state)
        state = result.endState
        result.tokens.forEach(token => scopes.add(token.scopes))
      }
      assert.ok(scopes.size >= 3, `${id}/${theme}: ${[...scopes]}`)
    }
  }
  for (const id of ['plaintext', 'unknown', '__proto__', 'constructor']) assert.equal(await ensureMonacoShikiLanguage(stub.api, id), true)
  assert.equal(stub.providers.size, ids.length)
  const second = monacoStub()
  assert.equal(await ensureMonacoShikiLanguage(second.api, 'swift'), true)
  assert.deepEqual([...second.providers.keys()], ['swift'])
  assert.equal(second.themes.size, 2)
  // A new facade/provider must not reset the already-selected light color map.
  stub.api.editor.setTheme('light-plus')
  assert.equal(await ensureMonacoShikiLanguage(stub.api, 'java'), true)
  assert.equal(stub.calls.at(-1), 'light-plus')
  const failing = monacoStub()
  failing.api.languages.setTokensProvider = () => { throw new Error('grammar registration failed') }
  assert.equal(await ensureMonacoShikiLanguage(failing.api, 'kotlin'), false)
  assert.equal(await ensureMonacoShikiLanguage(failing.api, 'plaintext'), true)
})

test('Shiki provider installation waits for an outstanding Monaco tokenizer factory', async () => {
  const stub = monacoStub()
  let release!: () => void
  let started!: () => void
  const pending = new Promise<string>(resolve => { release = () => resolve('') })
  const initializing = new Promise<void>(resolve => { started = resolve })
  let colorizeCalls = 0
  stub.api.editor.colorize = () => { colorizeCalls++; started(); return pending }
  const results = [ensureMonacoShikiLanguage(stub.api, 'kotlin'), ensureMonacoShikiLanguage(stub.api, 'kotlin')]
  await initializing
  assert.equal(stub.providers.size, 0, 'must not install before the built-in factory resolves')
  release()
  assert.deepEqual(await Promise.all(results), [true, true])
  assert.equal(colorizeCalls, 1)
  assert.equal(stub.providers.size, 1)
  assert.equal(await ensureMonacoShikiLanguage(stub.api, 'kotlin'), true)
  assert.equal(colorizeCalls, 1)
})
