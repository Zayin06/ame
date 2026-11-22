import type { Plugin } from 'vite'

// Monaco 0.55.1 drops these Delayer promises; disposal rejects them before their tasks run.
export function monacoHighlightFix(): Plugin {
  return {
    name: 'monaco-highlight-cancellation',
    enforce: 'pre',
    transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js')) return
      const calls = source.match(/this\.runDelayer\.trigger\([^\n]+\);/g)
      if (calls?.length !== 3) throw new Error('Review Monaco WordHighlighter cancellation fix for this version')
      return { code: source.replace(/(this\.runDelayer\.trigger\([^\n]+\));/g, '$1.catch(onUnexpectedError);'), map: null }
    },
  }
}
