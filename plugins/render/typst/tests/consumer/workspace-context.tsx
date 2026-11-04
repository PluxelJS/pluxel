import { createContext, useContext } from 'react'
import type { WorkbenchInstance } from '@worksplit/react'
import type { AnyRouter } from '@tanstack/react-router'
import type { Editor } from '@tiptap/core'
import type { ExampleId } from './examples'
import type { WorkspaceFolders } from './file-explorer'

export type CaretSelection = {
	path: string
	position: number
	explicit: boolean
	serial: number
	editor?: Editor
}
export type FileFocus = {
	folder: ExampleId
	path: string
	position?: number
	source?: boolean
	serial: number
}
export type WorkspaceContextValue = {
	folders: WorkspaceFolders
	workbench: WorkbenchInstance<AnyRouter>
	active: { folder: ExampleId; path: string }
	focus?: FileFocus
	selections: Partial<Record<ExampleId, CaretSelection>>
	pending: Readonly<Record<string, { folder: ExampleId; pending: boolean }>>
	openFile(folder: ExampleId, path: string, position?: number, source?: boolean): Promise<void>
	selectCaret(folder: ExampleId, value: Omit<CaretSelection, 'serial'>): void
	setPending(id: string, folder: ExampleId, pending: boolean): void
	save(folder: ExampleId): boolean
	report(message: string): void
}

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)
export function useWorkspace() {
	const value = useContext(WorkspaceContext)
	if (!value) throw new Error('Workspace view requires its host')
	return value
}
