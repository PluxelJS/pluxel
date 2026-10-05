import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { pluginSource, pluginSourceCovers, type PluginSource } from './source-contract'

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

/** @internal Validate the declaration's leaf and return its physical path; missing directories remain absent. */
export function resolvePluginSourcePath(
	source: Extract<PluginSource, { kind: 'file' }>,
	root: string,
): Promise<string>
export function resolvePluginSourcePath(
	source: PluginSource,
	root: string,
): Promise<string | undefined>
export async function resolvePluginSourcePath(
	source: PluginSource,
	root: string,
): Promise<string | undefined> {
	if (!isAbsolute(root)) throw new TypeError('[host/sources] root must be absolute')
	const path = resolve(root, pluginSource(source).path)
	let status
	try {
		status = await lstat(path)
	} catch (error) {
		if (source.kind === 'directory' && isMissingPath(error)) return undefined
		throw error
	}
	if (status.isSymbolicLink()) throw symlinkFailure(path)
	if (source.kind === 'file' ? !status.isFile() : !status.isDirectory())
		throw Object.assign(
			new TypeError(`[host/sources] ${source.kind} source is not a ${source.kind}: ${path}`),
			{ file: path },
		)
	return realpath(path)
}

/** Capture one deduplicated path snapshot, without subscribing to subsequent publications. */
export async function discoverPluginSources(options: {
	root: string
	sources: readonly PluginSource[]
}): Promise<readonly string[]> {
	if (!isAbsolute(options.root)) throw new TypeError('[host/sources] root must be absolute')
	const entries = new Set<string>()
	for (const input of options.sources) {
		const source = pluginSource(input)
		const path = await resolvePluginSourcePath(source, options.root)
		if (path === undefined) continue
		if (source.kind === 'file') {
			entries.add(path)
			continue
		}
		const resolvedSource = pluginSource({ ...source, path })
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
				else if (
					(entry.isFile() || entry.isSymbolicLink()) &&
					pluginSourceCovers({
						source: resolvedSource,
						root: options.root,
						requirement: { kind: 'file', path: file },
					})
				) {
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
						canonical = await resolvePluginSourcePath({ kind: 'file', path: file }, options.root)
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
