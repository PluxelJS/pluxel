import { createContext, useContext } from 'react'
import { WorkspaceController, useWorkspaceState } from './workspace'

// Keep the shared context separate from Fast Refresh component boundaries.
export const WorkspaceContext = createContext<WorkspaceController | null>(null)

export function useWorkspace() {
	const workspace = useContext(WorkspaceContext)
	if (!workspace) throw new Error('No open workspace')
	return useWorkspaceState(workspace)
}
