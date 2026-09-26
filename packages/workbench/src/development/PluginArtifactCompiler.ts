import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pluginDefinitionIndexKey, type Context } from '@pluxel/core'
import {
	type WorkbenchArtifactBatchCommit,
	type WorkbenchArtifactCandidate,
	type WorkbenchArtifactCoordinator,
	type WorkbenchContentArtifactCandidate,
	type WorkbenchProducerStatusReporter,
} from '../internal'
import {
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	type WorkbenchFederationProducerPlan,
	type WorkbenchFederationTypeAssetPolicy,
} from '@pluxel/core/federation'
import {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	parseWorkbenchContentSet,
	serializeWorkbenchContentDefinition,
	serializeWorkbenchContentSet,
	type WorkbenchContentSet,
} from '@pluxel/core/internal'
import { isAbsolute, join, resolve } from 'pathe'
import type { ViteDevServer } from 'vite'

export type PluginArtifactCompilerOptions = Readonly<{
	/** Disk cache root. @defaultValue `.pluxel/plugin-artifacts` under `process.cwd()`. */
	cacheDir?: string
	/** Package export graph used by Workbench producers. */
	packageMode: 'development' | 'distribution'
}>

export type PluginArtifactCompilerViteServer = {
	config: Pick<ViteDevServer['config'], 'root'>
	environments?: ViteDevServer['environments']
	watcher?: Pick<ViteDevServer['watcher'], 'add'>
}

export type PluginArtifactCompilerWorkbenchCoordinator = Pick<
	WorkbenchArtifactCoordinator,
	'prepareCandidate' | 'commitPrepared'
>

export type PluginArtifactCompilerDeps = Readonly<{
	coordinator?: PluginArtifactCompilerWorkbenchCoordinator
	producerStatus?: WorkbenchProducerStatusReporter
	viteServer?: PluginArtifactCompilerViteServer
}>

export type WorkbenchProducerCompilation = Readonly<{
	plan: WorkbenchFederationProducerPlan
	/** Package root against which generated Bridge entries and dependencies are resolved. */
	root: string
}>

export type WorkbenchContentCompilation = Readonly<{
	contentSet: WorkbenchContentSet
	digest: string
	bytes: Uint8Array
	/** Package root containing the Markdown source or packaged Content artifact. */
	root: string
	sources: readonly string[]
}>

export type WorkbenchArtifactCompilations = Readonly<{
	producers: readonly WorkbenchProducerCompilation[]
	content: readonly WorkbenchContentCompilation[]
	/** Validated package inventory inputs; admitted with the same source candidate transaction. */
	packaged?: readonly WorkbenchDefinitionCandidate[]
}>

type WorkbenchDefinitionCompilation = {
	definition: WorkbenchFederationProducerPlan['definition']
	producer?: WorkbenchProducerCompilation
	content?: WorkbenchContentCompilation
	packaged?: WorkbenchDefinitionCandidate
}

type WorkbenchDefinitionCandidate = Readonly<{
	definition: WorkbenchFederationProducerPlan['definition']
	federation?: WorkbenchArtifactCandidate
	content?: WorkbenchContentArtifactCandidate
}>

/** An unpublished, validated semantic snapshot. Commit only when its runtime catalog is accepted. */
export type PreparedWorkbenchArtifacts = Readonly<{
	/** Synchronous activation; also admits background producer builds for this accepted generation. */
	commit(): readonly WorkbenchArtifactBatchCommit[]
	/** Discards an unaccepted snapshot; does not undo an already accepted generation. */
	rollback(): void
}>

const ARTIFACT_CACHE_KEEP = 5
const SHA256 = /^[a-f\d]{64}$/

/**
 * Route-neutral development artifact compiler.
 *
 * Workbench plans come only from the shared semantic lowering pass. This class never
 * rediscovers renderer declarations or computes a second source hash/build revision.
 */
export class PluginArtifactCompiler {
	private readonly coordinator?: PluginArtifactCompilerWorkbenchCoordinator
	private readonly producerStatus?: WorkbenchProducerStatusReporter
	private readonly viteServer?: PluginArtifactCompilerViteServer
	private readonly cacheDir: string
	private readonly packageMode: 'development' | 'distribution'
	private readonly producerTasks = new Map<string, Promise<WorkbenchArtifactCandidate>>()
	private readonly producerBackgroundCommits = new Map<string, Promise<void>>()
	private readonly producerCandidates = new Map<string, WorkbenchArtifactCandidate>()
	private readonly committedWorkbenchDefinitions = new Map<
		string,
		WorkbenchFederationProducerPlan['definition']
	>()
	private workbenchPublicationEpoch = 0
	private workbenchPublishRequest = 0
	private closeTask?: Promise<void>
	private readonly signal = new AbortController()

