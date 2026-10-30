import { parse, parseAst } from '@r4ai/typst-ast-node'
import { createTypstSourceProjectState } from './project-state.js'
import type { TypstSourceProjectOptions, TypstSourceProject } from './state-types.js'
export { TypstSourceProjectError } from './project-state.js'

/** Open an in-memory source project. The caller owns file IO and compilation. */
export function createTypstSourceProject(options: TypstSourceProjectOptions): TypstSourceProject {
	return createTypstSourceProjectState(options, { parse, parseAst })
}

export type {
	TypstSourceFiles,
	TypstSourceSnapshot,
	TypstSourceProject,
	TypstSourceProjectOptions,
} from './state-types.js'
export type {
	TypstSourceComponent,
	TypstSourceDiagnostic,
	TypstSourcePatch,
	TypstSourceProjection,
	TypstSourceResult,
	TypstSourceMapping,
	TypstSourceLabel,
	TypstSourceReference,
} from './types.js'

export { findTypstEditorPosition, findTypstSourcePosition } from './positions.js'
export type { TypstSourcePosition } from './positions.js'
