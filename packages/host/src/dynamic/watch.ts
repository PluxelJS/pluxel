import { dirname, relative, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { watch } from 'chokidar'
import picomatch from 'picomatch'
import type { PluginSource, PluginSourceOpenOptions } from '../sources'
import type { DynamicPluginSource } from './declarations'

/** Watch one immutable declaration; Host owns composition and deduplication across sources. */
export async function watchDynamicSource(
	source: DynamicPluginSource,
	options: PluginSourceOpenOptions,
): ReturnType<PluginSource['open']> {
	options.signal?.throwIfAborted()
	const sourcePath = normalize(resolve(options.root, source.path))
	const root = source.kind === 'file' ? dirname(sourcePath) : sourcePath
	const pattern =
		source.kind === 'directory' ? picomatch([...source.include], { dot: true }) : undefined
	const matches = (entry: string): boolean => {
		if (source.kind === 'file') return entry === sourcePath
		const name = normalize(relative(sourcePath, entry))
		return name !== '' && !name.startsWith('../') && pattern!(name)
	}
	const entries = new Set<string>()
	let ready = false
	let closed = false
	let closing: Promise<void> | undefined
	const watcher = watch(existingAncestor(root), {
		ignoreInitial: false,
		followSymlinks: false,
		ignored: (path, stats) => {
			const normalized = normalize(resolve(path))
			if (stats?.isFile()) return !matches(normalized)
			return source.kind === 'directory'
				? !related(normalized, root)
				: normalized !== root &&
						!root.startsWith(normalized.endsWith('/') ? normalized : `${normalized}/`)
		},
	})
	const close = (): Promise<void> => {
		closed = true
		options.signal?.removeEventListener('abort', abort)
		return (closing ??= watcher.close())
	}
	const abort = (): void => {
		void close()
	}
	options.signal?.addEventListener('abort', abort, { once: true })
	for (const type of ['add', 'change', 'unlink'] as const) {
		watcher.on(type, (path) => {
			if (closed) return
			const normalized = normalize(resolve(path))
			if (!matches(normalized)) return
			if (type === 'unlink') entries.delete(normalized)
			else entries.add(normalized)
			if (ready) options.onChange(Object.freeze({ type, path: normalized }))
		})
	}
	try {
		await new Promise<void>((resolveReady, reject) => {
			const onAbort = (): void =>
				reject(options.signal?.reason ?? new Error('Source session aborted'))
			options.signal?.addEventListener('abort', onAbort, { once: true })
			watcher.once('ready', () => {
				options.signal?.removeEventListener('abort', onAbort)
				resolveReady()
			})
			watcher.on('error', (error) => {
				if (!ready) {
					options.signal?.removeEventListener('abort', onAbort)
					reject(error)
				} else if (!closed) options.onError(error)
			})
		})
		options.signal?.throwIfAborted()
		ready = true
		return Object.freeze({ entries: Object.freeze([...entries].sort()), close })
	} catch (error) {
		await close()
		throw error
	}
}

const normalize = (path: string): string => path.replaceAll('\\', '/')
function related(left: string, right: string): boolean {
	const leftPrefix = left.endsWith('/') ? left : `${left}/`
	const rightPrefix = right.endsWith('/') ? right : `${right}/`
	return left === right || left.startsWith(rightPrefix) || right.startsWith(leftPrefix)
}
function existingAncestor(path: string): string {
	while (!existsSync(path)) {
		const parent = dirname(path)
		if (parent === path) break
		path = parent
	}
	return path
}