	constructor(
		public ctx: Context,
		deps: PluginArtifactCompilerDeps,
		options: PluginArtifactCompilerOptions,
	) {
		this.coordinator = deps.coordinator
		this.producerStatus = deps.producerStatus
		this.viteServer = deps.viteServer
		this.cacheDir = resolve(options.cacheDir ?? resolve(process.cwd(), '.pluxel/plugin-artifacts'))
		this.packageMode = options.packageMode
		if (this.packageMode === 'development') this.producerStatus?.enablePendingProducerBuilds()
	}

	/** Publishes artifacts for an already accepted runtime snapshot (startup or Content-only refresh). */
	async publishWorkbenchArtifacts(
		input: WorkbenchArtifactCompilations,
	): Promise<readonly WorkbenchArtifactBatchCommit[]> {
		const request = ++this.workbenchPublishRequest
		const prepared = await this.prepareWorkbenchArtifacts(input)
		if (request !== this.workbenchPublishRequest) {
			prepared.rollback()
			return []
		}
		return prepared.commit()
	}

	/**
	 * Materializes and validates without changing the artifacts used by the running catalog.
	 * The route retains its serialized update lane until this candidate is committed or discarded.
	 */
	async prepareWorkbenchArtifacts(
		input: WorkbenchArtifactCompilations,
	): Promise<PreparedWorkbenchArtifacts> {
		return this.packageMode === 'development'
			? this.prepareDevelopmentWorkbenchArtifacts(input)
			: this.prepareStrictWorkbenchArtifacts(input)
	}

	private async prepareStrictWorkbenchArtifacts(
		input: WorkbenchArtifactCompilations,
	): Promise<PreparedWorkbenchArtifacts> {
		this.requireWorkbenchCoordinator()
		const definitions = groupWorkbenchCompilations(input)
		const materialized = await Promise.all(
			[...definitions.entries()].map(async ([key, compilation]) => {
				if (compilation.packaged) return [key, compilation.packaged] as const
				const [federation, content] = await Promise.all([
					compilation.producer ? this.materializeProducer(compilation.producer) : undefined,
					compilation.content ? this.materializeContent(compilation.content) : undefined,
				])
				return [
					key,
					Object.freeze({ definition: compilation.definition, federation, content }),
				] as const
			}),
		)
		const candidates = new Map(materialized)
		return this.prepareWorkbenchDefinitions(definitions, candidates)
	}

	private async prepareDevelopmentWorkbenchArtifacts(
		input: WorkbenchArtifactCompilations,
	): Promise<PreparedWorkbenchArtifacts> {
		this.requireWorkbenchCoordinator()
		const definitions = groupWorkbenchCompilations(input)
		const materialized = await Promise.all(
			[...definitions.entries()].map(async ([key, compilation]) => {
				if (compilation.packaged)
					return [
						key,
						{
							...compilation.packaged,
							producer: undefined as WorkbenchProducerCompilation | undefined,
						},
					] as const
				const content = compilation.content
					? await this.materializeContent(compilation.content)
					: undefined
				let federation: WorkbenchArtifactCandidate | undefined
				if (compilation.producer) {
					federation = this.cachedProducerCandidate(compilation.producer)
					if (
						!federation &&
						!this.hasProducerBuildTask(compilation.producer) &&
						this.hasProducerArtifactOnDisk(compilation.producer)
					) {
						try {
							federation = await this.materializeProducer(compilation.producer, {
								repairStaleCache: false,
								logFailure: false,
							})
						} catch (error) {
							this.ctx.logger.warn('Workbench {definition}: cached producer is stale', {
								definition: compilation.producer.plan.definition.exportName,
								revision: compilation.producer.plan.buildRevision.slice(0, 8),
								producer: compilation.producer.plan.producer,
								buildRevision: compilation.producer.plan.buildRevision,
								error,
							})
						}
					}
				}
				return [
					key,
					Object.freeze({
						definition: compilation.definition,
						federation,
						content,
						producer: federation ? undefined : compilation.producer,
					}),
				] as const
			}),
		)
		const candidates = new Map(
			materialized.map(([key, candidate]) => [
				key,
				Object.freeze({
					definition: candidate.definition,
					...(candidate.federation ? { federation: candidate.federation } : {}),
					...(candidate.content ? { content: candidate.content } : {}),
				}) satisfies WorkbenchDefinitionCandidate,
			]),
		)
		const pendingProducers = materialized.filter(([, candidate]) => candidate.producer)
		return this.prepareWorkbenchDefinitions(
			definitions,
			candidates,
			(epoch, withdrawnDefinitions) => {
				for (const definition of withdrawnDefinitions) this.producerStatus?.clear(definition)
				const pendingKeys = new Set(pendingProducers.map(([key]) => key))
				for (const [key, candidate] of materialized) {
					if (pendingKeys.has(key)) this.markProducerBuilding(candidate.producer!.plan)
					else this.producerStatus?.clear(candidate.definition)
				}
				for (const [key, candidate] of pendingProducers) {
					this.scheduleDevelopmentProducerCommit({
						key,
						epoch,
						definition: candidate.definition,
						producer: candidate.producer!,
						content: candidate.content,
					})
				}
			},
		)
	}

