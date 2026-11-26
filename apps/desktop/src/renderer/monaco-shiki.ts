import type * as Monaco from 'monaco-editor'
import { shikiToMonaco } from '@shikijs/monaco'
import darkPlus from '@shikijs/themes/dark-plus'
import lightPlus from '@shikijs/themes/light-plus'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'

// Import core rather than the full bundle: no Oniguruma/WASM engine enters this path.
function createHighlighter() {
  return createHighlighterCore({ themes: [darkPlus, lightPlus], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) })
}
let highlighterPromise: ReturnType<typeof createHighlighter> | undefined
const loads = new Map<string, Promise<void>>()
type Api = typeof Monaco
type Bridge = { installed: Set<string>; configured: Set<string>; initialized: Map<string, Promise<unknown>>; themes: ((theme: string) => void)[]; theme: string }
const bridges = new WeakMap<Api, Bridge>()

export function shikiThemeName(theme: 'dark' | 'light', ready: boolean): string {
  return ready ? theme === 'dark' ? 'dark-plus' : 'light-plus' : theme === 'dark' ? 'vs-dark' : 'light'
}

const cStyle: Monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"', notIn: ['string'] }, { open: "'", close: "'", notIn: ['string', 'comment'] }],
  surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' }, { open: '"', close: '"' }, { open: "'", close: "'" }],
}
const configurations = new Map<string, Monaco.languages.LanguageConfiguration>([
  ...['tsx', 'jsx', 'groovy', 'proto', 'dart', 'swift', 'kotlin'].map(id => [id, cStyle] as const),
  ...['toml', 'dotenv', 'properties', 'shellscript', 'makefile', 'cmake', 'ruby'].map(id => [id, { ...cStyle, comments: { lineComment: '#' } }] as const),
  ...['vue', 'svelte', 'astro'].map((id): [string, Monaco.languages.LanguageConfiguration] => [id, { ...cStyle, comments: { blockComment: ['<!--', '-->'] }, brackets: [...cStyle.brackets!, ['<', '>']] }]),
])

// The upstream bridge patches editor.create/setTheme and returns no disposables.
// Give each incremental installation an isolated editor facade instead. Its theme
// hook is retained to keep earlier providers' color maps in sync; only NEW language
// IDs reach setTokensProvider. Thus there is one global wrapper and one provider/ID.
function install(api: Api, highlighter: Awaited<ReturnType<typeof createHighlighter>>, state: Bridge, ids: string[], defineThemes: boolean) {
  const editor = {
    defineTheme: defineThemes ? api.editor.defineTheme.bind(api.editor) : () => {},
    setTheme: (_theme: string) => {},
    create: () => {},
  }
  const facade = {
    editor,
    languages: {
      getLanguages: () => ids.map(id => ({ id })),
      setTokensProvider: api.languages.setTokensProvider.bind(api.languages),
    },
  }
  shikiToMonaco(highlighter, facade as unknown as Parameters<typeof shikiToMonaco>[1])
  state.themes.push(editor.setTheme)
  editor.setTheme(state.theme)
  ids.forEach(id => state.installed.add(id))
}

export async function ensureMonacoShikiLanguage(api: Api, langId: string): Promise<boolean> {
  try {
    const highlighter = await (highlighterPromise ??= createHighlighter().catch(error => { highlighterPromise = undefined; throw error }))
    let state = bridges.get(api)
    if (!state) {
      state = { installed: new Set(), configured: new Set(), initialized: new Map(), themes: [], theme: 'dark-plus' }
      install(api, highlighter, state, [], true)
      const originalSetTheme = api.editor.setTheme.bind(api.editor)
      const bridge = state
      api.editor.setTheme = name => {
        // @monaco-editor/react may still apply a fallback theme while initializing.
        bridge.theme = name === 'vs-dark' ? 'dark-plus' : name === 'light' || name === 'vs' ? 'light-plus' : name
        if (bridge.theme === 'dark-plus' || bridge.theme === 'light-plus') bridge.themes.forEach(setTheme => setTheme(bridge.theme))
        originalSetTheme(name)
      }
      bridges.set(api, state)
    }
    if (!Object.hasOwn(bundledLanguages, langId)) return true
    if (!api.languages.getLanguages().some(language => language.id === langId)) api.languages.register({ id: langId })
    // colorize awaits Monaco's TokenizationRegistry.getOrCreate. Drain any lazy
    // Monarch factory before installing Shiki, otherwise it can overwrite us later.
    let initialized = state.initialized.get(langId)
    if (!initialized) {
      initialized = api.editor.colorize('', langId, {}).catch(() => {})
      state.initialized.set(langId, initialized)
    }
    await initialized
    const configuration = configurations.get(langId)
    if (configuration && !state.configured.has(langId)) {
      api.languages.setLanguageConfiguration(langId, configuration)
      state.configured.add(langId)
    }
    let loading = loads.get(langId)
    if (!loading) {
      loading = highlighter.loadLanguage(bundledLanguages[langId as keyof typeof bundledLanguages]).catch(error => { loads.delete(langId); throw error })
      loads.set(langId, loading)
    }
    await loading
    if (!state.installed.has(langId)) install(api, highlighter, state, [langId], false)
    return true
  } catch {
    // Keep Monaco's existing tokenizer if an unsupported grammar fails to load.
    return false
  }
}
