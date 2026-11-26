import { realpathSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Node's own exports resolver, forced to ESM conditions, also supports import-only entries. */
export function resolveNativeImport(root: string, specifier: string): string {
	const parentURL = pathToFileURL(join(root, '__pluxel_resolve__.mjs')).href
	const hook = registerHooks({
		resolve(source, context, next) {
			return source === specifier && context.parentURL === parentURL
				? next(source, { ...context, conditions: ['node', 'import', 'default'] })
				: next(source, context)
		},
	})
	try {
		return realpathSync(createRequire(parentURL).resolve(specifier))
	} finally {
		hook.deregister()
	}
}