	private requireWorkbenchCoordinator(): PluginArtifactCompilerWorkbenchCoordinator {
		const coordinator = this.coordinator
		if (!coordinator) throw new Error('[host-dev] Workbench compiler is not attached')
		return coordinator
	}

	dispose(): Promise<void> {
		if (this.closeTask) return this.closeTask
		this.signal.abort(new Error('[host-dev] artifact compiler disposed'))
		this.workbenchPublicationEpoch += 1
		this.committedWorkbenchDefinitions.clear()
		this.producerBackgroundCommits.clear()
		this.producerCandidates.clear()
		this.producerStatus?.disablePendingProducerBuilds()
		this.closeTask = Promise.allSettled(this.producerTasks.values()).then((): void => undefined)
		return this.closeTask
	}

	private async prepareWorkbenchDefinitions(
		definitions: ReadonlyMap<string, WorkbenchDefinitionCompilation>,
		candidates: ReadonlyMap<string, WorkbenchDefinitionCandidate>,
		onCommitted?: (
			epoch: number,
			withdrawnDefinitions: readonly WorkbenchFederationProducerPlan['definition'][],
		) => void,
	): Promise<PreparedWorkbenchArtifacts> {
		const coordinator = this.requireWorkbenchCoordinator()
		const desired = new Map(this.committedWorkbenchDefinitions)
		for (const [key, compilation] of definitions) desired.set(key, compilation.definition)
		const prepared = await Promise.all(
			[...desired]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(async ([key, definition]) =>
					coordinator.prepareCandidate(candidates.get(key) ?? Object.freeze({ definition })),
				),
		)
		const withdrawn = [...desired]
			.filter(([key]) => !definitions.has(key))
			.map(([, definition]) => definition)
		let state: 'prepared' | 'committed' | 'discarded' = 'prepared'
		let commits: readonly WorkbenchArtifactBatchCommit[] = Object.freeze([])
		return Object.freeze({
			commit: () => {
				if (state !== 'prepared' || this.signal.signal.aborted) return commits
				state = 'committed'
				const epoch = ++this.workbenchPublicationEpoch
				commits = Object.freeze(prepared.map((candidate) => coordinator.commitPrepared(candidate)))
				this.committedWorkbenchDefinitions.clear()
				for (const [key, compilation] of definitions)
					this.committedWorkbenchDefinitions.set(key, compilation.definition)
				onCommitted?.(epoch, withdrawn)
				void this.cleanupWorkbenchCandidates(candidates.values()).catch((error) => {
					this.ctx.logger.warn('Workbench artifact cache cleanup failed', { error })
				})
				return commits
			},
			rollback: () => {
				if (state === 'prepared') state = 'discarded'
			},
		})
	}

	private cachedProducerCandidate(
		input: WorkbenchProducerCompilation,
	): WorkbenchArtifactCandidate | undefined {
		const root = resolveProducerRoot(input.root)
		const plan = input.plan
		assertSafeProducerReference(plan)
		const cached = this.producerCandidates.get(
			producerTaskKey(plan, root, this.workbenchProducerTypeAssets()),
		)
		if (cached && existsSync(join(cached.artifactRoot, WORKBENCH_FEDERATION_MANIFEST_FILE))) {
			return cached
		}
		return undefined
	}

