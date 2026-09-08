import { existsSync, statSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watch, type FSWatcher } from 'chokidar'
import { normalizePath, type Plugin, type ViteDevServer } from 'vite'
import { collectViteSsrImportFiles } from '../vite.ts'

type Resolution = { importer: string; source: string; resolved?: string; failed: boolean }
type Candidate = { entry: string; resolutions: Resolution[] }

/** Observed candidate dependencies are recovery inputs, never the committed application graph. */
export class ViteApplicationRecovery {
	private candidate?: Candidate
	private closed = false
	private files = new Set<string>()
	private packageRoots = new Set<string>()
	private watcher?: FSWatcher
	private watcherKey?: string
	private settleWatcherReady?: () => void
	private server?: ViteDevServer
	private onChange?: (file: string, type: 'create' | 'update' | 'delete') => Promise<unknown>

	readonly plugin: Plugin

	constructor() {
		const activeCandidate = () => this.candidate
		this.plugin = {
			name: 'pluxel:application-recovery',
			apply: 'serve',
			enforce: 'pre',
			async resolveId(source, importer, options) {
				const candidate = activeCandidate()
				const importerFile = importer && filePath(importer)
				if (!candidate || !options.ssr || !importerFile) return null
				const observation: Resolution = { importer: importerFile, source, failed: true }
				candidate.resolutions.push(observation)
				// Vite remains the resolution authority, including aliases, conditions and externalization.
				const resolved = await this.resolve(source, importer, {
					...options,
					skipSelf: true,
				})
				if (resolved) {
					observation.resolved = filePath(resolved.id)
					observation.failed = !observation.resolved && !isBuiltin(source)
				}
				return resolved
			},
		}
	}

	attach(
		server: ViteDevServer,
		onChange: (file: string, type: 'create' | 'update' | 'delete') => Promise<unknown>,
	): void {
		this.server = server
		this.onChange = onChange
	}

	begin(entry: string): void {
		if (this.closed) return
		this.candidate = { entry, resolutions: [] }
	}

	matches(file: string): boolean {
		const normalized = normalizePath(file)
		return (
			this.files.has(normalized) || [...this.packageRoots].some((root) => within(normalized, root))
		)
	}

	invalidationFiles(committed: ReadonlySet<string>): Set<string> {
		return new Set([...committed, ...this.files])
	}

