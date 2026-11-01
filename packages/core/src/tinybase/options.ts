import type { TinyBaseOptions } from './types'

/** Resolve the fixed Core policy before any root resource can be acquired. */
export function resolveTinyBaseOptions(options: TinyBaseOptions = {}): Required<TinyBaseOptions> {
	if (!options || typeof options !== 'object' || Array.isArray(options))
		throw new TypeError('[core.tinybase] options must be an object')
	for (const key of Object.keys(options))
		if (key !== 'maxSnapshotBytes') throw new TypeError(`[core.tinybase] Unknown option: ${key}`)
	const { maxSnapshotBytes = 8 * 1024 * 1024 } = options
	if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes <= 0)
		throw new TypeError('[core.tinybase] maxSnapshotBytes must be a positive safe integer')
	return Object.freeze({ maxSnapshotBytes })
}
