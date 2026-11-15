import { Result } from '@pluxel/core/better-result'
import type { ScriptInspectionBackend } from '@pluxel/host/agent/runtime'
import { openProject, resolveInspectionRoot, copyApplication, definitionTarget } from './project'
import { InspectionError, type InspectionApplicationSelection } from './contracts'

/**
 * Bind a Host source backend to an explicit workspace/application. Each query owns
 * and drains a fresh offline scope; construction evaluates no project code and opens
 * no watcher. Paths and revisions describe current disk, never an accepted generation.
 */
export function createInspectionBackend(
	options: Readonly<{
		root: string
		application: InspectionApplicationSelection
	}>,
): ScriptInspectionBackend {
	const root = resolveInspectionRoot(options.root)
	const application = copyApplication(options.application)
	if (!application)
		throw new InspectionError(
			'invalid_input',
			'An application is required for a Host source backend.',
		)
	return async (target, query) => {
		try {
			const definition = definitionTarget(target)
			if ('application' in query)
				throw new InspectionError(
					'invalid_input',
					'A script query uses its execution target application; use openProject() to select another application.',
				)
			// Copy caller-owned data before opening the IO scope. Validation remains
			// in project.plugin; sparse or otherwise invalid arrays stay invalid.
			const captured = {
				...query,
				...(Array.isArray(query.include) ? { include: query.include.slice() } : {}),
				...(Array.isArray(query.partPath) ? { partPath: query.partPath.slice() } : {}),
			}
			await using project = await openProject({ root, signal: captured.signal })
			return Result.ok(await project.plugin(definition, { ...captured, application }))
		} catch (cause) {
			if (!(cause instanceof InspectionError)) throw cause
			return Result.err(
				Object.freeze({ code: cause.code, message: cause.message, context: cause.context }),
			)
		}
	}
}
