import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import {
	WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_PROFILE_VERSION,
	createWorkbenchFederationProducerPlan,
	workbenchFederationBuildOutDir,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import {
	resolveWorkbenchFederationBridgeEntry,
	resolveWorkbenchFederationShared,
	type ResolvedFederationShared,
} from '../workbench/build-contract.ts'
import {
	runWorkbenchFederationBuild,
	runWorkbenchOutputTransaction,
} from '../workbench/build-scheduler.ts'
import { resolveParaglideIntegration } from './paraglide.ts'
import { validateWorkbenchFederationArtifact } from '../workbench/artifact.ts'
import {
	runWorkbenchUiWorker,
	type WorkbenchUiWorkerPayload,
} from './workbench-ui-worker.ts'

export type BuildWorkbenchFederationProducerOptions = Readonly<{
	plan: WorkbenchFederationProducerPlan
	/** Package root used to resolve generated Bridge entries and producer source dependencies. */
	root?: string
	/** Host application root that provides the fixed shared winners. @defaultValue root */
	applicationRoot?: string
	outDir?: string
	minify?: boolean
	sourcemap?: boolean
	signal?: AbortSignal
}>

export type WorkbenchFederationProducerBuild = Readonly<{
	outDir: string
	manifestPath: string
	compatibilitySignature: string
}>

export { canonicalCompatibilitySignature } from '../workbench/build-contract.ts'
export { resolveWorkbenchFederationShared, type ResolvedFederationShared }

const PRODUCER_STAMP_FILE = 'pluxel-producer.json'
type ProducerStamp = Readonly<{
	profile: typeof WORKBENCH_PROFILE_VERSION
	buildContract: typeof WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION
	producer: string
	buildRevision: string
	exposes: readonly string[]
	compatibilitySignature: string
}>

export async function buildWorkbenchFederationProducer(
	options: BuildWorkbenchFederationProducerOptions,
): Promise<WorkbenchFederationProducerBuild> {
	const root = resolve(options.root ?? process.cwd())
	const applicationRoot = resolve(options.applicationRoot ?? root)
	const plan = assertPlan(options.plan)
	const outDir = resolve(root, options.outDir ?? workbenchFederationBuildOutDir(plan))
	const resolvedShared = resolveWorkbenchFederationShared(applicationRoot)
	const compatibilitySignature = resolvedShared.signature
	const result = Object.freeze({
		outDir,
		manifestPath: resolve(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE),
		compatibilitySignature,
	})

	return runWorkbenchOutputTransaction(outDir, async () => {
		if (await isCommittedRevision(outDir, plan, resolvedShared)) return result
		if (await exists(outDir)) {
			throw new Error(
				`[workbench-ui] immutable producer revision already exists but does not match its plan: ${outDir}`,
			)
		}

		const buildId = randomUUID()
		const candidateDir = `${outDir}.candidate-${buildId}`
		const cacheDir = resolve(root, '.pluxel/vite-workbench-ui-cache', `${plan.producer}-${buildId}`)
		await rm(candidateDir, { recursive: true, force: true })
		try {
			const paraglide = resolveParaglideIntegration(root)
			const payload: WorkbenchUiWorkerPayload = {
				root,
				applicationRoot,
				declarationRoot: commonDirectory(root, applicationRoot),
				outDir: candidateDir,
				producer: plan.producer,
				exposes: Object.fromEntries(
					plan.entries.map((entry) => [entry.expose, resolve(root, entry.bridgeEntryPath)]),
				),
				cacheDir,
				shared: resolvedShared.shared,
				bridgeReactEntry: resolveWorkbenchFederationBridgeEntry(),
				minify: options.minify ?? true,
				sourcemap: options.sourcemap ?? false,
				paraglide: paraglide ? { project: paraglide.project, outdir: paraglide.outdir } : null,
			}
			if (options.signal?.aborted) throw options.signal.reason
			await runWorkbenchFederationBuild(applicationRoot, () => runWorkbenchUiWorker(payload))
			if (options.signal?.aborted) throw options.signal.reason
			const validation = await validateWorkbenchFederationArtifact(candidateDir, {
				plan,
				compatibility: resolvedShared.compatibility,
			})
			if (validation.valid === false) {
				throw new Error(
					`[workbench-ui] invalid federation producer candidate: ${validation.reason}`,
				)
			}
			await writeFile(
				resolve(candidateDir, PRODUCER_STAMP_FILE),
				`${JSON.stringify(createStamp(plan, compatibilitySignature))}\n`,
				'utf-8',
			)
			await mkdir(dirname(outDir), { recursive: true })
			await rename(candidateDir, outDir)
			return result
		} catch (error) {
			await rm(candidateDir, { recursive: true, force: true })
			throw error
		} finally {
			await rm(cacheDir, { recursive: true, force: true })
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
): Promise<boolean> {
	let stamp: ProducerStamp
	try {
		stamp = JSON.parse(
			await readFile(resolve(outDir, PRODUCER_STAMP_FILE), 'utf-8'),
		) as ProducerStamp
	} catch {
		return false
	}
	if (JSON.stringify(stamp) !== JSON.stringify(createStamp(plan, shared.signature))) return false
	const validation = await validateWorkbenchFederationArtifact(outDir, {
		plan,
		compatibility: shared.compatibility,
	})
	return validation.valid
}

function createStamp(
	plan: WorkbenchFederationProducerPlan,
	compatibilitySignature: string,
): ProducerStamp {
	return {
		profile: WORKBENCH_PROFILE_VERSION,
		buildContract: WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
		producer: plan.producer,
		buildRevision: plan.buildRevision,
		exposes: plan.entries.map((entry) => entry.expose),
		compatibilitySignature,
	}
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
