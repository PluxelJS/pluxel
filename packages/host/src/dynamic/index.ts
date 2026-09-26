import { relative, resolve } from 'node:path'
import picomatch from 'picomatch'
import type { PluginSource } from '../sources'
import { assertDynamicPluginSource, type DynamicPluginSource } from './declarations'
import { watchDynamicSource } from './watch'

export type { DynamicPluginSource } from './declarations'

/** Describe mutable file publications. Creation validates and snapshots input without starting IO. */
export function dynamicSource(declaration: DynamicPluginSource): PluginSource {
	assertDynamicPluginSource(declaration)
	const source: DynamicPluginSource =
		declaration.kind === 'file'
			? Object.freeze({ kind: 'file', path: declaration.path.trim() })
			: Object.freeze({
					kind: 'directory',
					path: declaration.path.trim(),
					include: Object.freeze(declaration.include.map((pattern) => normalize(pattern.trim()))),
				})
	return Object.freeze({
		key: JSON.stringify(['@pluxel/host/dynamic', source]),
		covers({ root, requirement }) {
			const path = normalize(resolve(root, source.path))
			const requested = normalize(resolve(root, requirement.path))
			if (source.kind === 'file') return requirement.kind === 'file' && path === requested
			if (requirement.kind === 'file') {
				const name = normalize(relative(path, requested))
				return !name.startsWith('../') && picomatch([...source.include], { dot: true })(name)
			}
			// Deliberately exact glob coverage: no speculative glob-language containment.
			const patterns = new Set(source.include.map(normalize))
			return (
				path === requested &&
				requirement.include.every((pattern) => patterns.has(normalize(pattern)))
			)
		},
		open(options) {
			return watchDynamicSource(source, options)
		},
	} satisfies PluginSource)
}

const normalize = (path: string): string => path.replaceAll('\\', '/')
