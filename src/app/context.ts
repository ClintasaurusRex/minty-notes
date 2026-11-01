import { createContext, useContext, useSyncExternalStore } from 'react'
import type { BackupState } from '../backup/backupService'
import type { LockState } from '../platform/editorLock'
import { appUpdate, type AppUpdateState } from '../platform/serviceWorker'
import type { StoreState } from '../store/workspaceStore'
import type { Services } from './services'

export const ServicesContext = createContext<Services | null>(null)

export function useServices(): Services {
  const s = useContext(ServicesContext)
  if (!s) throw new Error('ServicesContext is missing')
  return s
}

/** Subscribe to a slice of workspace state. Selectors must return stored references. */
export function useWorkspace<T>(selector: (state: StoreState) => T): T {
  const { store } = useServices()
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()))
}

export function useBackupState(): BackupState {
  const { backup } = useServices()
  return useSyncExternalStore(backup.subscribe, backup.getState)
}

export function useLockState(): LockState {
  const { lock } = useServices()
  return useSyncExternalStore(lock.subscribe, lock.getState)
}

export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(appUpdate.subscribe, appUpdate.getState)
}
