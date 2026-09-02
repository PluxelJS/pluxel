import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import {
	WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_PROFILE_VERSION,
	createWorkbenchFederationProducerPlan,
	workbenchFederationBuildOutDir,
	type WorkbenchFederationProducerPlan,
	type WorkbenchFederationTypeAssetPolicy,
} from '@pluxel/core/federation'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import {
	assertWorkbenchFederationProducerCompatibility,
	resolveWorkbenchFederationBridgeEntry,
	resolveWorkbenchFederationShared,
	type ResolvedFederationShared,
} from '../workbench/build-contract.ts'
import {
	runWorkbenchBuildCacheTransaction,
	runWorkbenchFederationBuild,
	runWorkbenchOutputTransaction,
} from '../workbench/build-scheduler.ts'
import { resolveParaglideIntegration } from './paraglide.ts'
import { validateWorkbenchFederationArtifact } from '../workbench/artifact.ts'
import { runWorkbenchViteBuild, type WorkbenchViteBuildOptions } from './workbench-vite-build.ts'

export type BuildWorkbenchFederationProducerOptions = Readonly<{
	plan: WorkbenchFederationProducerPlan
	/** Package root used to resolve generated Bridge entries and producer source dependencies. */
	root?: string
	/** Host application root that provides the fixed shared winners. @defaultValue root */
	applicationRoot?: string
	/** Selects source exports for development or built package exports for distribution assembly. */
	packageMode: 'development' | 'distribution'
	outDir?: string
	/**
	 * Root for Vite and declaration incremental caches.
	 * Development defaults to `.pluxel/vite-workbench-ui-cache` under `root`.
	 * Distribution uses an ephemeral cache unless this is provided.
	 */
	cacheDir?: string
	minify?: boolean
	sourcemap?: boolean
	/**
	 * Selects whether dynamic type artifacts are part of this producer candidate.
	 * Development defaults to a runtime-only producer; distribution defaults to strict types.
	 */
	typeAssets?: WorkbenchFederationTypeAssetPolicy
	/**
	 * Prevents a queued Federation build from starting or publishing after abort. An already-running
	 * Vite build finishes before this operation rejects because Vite has no build cancellation API.
	 */
	signal?: AbortSignal
}>

export type WorkbenchFederationProducerBuild = Readonly<{
	outDir: string
	manifestPath: string
	compatibilitySignature: string
}>

const PRODUCER_STAMP_FILE = 'pluxel-producer.json'
type ProducerStamp = Readonly<{
	profile: typeof WORKBENCH_PROFILE_VERSION
	buildContract: typeof WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION
	packageMode: BuildWorkbenchFederationProducerOptions['packageMode']
	producer: string
	buildRevision: string
	exposes: readonly string[]
	compatibilitySignature: string
	typeAssets?: WorkbenchFederationTypeAssetPolicy
}>

export async function buildWorkbenchFederationProducer(
	options: BuildWorkbenchFederationProducerOptions,
): Promise<WorkbenchFederationProducerBuild> {
	const root = resolve(options.root ?? process.cwd())
	const applicationRoot = resolve(options.applicationRoot ?? root)
	const plan = assertPlan(options.plan)
	const typeAssets = resolveTypeAssetPolicy(options)
	const outDir = resolve(root, options.outDir ?? workbenchFederationBuildOutDir(plan))
	const resolvedShared = resolveWorkbenchFederationShared(applicationRoot)
	if (root !== applicationRoot) {
		assertWorkbenchFederationProducerCompatibility(root, resolvedShared.compatibility)
	}
	const compatibilitySignature = resolvedShared.signature
	const result = Object.freeze({
		outDir,
		manifestPath: resolve(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE),
		compatibilitySignature,
	})

	return runWorkbenchOutputTransaction(outDir, async () => {
		if (await isCommittedRevision(outDir, plan, resolvedShared, options.packageMode, typeAssets)) {
			return result
		}
		if (await exists(outDir)) {
			throw new Error(
				`[workbench-ui] immutable producer revision already exists but does not match its plan: ${outDir}`,
			)
		}

		const buildId = randomUUID()
		const candidateDir = `${outDir}.candidate-${buildId}`
		const cache = resolveBuildCacheDir(root, plan, options, typeAssets, buildId)
		try {
			const paraglide = resolveParaglideIntegration(root)
			const viteBuild: WorkbenchViteBuildOptions = {
				producerRoot: root,
				applicationRoot,
				packageMode: options.packageMode,
				declarationRoot: commonDirectory(root, applicationRoot),
				outDir: candidateDir,
				producer: plan.producer,
				exposes: Object.fromEntries(
					plan.entries.map((entry) => [entry.expose, resolve(root, entry.bridgeEntryPath)]),
				),
				cacheDir: cache.dir,
				shared: resolvedShared.shared,
				bridgeReactEntry: resolveWorkbenchFederationBridgeEntry(),
				minify: options.minify ?? true,
				sourcemap: options.sourcemap ?? false,
				typeAssets,
				paraglide: paraglide ? { project: paraglide.project, outdir: paraglide.outdir } : null,
			}
			if (options.signal?.aborted) throw options.signal.reason
			await runWorkbenchBuildCacheTransaction(cache.dir, () =>
				runWorkbenchFederationBuild(applicationRoot, () => {
					if (options.signal?.aborted) throw options.signal.reason
					return runWorkbenchViteBuild(viteBuild)
				}),
			)
			if (options.signal?.aborted) throw options.signal.reason
			const validation = await validateWorkbenchFederationArtifact(candidateDir, {
				plan,
				compatibility: resolvedShared.compatibility,
				typeAssets,
			})
			if (validation.valid === false) {
				throw new Error(
					`[workbench-ui] invalid federation producer candidate: ${validation.reason}`,
				)
			}
			await writeFile(
				resolve(candidateDir, PRODUCER_STAMP_FILE),
				`${JSON.stringify(createStamp(plan, compatibilitySignature, options.packageMode, typeAssets))}\n`,
				'utf-8',
			)
			await mkdir(dirname(outDir), { recursive: true })
			await rename(candidateDir, outDir)
			return result
		} catch (error) {
			await rm(candidateDir, { recursive: true, force: true })
			throw error
		} finally {
			if (cache.ephemeral) await rm(cache.dir, { recursive: true, force: true })
		}
	})
}

