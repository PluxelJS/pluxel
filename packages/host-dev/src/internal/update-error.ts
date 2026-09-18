import { isAbsolute, relative } from 'node:path'
import { normalizePath } from 'vite'

export function portableUpdatePath(file: string, root: string): string {
	const clean = normalizePath(file).split('?')[0]!
	if (!isAbsolute(clean)) return clean.slice(0, 1024)
	const local = normalizePath(relative(root, clean))
	return (local.startsWith('../') ? clean.split('/').slice(-2).join('/') : local).slice(0, 1024)
}

export function describeUpdateError(
	error: unknown,
	root: string,
	imports: readonly { importer: string; source: string; resolved?: string; failed: boolean }[] = [],
) {
	const chain: string[] = []
	const messages: string[] = []
	const seen = new Set<unknown>()
	let file: string | null = null
	const pending: unknown[] = [error]
	while (pending.length > 0 && seen.size < 8) {
		const current = pending.shift()
		if (current == null || seen.has(current)) continue
		seen.add(current)
		if (typeof current !== 'object') {
			messages.push(String(current))
			continue
		}
		const value = current as {
			message?: unknown
			id?: unknown
			file?: unknown
			importer?: unknown
			cause?: unknown
			stack?: unknown
		}
		if (typeof value.message === 'string') messages.push(value.message)
		const stackFiles =
			typeof value.stack === 'string'
				? [...value.stack.matchAll(/(?:file:\/\/)?(\/[^()\n]+?):\d+:\d+/g)].map(
						(match) => match[1]!,
					)
				: []
		const source =
			typeof value.id === 'string'
				? value.id
				: typeof value.file === 'string'
					? value.file
					: (stackFiles.find((path) => imports.some((entry) => entry.resolved === path)) ?? null)
		if (source) {
			file ??= portableUpdatePath(source, root)
			chain.push(portableUpdatePath(source, root))
		}
		if (typeof value.importer === 'string') chain.push(portableUpdatePath(value.importer, root))
		if (value.cause !== undefined) pending.push(value.cause)
		if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 8))
	}
	const failedImport =
		imports.find(
			(entry) => file && entry.resolved && portableUpdatePath(entry.resolved, root) === file,
		) ?? imports.find((entry) => entry.failed)
	if (failedImport) {
		file ??= portableUpdatePath(failedImport.resolved ?? failedImport.source, root)
		let importer: string | undefined = failedImport.importer
		const visited = new Set<string>()
		while (importer && !visited.has(importer) && visited.size < 24) {
			visited.add(importer)
			chain.unshift(portableUpdatePath(importer, root))
			importer = imports.find((entry) => entry.resolved === importer)?.importer
		}
		chain.push(file)
	}
	const message = (messages.length > 0 ? [...new Set(messages)].join(' — ') : String(error))
		.replaceAll(normalizePath(root) + '/', '')
		.replaceAll(/(?:[A-Za-z]:)?\/(?:[^\s'"()<>:]+\/)+[^\s'"()<>:]*/g, (path) =>
			portableUpdatePath(path, root),
		)
		.slice(0, 4096)
	return { message, file, importChain: [...new Set(chain)].slice(0, 32) }
}