	private hasProducerArtifactOnDisk(input: WorkbenchProducerCompilation): boolean {
		const plan = input.plan
		assertSafeProducerReference(plan)
		return existsSync(join(this.producerOutDir(plan), WORKBENCH_FEDERATION_MANIFEST_FILE))
	}

	private hasProducerBuildTask(input: WorkbenchProducerCompilation): boolean {
		const root = resolveProducerRoot(input.root)
		const plan = input.plan
		assertSafeProducerReference(plan)
		return this.producerTasks.has(producerTaskKey(plan, root, this.workbenchProducerTypeAssets()))
	}

	private scheduleDevelopmentProducerCommit(input: {
		key: string
		epoch: number
		definition: WorkbenchFederationProducerPlan['definition']
		producer: WorkbenchProducerCompilation
		content?: WorkbenchContentArtifactCandidate
	}): void {
		const coordinator = this.requireWorkbenchCoordinator()
		const root = resolveProducerRoot(input.producer.root)
		const policy = this.workbenchProducerTypeAssets()
		const taskKey = `${input.epoch}\0${input.key}\0${producerTaskKey(input.producer.plan, root, policy)}`
		if (this.producerBackgroundCommits.has(taskKey)) return
		let task!: Promise<void>
		task = (async () => {
			await deferBackgroundWorkbenchTask()
			if (this.signal.signal.aborted || input.epoch !== this.workbenchPublicationEpoch) return
			const federation = await this.materializeProducer(input.producer)
			if (this.signal.signal.aborted || input.epoch !== this.workbenchPublicationEpoch) return
			const candidate: WorkbenchDefinitionCandidate = Object.freeze({
				definition: input.definition,
				federation,
				...(input.content ? { content: input.content } : {}),
			})
			const prepared = await coordinator.prepareCandidate(candidate)
			// Validation awaits IO. Recheck acceptance immediately before synchronous activation.
			if (this.signal.signal.aborted || input.epoch !== this.workbenchPublicationEpoch) return
			coordinator.commitPrepared(prepared)
			this.producerStatus?.clear(input.definition)
			await this.cleanupWorkbenchCandidates([candidate])
		})()
			.catch((error) => {
				if (this.signal.signal.aborted || input.epoch !== this.workbenchPublicationEpoch) return
				this.ctx.logger.error('Workbench {definition}: background publish failed', {
					definition: input.definition.exportName,
					revision: input.producer.plan.buildRevision.slice(0, 8),
					producer: input.producer.plan.producer,
					buildRevision: input.producer.plan.buildRevision,
					error,
				})
				this.producerStatus?.setFailed({
					definition: input.definition,
					producer: input.producer.plan.producer,
					buildRevision: input.producer.plan.buildRevision,
					error,
				})
			})
			.finally(() => {
				if (this.producerBackgroundCommits.get(taskKey) === task) {
					this.producerBackgroundCommits.delete(taskKey)
				}
			})
		this.producerBackgroundCommits.set(taskKey, task)
	}

	private async materializeProducer(
		input: WorkbenchProducerCompilation,
		options: Readonly<{ repairStaleCache?: boolean; logFailure?: boolean }> = {},
	): Promise<WorkbenchArtifactCandidate> {
		const root = resolveProducerRoot(input.root)
		const plan = input.plan
		assertSafeProducerReference(plan)
		const policy = this.workbenchProducerTypeAssets()
		const taskKey = producerTaskKey(plan, root, policy)
		const cached = this.producerCandidates.get(taskKey)
		if (cached && existsSync(join(cached.artifactRoot, WORKBENCH_FEDERATION_MANIFEST_FILE))) {
			return cached
		}
		const existing = this.producerTasks.get(taskKey)
		if (existing) return existing
		const task = this.performProducerBuild(plan, root, options).then((candidate) => {
			this.producerCandidates.set(taskKey, candidate)
			return candidate
		})
		this.producerTasks.set(taskKey, task)
		try {
			return await task
		} finally {
			if (this.producerTasks.get(taskKey) === task) this.producerTasks.delete(taskKey)
		}
	}

