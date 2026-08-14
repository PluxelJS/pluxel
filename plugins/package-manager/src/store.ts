import { readFile, readdir, rename, rm, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
	ManagedPackage,
	PackageManagerSnapshot,
	PackageMutationFailure,
	PackageMutationResult,
} from './contracts.ts'
import type {
	InstallOptions,
	PackageManifest,
	ParsedBareSpecifier,
	PnpmEngine,
	ResolvedConfig,
} from './pnpm-engine.ts'

type StoreOptions = Readonly<{
	rootDir: string
	ignoreScripts: boolean
	allowBuilds: readonly string[]
	minimumReleaseAgeMinutes: number
}>

type ManagedManifest = PackageManifest & {
	name: string
	private: true
	type: 'module'
	dependencies: Record<string, string>
}

type PackageRequest = Readonly<{
	input: string
	name: string
	wanted: string
}>

const MAX_MUTATION_INPUTS = 100
const MAX_PACKAGE_SPEC_LENGTH = 512

export class ManagedPackageStore {
	readonly rootDir: string
	readonly entriesDir: string
	private readonly manifestFile: string
	private revision = 0
	private dependenciesWithBuildScripts: readonly string[] = Object.freeze([])
	private queue: Promise<void> = Promise.resolve()
	private readonly options: StoreOptions

	constructor(
		private readonly engine: PnpmEngine,
		options: StoreOptions,
	) {
		this.options = normalizeStoreOptions(options)
		this.rootDir = resolve(this.options.rootDir)
		this.entriesDir = resolve(this.rootDir, 'entries')
		this.manifestFile = resolve(this.rootDir, 'package.json')
	}

	async initialize(): Promise<void> {
		await mkdir(this.entriesDir, { recursive: true })
		const manifest = await this.readManifest()
		await this.writeManifest(manifest)
		await this.publishEntries(await this.prepareEntries(manifest, false))
	}

	async snapshot(): Promise<PackageManagerSnapshot> {
		const manifest = await this.readManifest()
		const packages = await Promise.all(
			Object.entries(manifest.dependencies).map(async ([name, requested]) =>
				this.readManagedPackage(name, requested),
			),
		)
		return Object.freeze({
			revision: this.revision,
			engine: this.engine.engineVersion(),
			rootDir: this.rootDir,
			entriesDir: this.entriesDir,
			packages: Object.freeze(packages.sort((left, right) => left.name.localeCompare(right.name))),
			dependenciesWithBuildScripts: this.dependenciesWithBuildScripts,
		})
	}

	install(specs: readonly string[]): Promise<PackageMutationResult> {
		return this.serialize(() => this.applyInstall(specs))
	}

	remove(names: readonly string[]): Promise<PackageMutationResult> {
		return this.serialize(() => this.applyRemove(names))
	}

	private async applyInstall(specs: readonly string[]): Promise<PackageMutationResult> {
		const manifest = await this.readManifest()
		const next = cloneManifest(manifest)
		const requests = new Map<string, PackageRequest>()
		const normalized = normalizeMutationInputs(specs)
		if (normalized.tooLarge) return mutationBatchTooLarge(normalized.overflowInput)
		const failed: PackageMutationFailure[] = [...normalized.failed]
		const inputs = normalized.inputs
		for (const input of inputs) {
			try {
				const parsed = this.parseRequest(input)
				const previous = requests.get(parsed.name)
				if (previous) {
					if (previous.wanted !== parsed.wanted) {
						failed.push(
							failure(
								input,
								'INVALID_SPEC',
								new Error(`Conflicting specs for package ${parsed.name}`),
							),
						)
					}
					continue
				}
				requests.set(parsed.name, parsed)
				next.dependencies[parsed.name] = parsed.wanted
			} catch (error) {
				failed.push(failure(input, 'INVALID_SPEC', error))
			}
		}
		const valid = [...requests.values()]
		if (valid.length === 0) return mutationResult([], failed)

		try {
			await this.installManifest(next)
			return mutationResult(
				valid.map((request) => request.name),
				failed,
			)
		} catch (error) {
			return mutationResult(
				[],
				[...failed, ...valid.map((request) => failure(request.input, 'INSTALL_FAILED', error))],
			)
		}
	}

