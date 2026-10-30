import init, { parse, parseAst } from '@r4ai/typst-ast-web'
import { createTypstSourceProjectState } from './project-state.js'
import type { TypstSourceProjectOptions, TypstSourceProject } from './state-types.js'
export { TypstSourceProjectError } from './project-state.js'

/** Supply the pinned parser WASM as a bundler asset URL or bytes. No Node package is loaded. */
export async function createTypstSourceProject(
	options: TypstSourceProjectOptions & { parserWasm: string | URL | Uint8Array },
): Promise<TypstSourceProject> {
	await init({ module_or_path: options.parserWasm })
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
