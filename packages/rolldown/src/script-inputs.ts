import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { API, DiagnosticCategory, type Diagnostic } from 'typescript/unstable/async'

/** One compile owns the bytes read by both the native checker and Rolldown. */
export class ScriptInputs {
	private readonly contents = new Map<string, string | null>()
	private readonly links = new Map<string, string>()
	private readonly virtualPaths = new Set<string>()
	private readonly requiredCheckedFiles = new Set<string>()
	private totalBytes = 0

	constructor(private readonly signal?: AbortSignal) {}

	/** A bundled control entry must use the declaration from its verified file map. */
	requireCheckedFile(path: string): void {
		this.requiredCheckedFiles.add(this.canonical(path))
	}

	snapshot(): ReadonlyMap<string, string> {
		return new Map(
			[...this.contents].flatMap(([path, text]) =>
				text === null || this.virtualPaths.has(path) ? [] : [[path, text]],
			),
		)
	}

	read(path: string): string | null {
		this.signal?.throwIfAborted()
		const key = resolve(path)
		if (this.contents.has(key)) return this.contents.get(key)!
		const canonical = this.canonical(key)
		if (this.contents.has(canonical)) {
			const content = this.contents.get(canonical)!
			this.contents.set(key, content)
			return content
		}
		let content: string | null
		try {
			content = readFileSync(canonical, 'utf8')
		} catch (error) {
			if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR' && error.code !== 'EISDIR')
				throw error
			content = null
		}
		this.totalBytes += content === null ? 0 : Buffer.byteLength(content)
		if (this.contents.size >= 50_000 || this.totalBytes > 128 * 1024 * 1024)
			throw new Error('Script compiler input exceeds its 50000-file / 128 MiB budget')
		this.contents.set(key, content)
		this.contents.set(canonical, content)
		return content
	}

	private canonical(path: string): string {
		const key = resolve(path)
		const previous = this.links.get(key)
		if (previous) return previous
		// Pin each lexical directory prefix before resolving its child. A later
		// atomic `current` symlink switch must not put JS from A and declarations
		// from B into the same successful compilation.
		const parent = dirname(key)
		const bound = parent === key ? key : resolve(this.canonical(parent), basename(key))
		let result: string
		try {
			result = realpathSync(bound)
		} catch (error) {
			if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
			result = bound
		}
		this.links.set(key, result)
		return result
	}

	private directoryExists(path: string): boolean {
		try {
			return statSync(this.canonical(path)).isDirectory()
		} catch (error) {
			if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
			return false
		}
	}

	async check(file: string): Promise<void> {
		let directory = dirname(file)
		let parentConfig: string | undefined
		for (;;) {
			const candidate = resolve(directory, 'tsconfig.json')
			if (this.read(candidate) !== null) {
				parentConfig = candidate
				break
			}
			const parent = dirname(directory)
			if (parent === directory) break
			directory = parent
		}
		const config = resolve(dirname(file), `.pluxel-script-${randomUUID()}.json`)
		this.virtualPaths.add(config)
		this.contents.set(
			config,
			JSON.stringify({
				...(parentConfig ? { extends: parentConfig } : {}),
				files: [file],
				include: [],
				exclude: [],
				compilerOptions: {
					...(!parentConfig
						? {
								target: 'ES2023',
								module: 'ESNext',
								moduleResolution: 'Bundler',
								strict: true,
								skipLibCheck: true,
							}
						: {}),
					noEmit: true,
					incremental: false,
					composite: false,
					declaration: false,
					emitDeclarationOnly: false,
					allowJs: true,
					checkJs: true,
				},
			}),
		)
		const api = new API({
			cwd: dirname(parentConfig ?? file),
			fs: {
				readFile: (path) => this.read(path),
				fileExists: (path) => this.read(path) !== null,
				directoryExists: (path) => this.directoryExists(path),
				realpath: (path) => this.canonical(path),
			},
		})
		const cancel = (): void => void api.close().catch((): undefined => undefined)
		this.signal?.addEventListener('abort', cancel, { once: true })
		try {
			this.signal?.throwIfAborted()
			const snapshot = await api.updateSnapshot({ openProjects: [config] })
			try {
				const project = snapshot.getProject(config)
				if (!project) throw new Error('Native TypeScript did not open the script project')
				const groups = await Promise.all([
					project.program.getConfigFileParsingDiagnostics(),
					project.program.getProgramDiagnostics(),
					project.program.getGlobalDiagnostics(),
					project.program.getSyntacticDiagnostics(),
					project.program.getSemanticDiagnostics(),
				])
				const diagnostics = groups
					.flat()
					.filter((item) => item.category === DiagnosticCategory.Error)
				if (diagnostics.length > 0)
					throw new Error(diagnostics.map((diagnostic) => this.diagnostic(diagnostic)).join('\n'))
				const checkedFiles = await project.program.getSourceFileNames()
				const checked = new Set(checkedFiles.map((path) => this.canonical(path)))
				for (const required of this.requiredCheckedFiles)
					if (!checked.has(required))
						throw new Error(
							`Native TypeScript did not consume the control declaration paired with its bundled module: ${required}`,
						)
			} finally {
				if (!this.signal?.aborted) await snapshot.dispose()
			}
		} finally {
			this.signal?.removeEventListener('abort', cancel)
			await api.close()
		}
	}

	private diagnostic(diagnostic: Diagnostic): string {
		const file = diagnostic.fileName
		const prefix = file
			? `${file}:${(this.read(file)?.slice(0, diagnostic.pos).match(/\n/g)?.length ?? 0) + 1}`
			: 'TypeScript'
		const detail = (item: Diagnostic): string =>
			[item.text, ...(item.messageChain ?? []).map(detail)].join('\n')
		return `${prefix}: TS${diagnostic.code}: ${detail(diagnostic)}`
	}
}
