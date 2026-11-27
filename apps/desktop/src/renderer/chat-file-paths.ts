import { resolveWorkspaceFilePath } from './workspace-paths'

/** Resolve filename-only references emitted by the assistant before creating an editor tab. */
export async function resolveChatFilePath(rawPath: string, projectDirectory: string | undefined, listFiles: () => Promise<string[]>) {
  const ref = resolveWorkspaceFilePath(rawPath, projectDirectory)
  if (!ref || ref.path.includes('/')) return ref
  const files = await listFiles()
  // A real root-level file takes precedence over nested files with the same name.
  if (files.includes(ref.path)) return ref
  const matches = files.filter(file => file.endsWith(`/${ref.path}`))
  if (matches.length > 1) throw new Error(`Có nhiều tệp tên ${ref.path}. Hãy mở từ Explorer hoặc dùng đường dẫn đầy đủ:\n${matches.join('\n')}`)
  return matches.length === 1 ? { ...ref, path: matches[0] } : ref
}
