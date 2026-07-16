import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const entry = process.argv[2]
if (!entry) throw new Error('Usage: node core-bench-node-runner.mjs <entry.ts>')

// Historical benchmark sources used extensionless relative TypeScript imports. Node deliberately
// requires explicit extensions, so preserve only that legacy resolution behavior while leaving
// parsing and type stripping to Node itself.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (
			context.parentURL &&
			(specifier.startsWith('./') || specifier.startsWith('../')) &&
			!extname(specifier)
		) {
			const unresolved = new URL(specifier, context.parentURL)
			for (const extension of ['.ts', '.tsx', '.mts', '.cts']) {
				const candidate = new URL(`${unresolved.href}${extension}`)
				if (existsSync(candidate)) return nextResolve(candidate.href, context)
			}
		}
		return nextResolve(specifier, context)
	},
})

await import(pathToFileURL(resolve(entry)).href)