	private async performProducerBuild(
		plan: WorkbenchFederationProducerPlan,
		root: string,
		options: Readonly<{ repairStaleCache?: boolean; logFailure?: boolean }>,
	): Promise<WorkbenchArtifactCandidate> {
		const typeAssets = this.workbenchProducerTypeAssets()
		const outDir = this.producerOutDir(plan)
		const artifactWasPresent = existsSync(outDir)
		let cacheResult: 'built' | 'reused' = artifactWasPresent ? 'reused' : 'built'
		const startedAt = performance.now()
		const logFacts = {
			definition: plan.definition.exportName,
			revision: plan.buildRevision.slice(0, 8),
			producer: plan.producer,
			buildRevision: plan.buildRevision,
		}
		if (!artifactWasPresent) {
			this.ctx.logger.info('Workbench {definition}: build start', logFacts)
		}
		try {
			const { buildWorkbenchFederationProducer } =
				await import('@pluxel/rolldown/vite/workbench-ui')
			const build = () =>
				buildWorkbenchFederationProducer({
					plan,
					root,
					applicationRoot: this.viteServer?.config.root,
					packageMode: this.packageMode,
					outDir,
					cacheDir: join(this.cacheDir, 'workbench-vite'),
					minify: false,
					sourcemap: true,
					typeAssets,
					signal: this.signal.signal,
				})
			try {
				await build()
			} catch (error) {
				if (
					this.packageMode === 'development' &&
					artifactWasPresent &&
					options.repairStaleCache !== false &&
					isImmutableProducerMismatch(error)
				) {
					this.ctx.logger.warn('Workbench {definition}: discarding stale producer cache', {
						...logFacts,
						error,
					})
					await rm(outDir, { recursive: true, force: true })
					cacheResult = 'built'
					await build()
				} else {
					throw error
				}
			}
		} catch (error) {
			if (!this.signal.signal.aborted && options.logFailure !== false) {
				this.ctx.logger.error('Workbench {definition}: failed after {durationMs} ms', {
					...logFacts,
					durationMs: Math.round(performance.now() - startedAt),
					error,
				})
			}
			throw error
		}
		if (this.signal.signal.aborted) throw this.signal.signal.reason
		this.ctx.logger.info('Workbench {definition}: {cache} in {durationMs} ms', {
			...logFacts,
			cache: cacheResult,
			durationMs: Math.round(performance.now() - startedAt),
		})
		return Object.freeze({ plan, artifactRoot: outDir, typeAssets })
	}

	private producerOutDir(plan: WorkbenchFederationProducerPlan): string {
		return join(
			this.cacheDir,
			'workbench',
			this.packageMode,
			this.workbenchProducerTypeAssets(),
			plan.producer,
			plan.buildRevision,
		)
	}

	private workbenchProducerTypeAssets(): WorkbenchFederationTypeAssetPolicy {
		return this.packageMode === 'development' ? 'optional' : 'required'
	}

	private markProducerBuilding(plan: WorkbenchFederationProducerPlan): void {
		this.producerStatus?.setBuilding({
			definition: plan.definition,
			producer: plan.producer,
			buildRevision: plan.buildRevision,
		})
	}

	private async materializeContent(
		input: WorkbenchContentCompilation,
	): Promise<WorkbenchContentArtifactCandidate> {
		resolveContentRoot(input.root)
		if (input.sources.length > 0) this.viteServer?.watcher?.add([...input.sources])
		const digest = parseSha256(input.digest, 'Content set digest')
		const bytes = Buffer.from(input.bytes)
		if (sha256(bytes) !== digest) {
			throw new TypeError('[host-dev] Workbench Content digest does not match its bytes')
		}
		let serialized: string
		try {
			serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		} catch (cause) {
			throw new TypeError('[host-dev] Workbench Content bytes are not valid UTF-8', { cause })
		}
		let contentSet: WorkbenchContentSet
		try {
			contentSet = parseWorkbenchContentSet(JSON.parse(serialized) as unknown)
		} catch (cause) {
			throw new TypeError('[host-dev] Workbench Content set is invalid', { cause })
		}
		if (
			serializeWorkbenchContentSet(contentSet) !== serialized ||
			serializeWorkbenchContentSet(input.contentSet) !== serialized
		) {
			throw new TypeError('[host-dev] Workbench Content bytes are not canonically serialized')
		}
		const definition = contentSet.definition
		const definitionDigest = sha256(serializeWorkbenchContentDefinition(definition))
		const artifactRoot = join(this.cacheDir, 'workbench-content', definitionDigest, digest)
		await publishImmutableContentArtifact(artifactRoot, bytes, digest)
		return Object.freeze({ definition, definitionDigest, digest, artifactRoot })
	}