function commonDirectory(left: string, right: string): string {
	const target = resolve(right)
	let current = resolve(left)
	for (;;) {
		const path = relative(current, target)
		if (!isAbsolute(path) && path !== '..' && !path.startsWith('../')) return current
		const parent = dirname(current)
		if (parent === current) return current
		current = parent
	}
}

async function isCommittedRevision(
	outDir: string,
	plan: WorkbenchFederationProducerPlan,
	shared: ResolvedFederationShared,
	packageMode: BuildWorkbenchFederationProducerOptions['packageMode'],
	typeAssets: WorkbenchFederationTypeAssetPolicy,
): Promise<boolean> {
	let stamp: ProducerStamp
	try {
		stamp = JSON.parse(
			await readFile(resolve(outDir, PRODUCER_STAMP_FILE), 'utf-8'),
		) as ProducerStamp
	} catch {
		return false
	}
	if (
		JSON.stringify(stamp) !==
		JSON.stringify(createStamp(plan, shared.signature, packageMode, typeAssets))
	) {
		return false
	}
	const validation = await validateWorkbenchFederationArtifact(outDir, {
		plan,
		compatibility: shared.compatibility,
		typeAssets,
	})
	return validation.valid
}

function createStamp(
	plan: WorkbenchFederationProducerPlan,
	compatibilitySignature: string,
	packageMode: BuildWorkbenchFederationProducerOptions['packageMode'],
	typeAssets: WorkbenchFederationTypeAssetPolicy,
): ProducerStamp {
	return {
		profile: WORKBENCH_PROFILE_VERSION,
		buildContract: WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
		packageMode,
		producer: plan.producer,
		buildRevision: plan.buildRevision,
		exposes: plan.entries.map((entry) => entry.expose),
		compatibilitySignature,
		...(typeAssets === 'required' ? {} : { typeAssets }),
	}
}

function resolveTypeAssetPolicy(
	options: BuildWorkbenchFederationProducerOptions,
): WorkbenchFederationTypeAssetPolicy {
	const typeAssets =
		options.typeAssets ?? (options.packageMode === 'development' ? 'optional' : 'required')
	if (typeAssets !== 'required' && typeAssets !== 'optional') {
		throw new TypeError('[workbench-ui] invalid Workbench federation type asset policy')
	}
	return typeAssets
}

function resolveBuildCacheDir(
	root: string,
	plan: WorkbenchFederationProducerPlan,
	options: BuildWorkbenchFederationProducerOptions,
	typeAssets: WorkbenchFederationTypeAssetPolicy,
	buildId: string,
): Readonly<{ dir: string; ephemeral: boolean }> {
	const cacheRoot = options.cacheDir
		? resolve(root, options.cacheDir)
		: resolve(root, '.pluxel/vite-workbench-ui-cache')
	const persistent = options.packageMode === 'development' || Boolean(options.cacheDir)
	if (persistent) {
		return Object.freeze({
			dir: resolve(cacheRoot, options.packageMode, typeAssets, plan.producer),
			ephemeral: false,
		})
	}
	return Object.freeze({
		dir: resolve(cacheRoot, 'ephemeral', `${plan.producer}-${buildId}`),
		ephemeral: true,
	})
}

function assertPlan(input: WorkbenchFederationProducerPlan): WorkbenchFederationProducerPlan {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('[workbench-ui] invalid Workbench federation producer plan')
	}
	const expectedPlanKeys = ['profile', 'definition', 'buildRevision', 'producer', 'entries']
	if (!hasExactKeys(input as unknown as Record<string, unknown>, expectedPlanKeys)) {
		throw new TypeError('[workbench-ui] invalid Workbench federation producer plan fields')
	}
	if (input.profile !== WORKBENCH_PROFILE_VERSION || !Array.isArray(input.entries)) {
		throw new TypeError('[workbench-ui] invalid Workbench federation producer plan profile')
	}
	for (const entry of input.entries) {
		if (
			!entry ||
			typeof entry !== 'object' ||
			Array.isArray(entry) ||
			!hasExactKeys(entry as unknown as Record<string, unknown>, [
				'descriptor',
				'expose',
				'bridgeEntryPath',
			])
		) {
			throw new TypeError('[workbench-ui] invalid Workbench federation producer entry fields')
		}
	}
	const canonical = createWorkbenchFederationProducerPlan({
		definition: input.definition,
		buildRevision: input.buildRevision,
		entries: input.entries.map((entry) => ({
			descriptor: entry.descriptor,
			bridgeEntryPath: entry.bridgeEntryPath,
		})),
	})
	if (
		input.producer !== canonical.producer ||
		input.entries.length !== canonical.entries.length ||
		input.entries.some(
			(entry, index) =>
				entry.expose !== canonical.entries[index]?.expose ||
				entry.bridgeEntryPath !== canonical.entries[index]?.bridgeEntryPath,
		)
	) {
		throw new TypeError('[workbench-ui] non-canonical Workbench federation producer plan')
	}
	return canonical
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(record)
	return keys.length === expected.length && keys.every((key) => expected.includes(key))
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		(): true => true,
		(): false => false,
	)
}
