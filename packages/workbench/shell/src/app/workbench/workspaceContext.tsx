import { createContext, useContext } from 'react'
import type { WorkspaceSession } from './session'

const WorkspaceContext = createContext<WorkspaceSession | null>(null)
export const WorkspaceSessionProvider = WorkspaceContext.Provider
export function useOptionalWorkspaceSession() {
	return useContext(WorkspaceContext)
}
export function useWorkspaceSession(): WorkspaceSession {
	const session = useOptionalWorkspaceSession()
	if (!session) throw new Error('WorkspaceSessionProvider required')
	return session
}
