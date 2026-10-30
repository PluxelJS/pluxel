import type { JSONContent } from '@tiptap/core'
import type {
	TypstSourceDiagnostic,
	TypstSourceComponent,
	TypstSourcePatch,
	TypstSourceProjection,
	TypstSourceResult,
} from './types.js'

/** Ordinary project-relative paths. Text and binary files are the only persisted facts. */
export type TypstSourceFiles = Readonly<Record<string, string | Uint8Array>>

export interface TypstSourceSnapshot {
	readonly revision: number
	/** Detached snapshot: changing returned byte arrays cannot change the project. */
	readonly files: TypstSourceFiles
}

export interface TypstPreparedSourceEdit {
	readonly baseRevision: number
	readonly patches: readonly TypstSourcePatch[]
}

export interface TypstSourceProjectOptions {
	readonly files: TypstSourceFiles
	/** Explicit parameter/data bindings for native template calls, owned by the template author. */
	readonly components?: readonly TypstSourceComponent[]
	/** Omitted means every existing project file is writable. Explicit paths must exist. */
	readonly writablePaths?: readonly string[]
}

/** In-memory source transactions. Persistence, filesystem watching and compilation belong to the host. */
export interface TypstSourceProject {
	/** Immutable author declarations used by every projection and insertion view. */
	readonly components: readonly TypstSourceComponent[]
	readonly revision: number
	readonly canUndo: boolean
	readonly canRedo: boolean
	snapshot(): TypstSourceSnapshot
	/** Parse and project this text file. Non-text or missing paths throw TypstSourceProjectError. */
	open(path: string): TypstSourceProjection
	/** Current syntax and statically confirmed project diagnostics. Unresolved refs are warnings. */
	diagnostics(): readonly TypstSourceDiagnostic[]
	/** Validate without accepting; apply rechecks the revision and all patches. */
	prepareEdit(input: {
		readonly projection: TypstSourceProjection
		readonly document: JSONContent
	}): TypstSourceResult<TypstPreparedSourceEdit>
	edit(input: {
		readonly projection: TypstSourceProjection
		readonly document: JSONContent
	}): TypstSourceResult<TypstSourceSnapshot>
	/** UTF-8 byte ranges in the baseline. Every patch is checked before any source changes. */
	apply(input: {
		readonly baseRevision: number
		readonly patches: readonly TypstSourcePatch[]
	}): TypstSourceResult<TypstSourceSnapshot>
	/** Rename a unique static declaration and all static references in one transaction. */
	renameLabel(input: {
		readonly baseRevision: number
		readonly from: string
		readonly to: string
	}): TypstSourceResult<TypstSourceSnapshot>
	/** Move one confirmed labelled target; literal resource paths follow the source file. */
	move(input: {
		readonly baseRevision: number
		readonly path: string
		readonly label: string
		readonly toPath: string
		/** UTF-8 insertion offset in the destination baseline. */
		readonly at: number
	}): TypstSourceResult<TypstSourceSnapshot>
	/** Copy complete top-level blocks; allocate fresh labels and rebind only copied internal refs. */
	copy(input: {
		readonly baseRevision: number
		readonly path: string
		readonly from: number
		readonly to: number
		readonly toPath: string
		/** UTF-8 insertion offset in the destination baseline. */
		readonly at: number
	}): TypstSourceResult<TypstSourceSnapshot>
	/** Undo/redo one accepted project transaction, including every affected file. */
	undo(): TypstSourceResult<TypstSourceSnapshot>
	redo(): TypstSourceResult<TypstSourceSnapshot>
	/** Accept an external complete snapshot, including invalid drafts, and reset edit history. */
	replace(input: {
		readonly baseRevision: number
		readonly files: TypstSourceFiles
	}): TypstSourceResult<TypstSourceSnapshot>
	/** Called synchronously after acceptance. Read current state with snapshot/open. */
	subscribe(listener: () => void): () => void
}