	private async applyRemove(names: readonly string[]): Promise<PackageMutationResult> {
		const manifest = await this.readManifest()
		const next = cloneManifest(manifest)
		const removed: string[] = []
		const normalized = normalizeMutationInputs(names)
		if (normalized.tooLarge) return mutationBatchTooLarge(normalized.overflowInput)
		const failed: PackageMutationFailure[] = [...normalized.failed]
		const inputs = normalized.inputs
		for (const raw of inputs) {
			const name = raw.trim()
			if (!isPackageName(name)) {
				failed.push(failure(raw, 'INVALID_SPEC', new Error('Expected an npm package name')))
				continue
			}
			if (!(name in next.dependencies)) {
				failed.push(failure(raw, 'REMOVE_FAILED', new Error('Package is not managed')))
				continue
			}
			delete next.dependencies[name]
			removed.push(name)
		}
		if (removed.length === 0) return mutationResult([], failed)

		try {
			await this.installManifest(next)
			return mutationResult(removed, failed)
		} catch (error) {
			return mutationResult(
				[],
				[...failed, ...removed.map((name) => failure(name, 'REMOVE_FAILED', error))],
			)
		}
	}

	private async installManifest(next: ManagedManifest): Promise<void> {
		let result: Awaited<ReturnType<PnpmEngine['install']>>
		try {
			result = await this.engine.install(this.installOptions(next))
		} catch (error) {
			throw new PublicMutationError('pnpm could not apply the managed dependency graph', error)
		}
		if (result.depsRequiringBuild) {
			this.dependenciesWithBuildScripts = Object.freeze([...result.depsRequiringBuild].sort())
		}

		let entries: ReadonlyMap<string, string>
		try {
			entries = await this.prepareEntries(next, true)
		} catch (error) {
			throw new PublicMutationError(
				'pnpm completed without materializing every managed direct dependency',
				error,
			)
		}

		try {
			await this.writeManifest(next)
			await this.publishEntries(entries)
		} catch (error) {
			throw new PublicMutationError(
				'the managed graph was installed but its source entries could not be published; retry the operation',
				error,
			)
		}
		this.revision += 1
	}

	private installOptions(manifest: ManagedManifest): InstallOptions {
		const config = this.engine.readConfig({ dir: this.rootDir })
		const registries = Object.fromEntries(config.registries.map((item) => [item.name, item.url]))
		const networkConfig = networkOptions(config)
		return {
			dir: this.rootDir,
			projects: [{ rootDir: this.rootDir, manifest }],
			registries,
			authHeaderByUri: config.authHeaderByUri,
			proxyConfig: {
				httpProxy: config.httpProxy,
				httpsProxy: config.httpsProxy,
				noProxy: config.noProxy,
			},
			cacheDir: config.cacheDir,
			storeDir: config.storeDir,
			networkConfig,
			nodeLinker: 'isolated',
			autoInstallPeers: true,
			preferFrozenLockfile: true,
			update: false,
			ignorePackageManifest: true,
			ignoreScripts: this.options.ignoreScripts,
			allowBuilds: Object.fromEntries(this.options.allowBuilds.map((name) => [name, true])),
			minimumReleaseAge: this.options.minimumReleaseAgeMinutes,
			returnListOfDepsRequiringBuild: true,
		}
	}

	private parseRequest(input: string): PackageRequest {
		const spec = input.trim()
		if (!spec) throw new Error('Package specifier is empty')
		if (spec.length > MAX_PACKAGE_SPEC_LENGTH) {
			throw new Error(`Package specifier must not exceed ${MAX_PACKAGE_SPEC_LENGTH} characters`)
		}
		const parsed = this.engine.parseBareSpecifier(spec)
		const name = parsedPackageName(parsed)
		if (!name || !isPackageName(name)) throw new Error('Package specifier must name an npm package')
		const wanted =
			parsed?.bareSpecifier?.trim() || parsed?.normalizedBareSpecifier?.trim() || 'latest'
		if (!isRegistrySelector(wanted)) {
			throw new Error('Package specifier must use a registry version, range, or dist-tag')
		}
		return Object.freeze({ input: spec, name, wanted })
	}

	private async readManifest(): Promise<ManagedManifest> {
		try {
			const parsed = JSON.parse(await readFile(this.manifestFile, 'utf8')) as PackageManifest
			return normalizeManifest(parsed)
		} catch (error) {
			if (readErrorCode(error) !== 'ENOENT') throw error
			return normalizeManifest({})
		}
	}

