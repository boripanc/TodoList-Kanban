import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { StoreProvider } from './state/store'
import { CloudProvider } from './cloud/CloudProvider'
import { createCloudApi } from './cloud/config'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <CloudProvider api={createCloudApi()}>
        <App />
      </CloudProvider>
    </StoreProvider>
  </StrictMode>,
)
