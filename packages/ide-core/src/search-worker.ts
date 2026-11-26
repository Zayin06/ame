import { parentPort } from 'node:worker_threads'
import { replacementText, replaceInWorkspace, searchWorkspace } from './search'
import type { SearchWorkerTask } from './search-worker-client'

parentPort!.on('message', async (task: SearchWorkerTask) => {
  try {
    const value = task.kind === 'search' ? await searchWorkspace(task.root, task.query, task.options)
      : task.kind === 'preview' ? await replaceInWorkspace(task.root, { ...task.options, dryRun: true })
        : replacementText(task.content, task.options, task.maximum)
    parentPort!.postMessage({ ok: true, value })
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'SEARCH_WORKER_FAILED', code: (error as NodeJS.ErrnoException).code })
  }
})