	private writeManifest(manifest: ManagedManifest): Promise<void> {
		return atomicWrite(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
	}

	private async readManagedPackage(name: string, requested: string): Promise<ManagedPackage> {
		let installedVersion: string | null = null
		let entryFile: string | null = null
		try {
			const manifest = JSON.parse(
				await readFile(
					resolve(this.rootDir, 'node_modules', ...name.split('/'), 'package.json'),
					'utf8',
				),
			) as { version?: unknown }
			if (typeof manifest.version === 'string') installedVersion = manifest.version
		} catch {}
		const expectedEntry = this.entryFile(name)
		try {
			await readFile(resolve(this.entriesDir, expectedEntry), 'utf8')
			entryFile = expectedEntry
		} catch {}
		return Object.freeze({
			name,
			requested,
			installedVersion,
			entryFile,
		})
	}

	private async prepareEntries(
		manifest: ManagedManifest,
		requireMaterialized: boolean,
	): Promise<ReadonlyMap<string, string>> {
		const expected = new Map<string, string>()
		for (const name of Object.keys(manifest.dependencies).sort()) {
			const packageManifest = resolve(
				this.rootDir,
				'node_modules',
				...name.split('/'),
				'package.json',
			)
			try {
				await readFile(packageManifest, 'utf8')
			} catch (error) {
				if (readErrorCode(error) === 'ENOENT') {
					if (requireMaterialized) {
						throw new Error(`pnpm did not materialize the direct dependency ${name}`, {
							cause: error,
						})
					}
					continue
				}
				throw error
			}
			const file = this.entryFile(name)
			const specifier = JSON.stringify(name)
			expected.set(
				file,
				[
					`export * from ${specifier}`,
					`import * as pluginModule from ${specifier}`,
					'export default pluginModule.default',
					'',
				].join('\n'),
			)
		}
		return expected
	}

	private async publishEntries(expected: ReadonlyMap<string, string>): Promise<void> {
		await mkdir(this.entriesDir, { recursive: true })
		for (const [file, content] of expected) {
			await atomicWrite(resolve(this.entriesDir, file), content)
		}
		for (const file of await readdir(this.entriesDir)) {
			if (!file.endsWith('.mjs') || expected.has(file)) continue
			await rm(resolve(this.entriesDir, file), { force: true })
		}
	}

	private entryFile(name: string): string {
		return `${Buffer.from(name).toString('base64url')}.mjs`
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task)
		this.queue = run.then(
			(): void => undefined,
			(): void => undefined,
		)
		return run
	}
}

function normalizeManifest(input: PackageManifest): ManagedManifest {
	return {
		name: '@pluxel/managed-plugins',
		private: true,
		type: 'module',
		dependencies: cleanDependencies(input.dependencies),
	}
}

function normalizeStoreOptions(input: StoreOptions): StoreOptions {
	const rootDir = input.rootDir.trim()
	if (!rootDir) throw new TypeError('Managed package rootDir must be a non-empty path')
	if (!Number.isSafeInteger(input.minimumReleaseAgeMinutes) || input.minimumReleaseAgeMinutes < 0) {
		throw new TypeError('minimumReleaseAgeMinutes must be a non-negative safe integer')
	}
	const allowBuilds = [...new Set(input.allowBuilds.map((name) => name.trim()))]
	for (const name of allowBuilds) {
		if (!isPackageName(name)) throw new TypeError(`Invalid allowBuilds package name: ${name}`)
	}
	if (input.ignoreScripts && allowBuilds.length > 0) {
		throw new TypeError('allowBuilds requires ignoreScripts=false')
	}
	if (!input.ignoreScripts && allowBuilds.length === 0) {
		throw new TypeError('ignoreScripts=false requires at least one exact allowBuilds package name')
	}
	return Object.freeze({ ...input, rootDir, allowBuilds: Object.freeze(allowBuilds) })
}

function cloneManifest(input: ManagedManifest): ManagedManifest {
	return { ...input, dependencies: { ...input.dependencies } }
}

function cleanDependencies(input: PackageManifest['dependencies']): Record<string, string> {
	const result: Record<string, string> = Object.create(null)
	for (const [name, version] of Object.entries(input ?? {})) {
		const wanted = typeof version === 'string' ? version.trim() : ''
		if (isPackageName(name) && isRegistrySelector(wanted)) {
			result[name] = wanted
		}
	}
	return result
}

