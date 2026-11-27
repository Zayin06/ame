import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { hasUnsavedBuffers } from './buffer-recovery'
import '../../../../packages/ui/styles/tokens.css'
import './styles.css'
import '../../../../packages/ui/styles/reference-layout.css'
import '../../../../packages/ui/styles/reference-components.css'
import '../../../../packages/ui/styles/reference-inspector.css'
import './parity.css'
import './components/chat-rich.css'
import './agent-map.css'
import './chat-timeline.css'
import './settings.css'

window.addEventListener('beforeunload', event => {
  if (hasUnsavedBuffers()) { event.preventDefault(); event.returnValue = '' }
})
createRoot(document.getElementById('root')!).render(<ErrorBoundary title="Ame IDE gặp lỗi hiển thị"><App /></ErrorBoundary>)
