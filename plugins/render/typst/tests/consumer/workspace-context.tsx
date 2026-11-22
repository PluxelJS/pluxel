import { createContext, useContext } from 'react'
import type { WorkbenchInstance, ContentHandle } from '@worksplit/react'
import type { AnyRouter } from '@tanstack/react-router'
import type { TypstSourcePosition } from '@pluxel/plugin-typst/source/browser'
import type { ExampleId } from './examples'
import type { WorkspaceFolders } from './file-explorer'

export type CaretRequest = (
	| {
			kind: 'editor'
			position: number
	  }
	| {
			kind: 'source'
			point: TypstSourcePosition
	  }
) & {
	path: string
	explicit: boolean
	revision: number
}
export type CaretSelection = CaretRequest & { serial: number }
export type FileLocation = (
	| { kind: 'editor'; position: number }
	| { kind: 'source'; point: TypstSourcePosition }
) & { revision: number }
export type FileFocus = {
	folder: ExampleId
	path: string
	location?: FileLocation
	serial: number
}
export type WorkspaceContextValue = {
	folders: WorkspaceFolders
	workbench: WorkbenchInstance<AnyRouter>
	active: { folder: ExampleId; path: string }
	focus?: FileFocus
	selections: Partial<Record<ExampleId, CaretSelection>>
	pending: Readonly<Record<string, { folder: ExampleId; pending: boolean }>>
	openFile(
		folder: ExampleId,
		path: string,
		options?: { location?: FileLocation; source?: ContentHandle },
	): Promise<void>
	selectCaret(folder: ExampleId, value: CaretRequest): void
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
