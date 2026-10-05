import {
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	mkdir,
	writeFile,
	stat,
	lstat,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
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
	/** Revokes publication; native installation still drains before close resolves. */
	signal?: AbortSignal
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

type PublishedPackage = Readonly<{
	name: string
	requested: string
	fingerprint: string
	bytes: string
	packageRoot: string
	target: string
}>
type PublishedInstallation = Readonly<{
	version: 1
	directory: string
	packages: readonly PublishedPackage[]
}>

const MAX_MUTATION_INPUTS = 100
const MAX_PACKAGE_SPEC_LENGTH = 512

export class ManagedPackageStore {
	readonly rootDir: string
	readonly entriesDir: string
	private revision = 0
	private installation?: PublishedInstallation
	private writer = false
	private closed = false
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
	}

	async initialize(): Promise<void> {
		this.assertOpen()
		if (this.writer) throw new Error('Package store is already initialized')
		await mkdir(this.rootDir, { recursive: true })
		try {
			await mkdir(resolve(this.rootDir, '.writer'))
			this.writer = true
		} catch (cause) {
			if (readErrorCode(cause) !== 'EEXIST') throw cause
			throw Object.assign(
				new Error(
					'Managed package store already has a writer. Close that process; remove a stale .writer only during offline maintenance.',
					{ cause },
				),
				{ code: 'PACKAGE_STORE_WRITER_CONFLICT' },
			)
		}
		try {
			await writeFile(
				resolve(this.rootDir, '.writer/owner.json'),
				JSON.stringify({ pid: process.pid }),
			)
			await mkdir(this.entriesDir, { recursive: true })
			this.installation = await this.readInstallation()
			if (!this.installation) {
				try {
					const legacy = JSON.parse(await readFile(resolve(this.rootDir, 'package.json'), 'utf8'))
					if (Object.keys(legacy.dependencies ?? {}).length > 0)
						throw new Error(
							'Managed packages lack an immutable published installation. Convert the store offline before startup.',
						)
				} catch (error) {
					if (readErrorCode(error) !== 'ENOENT') throw error
				}
			}
			const expected = this.publishedEntries(this.installation?.packages ?? [])
			const actual = await readdir(this.entriesDir)
			if (actual.some((file) => file.endsWith('.mjs') && !expected.has(file)))
				throw new Error(
					'Managed entries disagree with published installation; repair offline before startup',
				)
			for (const [file, content] of expected)
				if ((await readFile(resolve(this.entriesDir, file), 'utf8')) !== content)
					throw new Error(
						'Managed entry disagrees with published installation; repair offline before startup',
					)
		} catch (error) {
			await this.releaseWriter()
			throw error
		}
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
		const inputs = normalizeMutationInputs(specs)
		return this.serialize(() => this.applyInstall(inputs))
	}

	remove(names: readonly string[]): Promise<PackageMutationResult> {
		const inputs = normalizeMutationInputs(names)
		return this.serialize(() => this.applyRemove(inputs))
	}

	private async applyInstall(normalized: NormalizedMutationInputs): Promise<PackageMutationResult> {
		const manifest = await this.readManifest()
		const next = cloneManifest(manifest)
		const requests = new Map<string, PackageRequest>()
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
			if (error instanceof EntryPublicationError) {
				const pending = new Set(error.unpublished)
				return mutationResult(
					valid.filter((request) => !pending.has(request.name)).map((request) => request.name),
					[
						...failed,
						...error.unpublished.map((name) =>
							failure(requests.get(name)?.input ?? name, 'INSTALL_FAILED', error),
						),
						...(pending.size > 0 ? [] : [failure('', 'INSTALL_FAILED', error)]),
					],
				)
			}
			return mutationResult(
				[],
				[...failed, ...valid.map((request) => failure(request.input, 'INSTALL_FAILED', error))],
			)
		}
	}

	private async applyRemove(normalized: NormalizedMutationInputs): Promise<PackageMutationResult> {
		const manifest = await this.readManifest()
		const next = cloneManifest(manifest)
		const removed: string[] = []
		if (normalized.tooLarge) return mutationBatchTooLarge(normalized.overflowInput)
		const failed: PackageMutationFailure[] = [...normalized.failed]
		const inputs = normalized.inputs
		for (const raw of inputs) {
			const name = raw.trim()
			if (!isPackageName(name)) {
				failed.push(failure(raw, 'INVALID_SPEC', new Error('Expected an npm package name')))
				continue
			}
			if (!Object.hasOwn(next.dependencies, name)) {
				// Saved selection precedes publication. A leftover owned wrapper can still
				// require withdrawal after a failed remove, even though it left the selection.
				try {
					await lstat(resolve(this.entriesDir, this.entryFile(name)))
				} catch (error) {
					failed.push(
						failure(
							raw,
							'REMOVE_FAILED',
							readErrorCode(error) === 'ENOENT' ? new Error('Package is not managed') : error,
						),
					)
					continue
				}
			}
			delete next.dependencies[name]
			removed.push(name)
		}
		if (removed.length === 0) return mutationResult([], failed)

		try {
			if (removed.some((name) => Object.hasOwn(manifest.dependencies, name))) {
				await this.installManifest(next, removed)
			} else {
				// Retry publication without another dependency resolution or installation.
				this.revision += 1
				await this.publishInstallationEntries(removed)
			}
			return mutationResult(removed, failed)
		} catch (error) {
			if (error instanceof EntryPublicationError) {
				const pending = new Set(error.unpublished)
				return mutationResult(
					removed.filter((name) => !pending.has(name)),
					[
						...failed,
						...error.unpublished.map((name) => failure(name, 'REMOVE_FAILED', error)),
						...(pending.size > 0 ? [] : [failure('', 'REMOVE_FAILED', error)]),
					],
				)
			}
			return mutationResult(
				[],
				[...failed, ...removed.map((name) => failure(name, 'REMOVE_FAILED', error))],
			)
		}
	}

	/** Revokes queued work and publication, then waits for admitted native operations. */
	async close(): Promise<void> {
		this.closed = true
		await this.queue
		await this.releaseWriter()
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('Package store is closed')
		this.options.signal?.throwIfAborted()
	}

	private async installManifest(
		next: ManagedManifest,
		withdrawn: readonly string[] = [],
	): Promise<void> {
		if (!this.writer) throw new Error('Package store must be initialized before mutation')
		const directory = resolve(this.rootDir, 'revisions', crypto.randomUUID())
		let published = false
		try {
			await mkdir(directory, { recursive: true })
			await writeFile(resolve(directory, 'package.json'), JSON.stringify(next) + '\n')
			if (this.installation) {
				const lock = await readFile(
					resolve(this.rootDir, this.installation.directory, 'pnpm-lock.yaml'),
				)
				await writeFile(resolve(directory, 'pnpm-lock.yaml'), lock)
			}
			let result: Awaited<ReturnType<PnpmEngine['install']>>
			try {
				result = await this.engine.install(this.installOptions(next, directory))
			} catch (cause) {
				throw new PublicMutationError(
					'pnpm could not prepare the managed dependency graph; published installations remain available',
					cause,
				)
			}
			this.assertOpen()
			if (result.depsRequiringBuild)
				this.dependenciesWithBuildScripts = Object.freeze([...result.depsRequiringBuild].sort())
			const packages = await this.prepareInstallation(next, directory)
			const previous = this.installation?.packages ?? []
			const installation: PublishedInstallation = Object.freeze({
				version: 1,
				directory: relative(this.rootDir, directory),
				packages,
			})
			// The private installation is complete. Persist its authority before individually atomic wrappers.
			await atomicWrite(
				resolve(this.rootDir, 'published-installation.json'),
				JSON.stringify(installation) + '\n',
				() => this.assertOpen(),
			)
			this.installation = installation
			published = true
			this.revision += 1
			await this.publishInstallationEntries([...withdrawn, ...previous.map((pkg) => pkg.name)])
		} finally {
			if (!published) await rm(directory, { recursive: true, force: true })
		}
	}

	private async publishInstallationEntries(previousNames: readonly string[]): Promise<void> {
		if (!this.writer) throw new Error('Package store must be initialized before mutation')
		const packages = this.installation?.packages ?? []
		try {
			await this.publishEntries(this.publishedEntries(packages))
		} catch (cause) {
			const unpublished: string[] = []
			const expected = this.publishedEntries(packages)
			for (const name of new Set([...previousNames, ...packages.map((pkg) => pkg.name)])) {
				try {
					const file = this.entryFile(name)
					const actual = await readFile(resolve(this.entriesDir, file), 'utf8')
					if (actual !== expected.get(file)) unpublished.push(name)
				} catch (error) {
					if (readErrorCode(error) !== 'ENOENT' || expected.has(this.entryFile(name)))
						unpublished.push(name)
				}
			}
			throw new EntryPublicationError(unpublished, cause)
		}
	}

	private async releaseWriter(): Promise<void> {
		if (!this.writer) return
		this.writer = false
		await rm(resolve(this.rootDir, '.writer'), { recursive: true })
	}

	private async readInstallation(): Promise<PublishedInstallation | undefined> {
		let input: PublishedInstallation
		try {
			input = JSON.parse(
				await readFile(resolve(this.rootDir, 'published-installation.json'), 'utf8'),
			)
		} catch (error) {
			if (readErrorCode(error) === 'ENOENT') return undefined
			throw error
		}
		if (
			input.version !== 1 ||
			typeof input.directory !== 'string' ||
			!/^revisions\/[a-f0-9-]+$/.test(input.directory) ||
			!Array.isArray(input.packages)
		)
			throw new TypeError('Invalid managed published installation')
		await assertOwnedPath(this.rootDir, resolve(this.rootDir, input.directory))
		const names = new Set<string>()
		for (const pkg of input.packages) {
			if (
				!isPackageName(pkg.name) ||
				typeof pkg.requested !== 'string' ||
				!isRegistrySelector(pkg.requested) ||
				!/^[a-f0-9]{64}$/.test(pkg.fingerprint) ||
				!/^[a-f0-9]{64}$/.test(pkg.bytes) ||
				typeof pkg.packageRoot !== 'string' ||
				typeof pkg.target !== 'string' ||
				!/^revisions\/[a-f0-9-]+\/entries\/[a-zA-Z0-9_-]+\.mjs$/.test(pkg.target)
			)
				throw new TypeError('Invalid managed published package')
			if (names.has(pkg.name) || !isAbsolute(pkg.packageRoot))
				throw new TypeError('Invalid managed package ownership')
			await assertOwnedPath(resolve(this.rootDir, 'slots'), pkg.packageRoot)
			await assertOwnedPath(resolve(this.rootDir, 'revisions'), resolve(this.rootDir, pkg.target))
			if ((await readFile(resolve(this.rootDir, pkg.target), 'utf8')) !== this.innerEntry(pkg.name))
				throw new Error(
					`Immutable inner entry changed for ${pkg.name}; repair offline before startup`,
				)
			if ((await installationBytes(pkg.packageRoot)) !== pkg.bytes)
				throw new Error(
					`Immutable installation bytes changed for ${pkg.name}; repair offline before startup`,
				)
			names.add(pkg.name)
		}
		return input
	}

	private async prepareInstallation(
		manifest: ManagedManifest,
		directory: string,
	): Promise<readonly PublishedPackage[]> {
		const lock = parseYaml(await readFile(resolve(directory, 'pnpm-lock.yaml'), 'utf8'))
		const packages: PublishedPackage[] = []
		await mkdir(resolve(directory, 'entries'))
		for (const name of Object.keys(manifest.dependencies).sort()) {
			const fingerprint = packageGraphFingerprint(lock, name)
			if (!fingerprint)
				throw new PublicMutationError(
					`Cannot verify the immutable installation closure of ${name}; expected a complete pnpm v9 registry graph`,
					undefined,
				)
			const packageRoot = await realpath(resolve(directory, 'node_modules', ...name.split('/')))
			const bytes = await installationBytes(packageRoot)
			const previous = this.installation?.packages.find((pkg) => pkg.name === name)
			if (previous && previous.fingerprint === fingerprint) {
				if (previous.bytes !== bytes)
					throw new PublicMutationError(
						`Immutable bytes changed for unchanged ${name}; publication was rejected`,
						undefined,
					)
				if (previous.packageRoot !== packageRoot)
					throw new PublicMutationError(
						`pnpm changed the physical path of unchanged ${name}; publication was rejected to preserve shared identity`,
						undefined,
					)
				packages.push(Object.freeze({ ...previous, requested: manifest.dependencies[name]! }))
				continue
			}
			const target = relative(
				this.rootDir,
				resolve(directory, 'entries', this.entryFile(name)),
			).replaceAll('\\', '/')
			await writeFile(resolve(this.rootDir, target), this.innerEntry(name))
			packages.push(
				Object.freeze({
					name,
					requested: manifest.dependencies[name]!,
					fingerprint,
					bytes,
					packageRoot,
					target,
				}),
			)
		}
		return Object.freeze(packages)
	}

	private publishedEntries(packages: readonly PublishedPackage[]): ReadonlyMap<string, string> {
		return new Map(
			packages.map((pkg) => {
				const target = JSON.stringify(`../${pkg.target}`)
				return [
					this.entryFile(pkg.name),
					`// installation ${pkg.fingerprint}:${pkg.bytes}\nexport * from ${target}\nimport * as pluginModule from ${target}\nexport default pluginModule.default\n`,
				]
			}),
		)
	}
	private innerEntry(name: string): string {
		const specifier = JSON.stringify(name)
		return `export * from ${specifier}\nimport * as pluginModule from ${specifier}\nexport default pluginModule.default\n`
	}

	private installOptions(manifest: ManagedManifest, directory: string): InstallOptions {
		const config = this.engine.readConfig({ dir: this.rootDir })
		const registries = Object.fromEntries(config.registries.map((item) => [item.name, item.url]))
		const networkConfig = networkOptions(config)
		return {
			dir: directory,
			projects: [{ rootDir: directory, manifest }],
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
			enableGlobalVirtualStore: true,
			globalVirtualStoreDir: resolve(this.rootDir, 'slots'),
			packageImportMethod: 'copy',
			autoInstallPeers: true,
			preferFrozenLockfile: true,
			update: false,
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

	private readManifest(): Promise<ManagedManifest> {
		return Promise.resolve(
			normalizeManifest({
				dependencies: Object.fromEntries(
					(this.installation?.packages ?? []).map((pkg) => [pkg.name, pkg.requested]),
				),
			}),
		)
	}

	private async readManagedPackage(name: string, requested: string): Promise<ManagedPackage> {
		let installedVersion: string | null = null
		let entryFile: string | null = null
		try {
			const manifest = JSON.parse(
				await readFile(
					resolve(
						this.installation?.packages.find((pkg) => pkg.name === name)?.packageRoot ??
							resolve(this.rootDir, '__unpublished__'),
						'package.json',
					),
					'utf8',
				),
			) as { version?: unknown }
			if (typeof manifest.version === 'string') installedVersion = manifest.version
		} catch {}
		const expectedEntry = this.entryFile(name)
		try {
			const published = await readFile(resolve(this.entriesDir, expectedEntry), 'utf8')
			if (published === this.publishedEntries(this.installation?.packages ?? []).get(expectedEntry))
				entryFile = expectedEntry
		} catch {}
		return Object.freeze({
			name,
			requested,
			installedVersion,
			entryFile,
		})
	}

	private async publishEntries(expected: ReadonlyMap<string, string>): Promise<void> {
		await mkdir(this.entriesDir, { recursive: true })
		for (const [file, content] of expected) {
			this.assertOpen()
			const path = resolve(this.entriesDir, file)
			try {
				if ((await readFile(path, 'utf8')) === content) continue
			} catch (error) {
				if (readErrorCode(error) !== 'ENOENT') throw error
			}
			await atomicWrite(path, content, () => this.assertOpen())
		}
		for (const file of await readdir(this.entriesDir)) {
			if (!file.endsWith('.mjs') || expected.has(file)) continue
			this.assertOpen()
			await rm(resolve(this.entriesDir, file), { force: true })
		}
	}

	private entryFile(name: string): string {
		return `${Buffer.from(name).toString('base64url')}.mjs`
	}

	private serialize<T>(task: () => Promise<T>): Promise<T> {
		this.assertOpen()
		const run = this.queue.then(() => {
			this.assertOpen()
			return task()
		})
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

class EntryPublicationError extends PublicMutationError {
	constructor(
		readonly unpublished: readonly string[],
		cause: unknown,
	) {
		super(
			'The immutable installation was saved, but entry publication partially failed. Already changed wrappers remain published; retry to finish publication.',
			cause,
		)
	}
}

async function assertOwnedPath(root: string, path: string): Promise<void> {
	const owner = await realpath(root)
	const member = await realpath(path)
	const within = relative(owner, member)
	if (
		!within ||
		isAbsolute(within) ||
		within === '..' ||
		within.startsWith('../') ||
		within.startsWith('..\\')
	)
		throw new TypeError('Invalid managed package ownership')
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
		fetchWarnTimeoutMs: config.fetchWarnTimeoutMs,
		fetchMinSpeedKiBps: config.fetchMinSpeedKiBps,
		userAgent: config.userAgent,
	}
}

async function atomicWrite(
	file: string,
	content: string,
	beforePublish?: () => void,
): Promise<void> {
	await mkdir(resolve(file, '..'), { recursive: true })
	const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
	try {
		await writeFile(temporary, content, 'utf8')
		beforePublish?.()
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

/** pnpm v9 lock snapshots include resolved peer contexts and optional dependency edges. */
function packageGraphFingerprint(lockfile: unknown, name: string): string | undefined {
	const record = (value: unknown): Record<string, unknown> => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('Expected record')
		return value as Record<string, unknown>
	}
	const canonical = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonical)
			: value && typeof value === 'object'
				? Object.fromEntries(
						Object.entries(record(value))
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([key, item]) => [key, canonical(item)]),
					)
				: value
	try {
		const lock = record(lockfile)
		if (String(lock.lockfileVersion) !== '9.0') return undefined
		const importer = record(record(lock.importers)['.'])
		const version = record(record(importer.dependencies)[name]).version
		if (typeof version !== 'string') return undefined
		const snapshots = record(lock.snapshots)
		const packages = record(lock.packages)
		const graph = new Map<string, unknown>()
		const visit = (dependency: string, reference: unknown): void => {
			if (typeof reference !== 'string') throw new Error('Unknown dependency reference')
			// Aliases and non-registry snapshots require conservative invalidation.
			if (!/^\d/.test(reference)) throw new Error('Unknown dependency version')
			const key = `${dependency}@${reference}`
			if (graph.has(key)) return
			const snapshot = record(snapshots[key])
			const metadata = record(packages[key.split('(')[0]!])
			record(metadata.resolution)
			graph.set(key, { snapshot, metadata })
			for (const field of ['dependencies', 'optionalDependencies']) {
				if (snapshot[field] === undefined) continue
				for (const [child, childVersion] of Object.entries(record(snapshot[field])))
					visit(child, childVersion)
			}
		}
		visit(name, version)
		return createHash('sha256')
			.update(JSON.stringify(canonical(Object.fromEntries(graph))))
			.digest('hex')
	} catch {
		return undefined
	}
}

/** Verify actual bytes and physical dependency targets, including resource files and peer/optional links. */
async function installationBytes(root: string): Promise<string> {
	const files = new Map<string, string>()
	const seen = new Set<string>()
	const visit = async (input: string): Promise<void> => {
		const directory = await realpath(input)
		if (seen.has(directory)) return
		seen.add(directory)
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = resolve(directory, entry.name)
			if (entry.isDirectory()) await visit(path)
			else if (entry.isSymbolicLink()) {
				const target = await realpath(path)
				files.set(path, `link:${target}`)
				const targetStat = await stat(target)
				if (targetStat.isDirectory()) await visit(dependencySlot(target))
				else
					files.set(
						target,
						createHash('sha256')
							.update(await readFile(target))
							.digest('hex'),
					)
			} else if (entry.isFile())
				files.set(
					path,
					createHash('sha256')
						.update(await readFile(path))
						.digest('hex'),
				)
		}
	}
	await visit(dependencySlot(root))
	return createHash('sha256')
		.update(JSON.stringify([...files].sort(([left], [right]) => left.localeCompare(right))))
		.digest('hex')
}
function dependencySlot(root: string): string {
	let directory = dirname(root)
	while (directory !== dirname(directory) && !directory.endsWith('/node_modules'))
		directory = dirname(directory)
	if (!directory.endsWith('/node_modules'))
		throw new TypeError('Managed package lacks a physical dependency slot')
	return directory
}
