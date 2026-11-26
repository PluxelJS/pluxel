import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pluginSourceMatcher, snapshotPluginSource, type PluginSource } from './source-contract'

function symlinkFailure(path: string): TypeError & { code: string; file: string } {
	return Object.assign(
		new TypeError(
			`[host/sources] Plugin source cannot be a symbolic link: ${path}; publish a regular file or directory`,
		),
		{ code: 'PLUGIN_SOURCE_SYMLINK', file: path },
	)
}

function isMissingPath(error: unknown): boolean {
	return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

/** @internal Resolve a validated declaration's leaf. Missing directories remain absent. */
export function resolvePluginSourcePath(source: { file: string }, root: string): Promise<string>
export function resolvePluginSourcePath(
	source: PluginSource,
	root: string,
): Promise<string | undefined>
export async function resolvePluginSourcePath(
	source: PluginSource,
	root: string,
): Promise<string | undefined> {
	if (!isAbsolute(root)) throw new TypeError('[host/sources] root must be absolute')
	const path = resolve(root, source.file ?? source.directory)
	const kind = source.file === undefined ? 'directory' : 'file'
	let status
	try {
		status = await lstat(path)
	} catch (error) {
		if (kind === 'directory' && isMissingPath(error)) return undefined
		throw error
	}
	if (status.isSymbolicLink()) throw symlinkFailure(path)
	if (kind === 'file' ? !status.isFile() : !status.isDirectory())
		throw Object.assign(new TypeError(`[host/sources] ${kind} source is not a ${kind}: ${path}`), {
			file: path,
		})
	return realpath(path)
}

/** Capture one deduplicated path snapshot, without subscribing to subsequent publications. */
export async function discoverPluginSources(options: {
	root: string
	sources: readonly PluginSource[]
}): Promise<readonly string[]> {
	if (!isAbsolute(options.root)) throw new TypeError('[host/sources] root must be absolute')
	const entries = new Set<string>()
	const sources = options.sources.map(snapshotPluginSource)
	for (const source of sources) {
		const path = await resolvePluginSourcePath(source, options.root)
		if (path === undefined) continue
		if (source.file !== undefined) {
			entries.add(path)
			continue
		}
		const matches = pluginSourceMatcher({ directory: path, include: source.include }, options.root)
		const visit = async (directory: string): Promise<void> => {
			const children = await readdir(directory, { withFileTypes: true }).catch(
				(error: unknown): [] => {
					if (!isMissingPath(error)) throw error
					return []
				},
			)
			for (const entry of children) {
				const file = resolve(directory, entry.name)
				if (entry.isDirectory()) await visit(file)
				else if ((entry.isFile() || entry.isSymbolicLink()) && matches(file)) {
					if (entry.isSymbolicLink()) {
						const target = await stat(file).catch((error: NodeJS.ErrnoException): undefined => {
							if (error.code !== 'ENOENT') throw error
							return undefined
						})
						if (target?.isDirectory()) continue
						throw symlinkFailure(file)
					}
					let canonical: string
					try {
						canonical = await resolvePluginSourcePath({ file }, options.root)
					} catch (error) {
						if (isMissingPath(error)) continue
						throw error
					}
					const name = relative(path, canonical)
					if (isAbsolute(name) || name === '..' || name.startsWith('../'))
						throw new TypeError(`[host/sources] entry escapes directory: ${file}`)
					entries.add(canonical)
				}
			}
		}
		await visit(path)
	}
	return Object.freeze([...entries].sort())
}
