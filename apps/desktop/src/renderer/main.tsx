import { createRoot } from 'react-dom/client'
import { App } from './App'
import '../../../../packages/ui/styles/tokens.css'
import './styles.css'
import '../../../../packages/ui/styles/reference-layout.css'
import '../../../../packages/ui/styles/reference-components.css'
import '../../../../packages/ui/styles/reference-inspector.css'
import './parity.css'

createRoot(document.getElementById('root')!).render(<App />)
