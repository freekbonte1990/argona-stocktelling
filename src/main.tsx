import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { remoteSyncService } from './application/container'
import { startSyncScheduler } from './adapters/remote/startSyncScheduler'

startSyncScheduler(remoteSyncService)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