	private async cleanupWorkbenchCandidates(
		candidates: Iterable<WorkbenchDefinitionCandidate>,
	): Promise<void> {
		const tasks: Promise<void>[] = []
		for (const candidate of candidates) {
			if (candidate.federation) {
				tasks.push(
					this.cleanupProducerCache(
						candidate.federation.plan.producer,
						candidate.federation.plan.buildRevision,
					),
				)
			}
			if (candidate.content) {
				tasks.push(
					this.cleanupContentCache(candidate.content.definitionDigest, candidate.content.digest),
				)
			}
		}
		await Promise.all(tasks).catch((error) => {
			this.ctx.logger.warn('failed to clean Workbench artifact cache', { error })
		})
	}

	private async cleanupContentCache(
		definitionDigest: string,
		currentDigest: string,
	): Promise<void> {
		const root = join(this.cacheDir, 'workbench-content', definitionDigest)
		const names = await readdir(root).catch((): string[] => [])
		const revisions: Array<{ name: string; path: string; mtime: number }> = []
		for (const name of names) {
			if (!SHA256.test(name)) continue
			const path = join(root, name)
			const artifact = await stat(join(path, WORKBENCH_CONTENT_ARTIFACT_FILE)).catch(
				(): null => null,
			)
			if (artifact?.isFile()) revisions.push({ name, path, mtime: artifact.mtimeMs })
		}
		revisions.sort((left, right) => right.mtime - left.mtime)
		const retained = new Set(
			[
				revisions.find((revision) => revision.name === currentDigest),
				...revisions.filter((revision) => revision.name !== currentDigest),
			]
				.filter((revision): revision is (typeof revisions)[number] => Boolean(revision))
				.slice(0, ARTIFACT_CACHE_KEEP)
				.map((revision) => revision.path),
		)
		for (const revision of revisions) {
			if (!retained.has(revision.path)) {
				await rm(revision.path, { recursive: true, force: true })
			}
		}
	}

	private async cleanupProducerCache(producer: string, currentRevision: string): Promise<void> {
		const root = join(
			this.cacheDir,
			'workbench',
			this.packageMode,
			this.workbenchProducerTypeAssets(),
			producer,
		)
		const names = await readdir(root).catch((): string[] => [])
		const builds: Array<{ name: string; path: string; mtime: number }> = []
		for (const name of names) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) continue
			const path = join(root, name)
			const manifest = await stat(join(path, WORKBENCH_FEDERATION_MANIFEST_FILE)).catch(
				(): null => null,
			)
			if (manifest?.isFile()) builds.push({ name, path, mtime: manifest.mtimeMs })
		}
		builds.sort((left, right) => right.mtime - left.mtime)
		const retained = new Set(
			[
				builds.find((build) => build.name === currentRevision),
				...builds.filter((build) => build.name !== currentRevision),
			]
				.filter((build): build is (typeof builds)[number] => Boolean(build))
				.slice(0, ARTIFACT_CACHE_KEEP)
				.map((build) => build.path),
		)
		for (const build of builds) {
			if (!retained.has(build.path)) {
				await rm(build.path, { recursive: true, force: true })
			}
		}
	}
}

function resolveProducerRoot(input: unknown): string {
	if (typeof input !== 'string' || !input || !isAbsolute(input)) {
		throw new TypeError('[host-dev] Workbench producer root must be an absolute path')
	}
	return resolve(input)
}

function resolveContentRoot(input: unknown): string {
	if (typeof input !== 'string' || !input || !isAbsolute(input)) {
		throw new TypeError('[host-dev] Workbench Content root must be an absolute path')
	}
	return resolve(input)
}

