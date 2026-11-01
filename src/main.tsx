import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ServicesContext } from './app/context'
import { createServices } from './app/services'
import { App } from './ui/App'
import { ErrorBoundary } from './ui/ErrorBoundary'
import './index.css'
import './ui/app.css'

const root = createRoot(document.getElementById('root')!)

createServices()
  .then((services) => {
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <ServicesContext.Provider value={services}>
            <App />
          </ServicesContext.Provider>
        </ErrorBoundary>
      </StrictMode>,
    )
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    root.render(
      <div className="splash error-text" role="alert">
        Minty Notes could not start: {message}. Local storage may be disabled in this browser (for example in some private windows).
      </div>,
    )
  })