function parsedPackageName(parsed: ParsedBareSpecifier | null): string | undefined {
	return parsed?.name?.trim() || parsed?.alias?.trim() || undefined
}

function isPackageName(value: string): boolean {
	return (
		value.length <= 214 &&
		/^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/.test(value)
	)
}

function isRegistrySelector(value: string): boolean {
	if (!value || value.startsWith('.') || value.includes('\0')) return false
	return !/[\\/:#?]/.test(value)
}

type NormalizedMutationInputs = Readonly<{
	inputs: readonly string[]
	failed: readonly PackageMutationFailure[]
	tooLarge: boolean
	overflowInput: string
}>

function normalizeMutationInputs(values: unknown): NormalizedMutationInputs {
	if (!Array.isArray(values)) {
		return {
			inputs: [],
			failed: [
				failure('', 'INVALID_SPEC', new TypeError('Package mutation specs must be an array')),
			],
			tooLarge: false,
			overflowInput: '',
		}
	}
	if (values.length === 0) {
		return {
			inputs: [],
			failed: [
				failure('', 'INVALID_SPEC', new Error('Package mutation requires at least one input')),
			],
			tooLarge: false,
			overflowInput: '',
		}
	}
	if (values.length > MAX_MUTATION_INPUTS) {
		return {
			inputs: [],
			failed: [],
			tooLarge: true,
			overflowInput:
				typeof values[MAX_MUTATION_INPUTS] === 'string' ? values[MAX_MUTATION_INPUTS] : '',
		}
	}

	const inputs: string[] = []
	const failed: PackageMutationFailure[] = []
	const seen = new Set<string>()
	for (let index = 0; index < values.length; index++) {
		const value = values[index]
		if (typeof value !== 'string') {
			failed.push(
				failure(
					`<item ${index + 1}>`,
					'INVALID_SPEC',
					new TypeError('Package mutation inputs must be strings'),
				),
			)
			continue
		}
		const input = value.trim()
		if (seen.has(input)) continue
		seen.add(input)
		inputs.push(input)
	}
	return { inputs, failed, tooLarge: false, overflowInput: '' }
}

function failure(
	input: string,
	code: PackageMutationFailure['code'],
	error: unknown,
): PackageMutationFailure {
	return Object.freeze({
		input,
		code,
		message:
			error instanceof PublicMutationError
				? error.message
				: error instanceof Error
					? error.message
					: String(error),
	})
}

function mutationResult(
	succeeded: readonly string[],
	failed: readonly PackageMutationFailure[],
): PackageMutationResult {
	const successes = Object.freeze([...succeeded])
	if (failed.length === 0) {
		const noFailures = Object.freeze([]) as readonly []
		return Object.freeze({ ok: true, succeeded: successes, failed: noFailures })
	}
	return Object.freeze({
		ok: false,
		succeeded: successes,
		failed: Object.freeze([...failed]) as readonly [
			PackageMutationFailure,
			...PackageMutationFailure[],
		],
	})
}

function mutationBatchTooLarge(overflowInput: string): PackageMutationResult {
	return mutationResult(
		[],
		[
			failure(
				overflowInput,
				'INVALID_SPEC',
				new Error(`A package mutation accepts at most ${MAX_MUTATION_INPUTS} unique inputs`),
			),
		],
	)
}

class PublicMutationError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause })
		this.name = 'PublicMutationError'
	}
}

function networkOptions(config: ResolvedConfig): InstallOptions['networkConfig'] {
	return {
		ca: config.ca,
		cert: config.cert,
		key: config.key,
		strictSsl: config.strictSsl,
		maxSockets: config.maxSockets,
		networkConcurrency: config.networkConcurrency,
		fetchRetries: config.fetchRetries,
		fetchRetryFactor: config.fetchRetryFactor,
		fetchRetryMintimeout: config.fetchRetryMintimeout,
		fetchRetryMaxtimeout: config.fetchRetryMaxtimeout,
		fetchTimeout: config.fetchTimeout,
		userAgent: config.userAgent,
	}
}

async function atomicWrite(file: string, content: string): Promise<void> {
	await mkdir(resolve(file, '..'), { recursive: true })
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
	try {
		await writeFile(temporary, content, 'utf8')
		await rename(temporary, file)
	} catch (error) {
		await rm(temporary, { force: true }).catch((): undefined => undefined)
		throw error
	}
}

function readErrorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' && 'code' in error
		? String((error as { code?: unknown }).code)
		: undefined
}