function groupWorkbenchCompilations(
	input: WorkbenchArtifactCompilations,
): Map<string, WorkbenchDefinitionCompilation> {
	if (!input || !Array.isArray(input.producers) || !Array.isArray(input.content)) {
		throw new TypeError('[host-dev] Workbench artifact compilations must contain arrays')
	}
	const definitions = new Map<string, WorkbenchDefinitionCompilation>()
	for (const producer of input.producers) {
		const definition = producer.plan.definition
		const key = pluginDefinitionIndexKey(definition)
		const current: WorkbenchDefinitionCompilation = definitions.get(key) ?? { definition }
		if (current.producer) {
			throw new TypeError(`[host-dev] duplicate Workbench producer definition: ${key}`)
		}
		current.producer = producer
		definitions.set(key, current)
	}
	for (const content of input.content) {
		const definition = content.contentSet.definition
		const key = pluginDefinitionIndexKey(definition)
		const current: WorkbenchDefinitionCompilation = definitions.get(key) ?? { definition }
		if (current.content) {
			throw new TypeError(`[host-dev] duplicate Workbench Content definition: ${key}`)
		}
		current.content = content
		definitions.set(key, current)
	}
	for (const packaged of input.packaged ?? []) {
		const key = pluginDefinitionIndexKey(packaged.definition)
		if (definitions.has(key))
			throw new TypeError(`[host-dev] conflicting source or packaged Workbench definition: ${key}`)
		definitions.set(key, { definition: packaged.definition, packaged })
	}
	return definitions
}

async function publishImmutableContentArtifact(
	artifactRoot: string,
	bytes: Uint8Array,
	digest: string,
): Promise<void> {
	const artifactPath = join(artifactRoot, WORKBENCH_CONTENT_ARTIFACT_FILE)
	if (await validateExistingContentArtifact(artifactPath, bytes, digest)) return
	const parent = resolve(artifactRoot, '..')
	await mkdir(parent, { recursive: true })
	const temporaryRoot = `${artifactRoot}.tmp-${process.pid}-${randomUUID()}`
	await mkdir(temporaryRoot)
	try {
		await writeFile(join(temporaryRoot, WORKBENCH_CONTENT_ARTIFACT_FILE), bytes, { flag: 'wx' })
		try {
			await rename(temporaryRoot, artifactRoot)
		} catch (error) {
			if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error))) throw error
		}
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true })
	}
	if (!(await validateExistingContentArtifact(artifactPath, bytes, digest))) {
		throw new Error(`[host-dev] immutable Workbench Content artifact collision: ${digest}`)
	}
}

async function validateExistingContentArtifact(
	artifactPath: string,
	expected: Uint8Array,
	digest: string,
): Promise<boolean> {
	const existing = await readFile(artifactPath).catch((error): null => {
		if (errorCode(error) === 'ENOENT') return null
		throw error
	})
	if (!existing) return false
	if (sha256(existing) !== digest || !existing.equals(Buffer.from(expected))) {
		throw new Error(`[host-dev] immutable Workbench Content artifact collision: ${digest}`)
	}
	return true
}

function parseSha256(input: unknown, label: string): string {
	if (typeof input !== 'string' || !SHA256.test(input)) {
		throw new TypeError(`[host-dev] ${label} must be a lowercase SHA-256 digest`)
	}
	return input
}

function sha256(input: Uint8Array | string): string {
	return createHash('sha256').update(input).digest('hex')
}

function errorCode(error: unknown): string {
	return error && typeof error === 'object' && 'code' in error
		? String((error as { code?: unknown }).code)
		: ''
}

function assertSafeProducerReference(plan: WorkbenchFederationProducerPlan): void {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(plan?.producer) ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plan?.buildRevision)
	) {
		throw new TypeError('[host-dev] Workbench producer plan has an unsafe reference')
	}
}

function producerReference(plan: WorkbenchFederationProducerPlan): string {
	return `${plan.producer}\0${plan.buildRevision}`
}

function producerTaskKey(
	plan: WorkbenchFederationProducerPlan,
	root: string,
	typeAssets: WorkbenchFederationTypeAssetPolicy,
): string {
	return [
		producerReference(plan),
		root,
		typeAssets,
		...plan.entries.map(
			(entry) =>
				`${entry.descriptor.kind}:${entry.descriptor.key}:${entry.expose}:${entry.bridgeEntryPath}`,
		),
	].join('\0')
}

function deferBackgroundWorkbenchTask(): Promise<void> {
	return new Promise<void>((resolveTask) => {
		const timer = setTimeout(resolveTask, 0)
		timer.unref?.()
	})
}

function isImmutableProducerMismatch(error: unknown): boolean {
	return (
		error instanceof Error && error.message.includes('immutable producer revision already exists')
	)
}
