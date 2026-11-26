export type GitStatusMeta = { code: string; dataStatus: 'M' | 'U' | 'D'; label: string }
export type FilePathParts = { name: string; dir: string }
export type FileTypeMeta = { kind: string; glyph?: string; label: string }

export function gitStatusMeta(raw: string): GitStatusMeta {
  switch (raw.trim()) {
    case '?': return { code: 'U', dataStatus: 'U', label: 'Untracked' }
    case 'A': return { code: 'A', dataStatus: 'U', label: 'Added' }
    case 'M': return { code: 'M', dataStatus: 'M', label: 'Modified' }
    case 'D': return { code: 'D', dataStatus: 'D', label: 'Deleted' }
    case 'R': return { code: 'R', dataStatus: 'U', label: 'Renamed' }
    case 'C': return { code: 'C', dataStatus: 'U', label: 'Copied' }
    default: return { code: raw.trim() || 'M', dataStatus: 'M', label: 'Changed' }
  }
}

export function splitFilePath(filePath: string): FilePathParts {
  const normalized = filePath.replace(/\\/g, '/')
  const separator = normalized.lastIndexOf('/')
  return { name: normalized.slice(separator + 1), dir: separator < 0 ? '' : normalized.slice(0, separator) }
}

export function fileTypeMeta(filePath: string): FileTypeMeta {
  const name = splitFilePath(filePath).name.toLowerCase()
  if (name === 'dockerfile' || name.startsWith('dockerfile.') || name.endsWith('.dockerfile')) return { kind: 'docker', glyph: 'DK', label: 'Dockerfile' }
  if (['podfile', 'fastfile', 'gemfile', 'appfile', 'matchfile', 'rakefile'].includes(name)) return { kind: 'ruby', glyph: 'RB', label: 'Ruby' }
  if (name === 'gradlew') return { kind: 'shell', glyph: '>_', label: 'Shell' }
  if (name.startsWith('.env.') || ['.editorconfig', '.gitconfig', '.gitignore', '.gitattributes', '.dockerignore', '.npmignore', 'makefile', 'gnumakefile', 'cmakelists.txt'].includes(name)) return { kind: 'config', glyph: '⚙', label: 'Config' }
  if (/\.(test|spec)\.tsx?$/.test(name)) return { kind: 'ts-test', glyph: 'TS', label: 'TypeScript Test' }
  if (/\.(ts|mts|cts|tsx)$/.test(name)) return { kind: 'ts', glyph: 'TS', label: 'TypeScript' }
  if (/\.(test|spec)\.jsx?$/.test(name)) return { kind: 'js-test', glyph: 'JS', label: 'JavaScript Test' }
  if (/\.(js|mjs|cjs|jsx)$/.test(name)) return { kind: 'js', glyph: 'JS', label: 'JavaScript' }
  if (/\.(md|mdx)$/.test(name)) return { kind: 'md', label: 'Markdown' }
  if (/\.(json|jsonc|json5|webmanifest|xcstrings|arb)$/.test(name)) return { kind: 'json', glyph: '{}', label: 'JSON' }
  if (/\.(css|scss|sass|less)$/.test(name)) return { kind: 'css', glyph: '#', label: 'Stylesheet' }
  if (/\.(html|htm|xml|svg|xaml|xsl|xsd|pom|plist|entitlements|storyboard|xib|xcscheme|xcworkspacedata)$/.test(name)) return { kind: 'markup', glyph: '<>', label: 'Markup' }
  if (/\.(yml|yaml|toml|env|ini|cfg|conf|xcconfig|mk|cmake)$/.test(name)) return { kind: 'config', glyph: '⚙', label: 'Config' }
  if (/\.(properties|pro)$/.test(name)) return { kind: 'properties', glyph: '⚙', label: 'Properties' }
  if (/\.(py|pyi)$/.test(name)) return { kind: 'py', glyph: 'PY', label: 'Python' }
  if (/\.kts?$/.test(name)) return { kind: 'kt', glyph: 'KT', label: 'Kotlin' }
  if (/\.java$/.test(name)) return { kind: 'java', glyph: 'JV', label: 'Java' }
  if (/\.go$/.test(name)) return { kind: 'go', glyph: 'GO', label: 'Go' }
  if (/\.rs$/.test(name)) return { kind: 'rs', glyph: 'RS', label: 'Rust' }
  if (/\.swift$/.test(name)) return { kind: 'swift', glyph: 'SW', label: 'Swift' }
  if (/\.dart$/.test(name)) return { kind: 'dart', glyph: 'DT', label: 'Dart' }
  if (/\.(gradle|groovy)$/.test(name)) return { kind: 'groovy', glyph: 'GR', label: 'Groovy' }
  if (/\.m$/.test(name)) return { kind: 'objc', glyph: 'OC', label: 'Objective-C' }
  if (/\.mm$/.test(name)) return { kind: 'objcpp', glyph: 'OC++', label: 'Objective-C++' }
  if (/\.(rb|podspec)$/.test(name)) return { kind: 'ruby', glyph: 'RB', label: 'Ruby' }
  if (/\.proto$/.test(name)) return { kind: 'proto', glyph: 'PB', label: 'Protocol Buffers' }
  if (/\.(c|h|pbxproj)$/.test(name)) return { kind: 'c', glyph: 'C', label: 'C' }
  if (/\.(cpp|cc|cxx|hpp|hh|hxx)$/.test(name)) return { kind: 'cpp', glyph: 'C++', label: 'C++' }
  if (/\.cs$/.test(name)) return { kind: 'csharp', glyph: 'C#', label: 'C#' }
  if (/\.php$/.test(name)) return { kind: 'php', glyph: 'PHP', label: 'PHP' }
  if (/\.sql$/.test(name)) return { kind: 'sql', glyph: 'SQL', label: 'SQL' }
  if (/\.vue$/.test(name)) return { kind: 'vue', glyph: 'V', label: 'Vue' }
  if (/\.svelte$/.test(name)) return { kind: 'svelte', glyph: 'S', label: 'Svelte' }
  if (/\.(bat|cmd)$/.test(name)) return { kind: 'bat', glyph: '>_', label: 'Batch' }
  if (/\.(sh|bash|zsh|ksh|ps1|psm1|psd1)$/.test(name)) return { kind: 'shell', glyph: '>_', label: 'Shell' }
  if (/\.(png|jpg|jpeg|gif|webp|ico)$/.test(name)) return { kind: 'image', label: 'Image' }
  return { kind: 'file', label: 'File' }
}