	async failed(): Promise<{ imports: readonly Resolution[] } | undefined> {
		const candidate = this.candidate
		const server = this.server
		if (!candidate || !server || this.closed) return undefined
		const files = new Set(
			[...collectViteSsrImportFiles(server, candidate.entry)].flatMap((file) => {
				const path = filePath(file)
				return path ? [path] : []
			}),
		)
		const packageRoots = new Set<string>()
		const supplementalFiles = new Set<string>()
		const remaining = new Set(candidate.resolutions)
		const imports: Resolution[] = []
		// Failed imports may never enter Vite's graph. Follow only observations reachable from this
		// application, excluding concurrent SSR requests made while the candidate was evaluating.
		let changed = true
		while (changed) {
			changed = false
			for (const observation of remaining) {
				if (!files.has(observation.importer)) continue
				remaining.delete(observation)
				imports.push(observation)
				changed = true
				if (observation.resolved) files.add(observation.resolved)
				// Resolution may return a package entry that does not exist yet. Loading that
				// entry fails later, but its source spelling and manifest still permit recovery.
				const missingResolved = observation.resolved && !existsSync(observation.resolved)
				if (missingResolved && !within(observation.resolved!, normalizePath(server.config.root))) {
					supplementalFiles.add(observation.resolved!)
				}
				if (!observation.failed && !missingResolved) continue
				const { source, importer } = observation
				if (source.startsWith('.') || isAbsolute(source)) {
					const base = normalizePath(resolve(dirname(importer), source.split(/[?#]/, 1)[0]!))
					const candidates = new Set([`${base}/package.json`])
					for (const extension of ['', ...server.config.resolve.extensions]) {
						candidates.add(`${base}${extension}`)
						candidates.add(`${base}/index${extension}`)
					}
					// Vite can satisfy JavaScript import spellings with TypeScript source. These are
					// watch hints only: Vite still resolves the next candidate after a file appears.
					if (/\.(?:js|mjs|cjs|jsx)$/.test(base)) candidates.add(base.replace(/js(x?)$/, 'ts$1'))
					if (base.endsWith('.js')) candidates.add(`${base.slice(0, -3)}.tsx`)
					for (const file of candidates) {
						files.add(file)
						if (!within(file, normalizePath(server.config.root))) supplementalFiles.add(file)
					}
				} else if (!source.startsWith('\0') && !source.includes(':')) {
					const name = source.startsWith('@')
						? source.split('/').slice(0, 2).join('/')
						: source.split('/')[0]!
					for (let directory = dirname(importer); ; directory = dirname(directory)) {
						if (!source.startsWith('#')) {
							packageRoots.add(normalizePath(resolve(directory, 'node_modules', name)))
						}
						files.add(normalizePath(resolve(directory, 'package.json')))
						if (directory === dirname(directory)) break
					}
				}
			}
		}
		this.files = files
		this.packageRoots = packageRoots
		this.candidate = undefined
		await this.replacePackageWatcher(supplementalFiles)
		return {
			imports: imports.map(({ importer, source, resolved, failed }) => ({
				importer,
				source,
				resolved,
				failed,
			})),
		}
	}

	async committed(): Promise<void> {
		this.candidate = undefined
		this.files.clear()
		this.packageRoots.clear()
		await this.closeWatcher()
	}

	async close(): Promise<void> {
		this.closed = true
		this.candidate = undefined
		this.onChange = undefined
		await this.closeWatcher()
	}

	private async closeWatcher(): Promise<void> {
		const watcher = this.watcher
		this.watcher = undefined
		this.watcherKey = undefined
		this.settleWatcherReady?.()
		await watcher?.close()
	}

	private async replacePackageWatcher(supplementalFiles: ReadonlySet<string>): Promise<void> {
		const server = this.server!
		const roots = [...this.packageRoots, ...supplementalFiles].sort()
		const key = JSON.stringify(roots)
		if (this.watcher && this.watcherKey === key) return
		const beforeSetup = new Map(
			[...roots, ...[...this.packageRoots].map((root) => `${root}/package.json`)].map((file) => [
				file,
				fileStamp(file),
			]),
		)
		await this.closeWatcher()
		if (this.closed || server.config.server.watch === null || roots.length === 0) return
		this.watcherKey = key
		const anchors = new Set(
			roots.map((root) => {
				let anchor = root
				while (!existsSync(anchor) && dirname(anchor) !== anchor) anchor = dirname(anchor)
				return anchor
			}),
		)
		// Vite ignores node_modules and does not discover missing imports outside its root. Fill only
		// these observed gaps until the application accepts a new generation.
		const watcher = (this.watcher = watch([...anchors], {
			ignoreInitial: true,
			ignored: (path) =>
				!roots.some(
					(root) => within(normalizePath(path), root) || within(root, normalizePath(path)),
				),
		}))
		const changed = (file: string, type: 'create' | 'update' | 'delete') => {
			if (this.watcher !== watcher || !this.matches(file)) return
			void (async () => {
				await Promise.all(
					Object.values(server.environments).map((environment) =>
						environment.pluginContainer.watchChange(file, { event: type }),
					),
				)
				await this.onChange?.(normalizePath(file), type)
			})().catch((cause: unknown) => {
				const error =
					cause instanceof Error ? cause : new Error('Recovery update failed', { cause })
				server.config.logger.error('Application recovery update failed', { error })
			})
		}
		watcher.on('add', (file) => changed(file, 'create'))
		watcher.on('change', (file) => changed(file, 'update'))
		watcher.on('unlink', (file) => changed(file, 'delete'))
		await new Promise<void>((resolveReady) => {
			const settleReady = () => {
				if (this.settleWatcherReady === settleReady) this.settleWatcherReady = undefined
				resolveReady()
			}
			this.settleWatcherReady = settleReady
			watcher.once('ready', settleReady)
			// Keep the error listener for the watcher's whole lifetime. Closing during setup releases
			// the same readiness gate, so shutdown never waits for a ready event that cannot arrive.
			watcher.on('error', (cause: unknown) => {
				const error =
					cause instanceof Error ? cause : new Error('Recovery watcher failed', { cause })
				server.config.logger.error('Application recovery watcher failed', { error })
				settleReady()
			})
		})
		// ignoreInitial must not swallow an installation or creation completed while the watcher
		// was scanning. One comparison closes that setup gap without retrying unchanged failures.
		for (const [file, before] of beforeSetup) {
			const after = fileStamp(file)
			if (before === after) continue
			changed(file, after === null ? 'delete' : before === null ? 'create' : 'update')
			break
		}
	}
}

function fileStamp(file: string): string | null {
	try {
		const stat = statSync(file, { throwIfNoEntry: false })
		return stat ? `${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}` : null
	} catch {
		return null
	}
}

function filePath(id: string): string | undefined {
	if (id.includes('\0')) return undefined
	const clean = id.split(/[?#]/, 1)[0]!
	if (clean.startsWith('file:')) return normalizePath(fileURLToPath(clean))
	if (clean.startsWith('/@fs/')) return normalizePath(clean.slice(4))
	return isAbsolute(clean) ? normalizePath(clean) : undefined
}

function within(file: string, root: string): boolean {
	return file === root || file.startsWith(root.endsWith('/') ? root : `${root}/`)
}
