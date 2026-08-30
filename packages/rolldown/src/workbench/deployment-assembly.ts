import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import {
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	WORKBENCH_FEDERATION_OUT_DIR,
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	createWorkbenchFederationDeploymentInventory,
	parseWorkbenchFederationDeploymentInventory,
	type WorkbenchFederationDeploymentInventory,
	type WorkbenchFederationDeploymentProducer,
} from '@pluxel/core/federation'
import { dirname, relative, resolve } from 'pathe'

export type WorkbenchDeploymentArtifact = Readonly<{
	producer: string
	buildRevision: string
	manifest: string
	sha256: string
}>

export type AssembleWorkbenchDeploymentInput = Readonly<{
	/** The application build's existing `workbench` directory. Its inventory is required. */
	destinationRoot: string
	/** Canonical `dist/workbench` directories discovered from bundled dependency packages. */
	dependencyRoots: readonly string[]
}>

type ProducerSource = Readonly<{
	producer: WorkbenchFederationDeploymentProducer
	artifactRoot: string
	fingerprint: string
}>

/**
 * Merges the application and bundled-package producer inventories into one deployment inventory.
 *
 * Inventories are the only discovery mechanism. Artifact directories are copied as immutable
 * `producer/revision` trees; no flat-directory scan or legacy topology fallback is accepted.
 */
export async function assembleWorkbenchDeploymentArtifacts(
	input: AssembleWorkbenchDeploymentInput,
): Promise<WorkbenchFederationDeploymentInventory> {
	const destinationRoot = resolve(input.destinationRoot)
	const localInventory = await readInventory(destinationRoot, true)
	const sourceRoots = [...new Set(input.dependencyRoots.map((root) => resolve(root)))]
		.filter((root) => root !== destinationRoot)
		.sort((left, right) => left.localeCompare(right))
	const inventories = [
		{ root: destinationRoot, inventory: localInventory },
		...(await Promise.all(
			sourceRoots.map(async (root) => ({ root, inventory: await readInventory(root, false) })),
		)),
	]

	const merged = new Map<string, ProducerSource>()
	for (const source of inventories) {
		if (!source.inventory) continue
		for (const producer of source.inventory.producers) {
			const artifactRoot = resolveArtifactRoot(source.root, producer)
			const fingerprint = await fingerprintArtifactTree(artifactRoot)
			const candidate = Object.freeze({ producer, artifactRoot, fingerprint })
			const existing = merged.get(producer.plan.producer)
			if (!existing) {
				merged.set(producer.plan.producer, candidate)
				continue
			}
			assertDuplicateProducerEqual(existing, candidate)
		}
	}

	const producers = [...merged.values()].sort((left, right) =>
		left.producer.plan.producer.localeCompare(right.producer.plan.producer),
	)
	for (const source of producers) {
		const target = resolveArtifactRoot(destinationRoot, source.producer)
		if (target === source.artifactRoot) continue
		const existingFingerprint = await fingerprintArtifactTree(target, false)
		if (existingFingerprint !== null) {
			if (existingFingerprint !== source.fingerprint) {
				throw new Error(
					`[static-application] Workbench artifact content collision: ${source.producer.plan.producer}@${source.producer.plan.buildRevision}`,
				)
			}
			continue
		}
		await publishArtifactTree(source.artifactRoot, target, source.fingerprint)
	}

	const inventory = createWorkbenchFederationDeploymentInventory(
		producers.map(({ producer }) => producer.plan),
	)
	await writeInventory(destinationRoot, inventory)
	return inventory
}

/** Derives deployment metadata only from the merged canonical producer inventory. */
export async function collectWorkbenchDeploymentArtifacts(
	destinationRoot: string,
	inventory: WorkbenchFederationDeploymentInventory,
): Promise<readonly WorkbenchDeploymentArtifact[]> {
	const canonical = parseWorkbenchFederationDeploymentInventory(inventory)
	const root = resolve(destinationRoot)
	const deploymentRoot = dirname(root)
	return Promise.all(
		canonical.producers.map(async (producer) => {
			const manifestPath = resolve(
				resolveArtifactRoot(root, producer),
				WORKBENCH_FEDERATION_MANIFEST_FILE,
			)
			const body = await readFile(manifestPath).catch((error) => {
				throw new Error(
					`[static-application] Workbench artifact manifest is missing: ${producer.plan.producer}@${producer.plan.buildRevision}`,
					{ cause: error },
				)
			})
			return Object.freeze({
				producer: producer.plan.producer,
				buildRevision: producer.plan.buildRevision,
				manifest: relative(deploymentRoot, manifestPath),
				sha256: sha256(body),
			})
		}),
	)
}

async function readInventory(
	root: string,
	required: true,
): Promise<WorkbenchFederationDeploymentInventory>
async function readInventory(
	root: string,
	required: false,
): Promise<WorkbenchFederationDeploymentInventory | null>
async function readInventory(
	root: string,
	required: boolean,
): Promise<WorkbenchFederationDeploymentInventory | null> {
	const path = resolve(root, WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE)
	let content: string
	try {
		content = await readFile(path, 'utf-8')
	} catch (error) {
		if (!required && isNotFound(error)) return null
		throw new Error(`[static-application] cannot read Workbench producer inventory: ${path}`, {
			cause: error,
		})
	}
	try {
		return parseWorkbenchFederationDeploymentInventory(JSON.parse(content) as unknown)
	} catch (error) {
		throw new Error(`[static-application] invalid Workbench producer inventory: ${path}`, {
			cause: error,
		})
	}
}

function resolveArtifactRoot(
	workbenchRoot: string,
	producer: WorkbenchFederationDeploymentProducer,
): string {
	const prefix = `${WORKBENCH_FEDERATION_OUT_DIR}/`
	if (!producer.artifactRoot.startsWith(prefix)) {
		throw new TypeError(
			`[static-application] invalid Workbench artifact root: ${producer.artifactRoot}`,
		)
	}
	return resolve(workbenchRoot, producer.artifactRoot.slice(prefix.length))
}

function assertDuplicateProducerEqual(left: ProducerSource, right: ProducerSource): void {
	const producer = left.producer.plan.producer
	if (left.producer.plan.buildRevision !== right.producer.plan.buildRevision) {
		throw new Error(
			`[static-application] Workbench producer revision collision: ${producer} (${left.producer.plan.buildRevision} != ${right.producer.plan.buildRevision})`,
		)
	}
	if (JSON.stringify(left.producer.plan) !== JSON.stringify(right.producer.plan)) {
		throw new Error(`[static-application] Workbench producer plan collision: ${producer}`)
	}
	if (left.fingerprint !== right.fingerprint) {
		throw new Error(
			`[static-application] Workbench artifact content collision: ${producer}@${left.producer.plan.buildRevision}`,
		)
	}
}

async function publishArtifactTree(
	source: string,
	target: string,
	expectedFingerprint: string,
): Promise<void> {
	const candidate = `${target}.candidate-${randomUUID()}`
	await mkdir(dirname(target), { recursive: true })
	try {
		await copyArtifactDirectory(source, candidate)
		const actualFingerprint = await fingerprintArtifactTree(candidate)
		if (actualFingerprint !== expectedFingerprint) {
			throw new Error(`[static-application] Workbench artifact changed while copying: ${source}`)
		}
		await rename(candidate, target)
	} catch (error) {
		await rm(candidate, { recursive: true, force: true })
		throw error
	}
}

async function copyArtifactDirectory(source: string, target: string): Promise<void> {
	const sourceStat = await lstat(source).catch((error) => {
		throw new Error(`[static-application] Workbench artifact directory is missing: ${source}`, {
			cause: error,
		})
	})
	if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
		throw new TypeError(
			`[static-application] Workbench artifact root is not a directory: ${source}`,
		)
	}
	await mkdir(target)
	const entries = await readdir(source, { withFileTypes: true })
	entries.sort((left, right) => left.name.localeCompare(right.name))
	for (const entry of entries) {
		const sourcePath = resolve(source, entry.name)
		const targetPath = resolve(target, entry.name)
		if (entry.isDirectory()) {
			await copyArtifactDirectory(sourcePath, targetPath)
		} else if (entry.isFile()) {
			await copyFile(sourcePath, targetPath)
		} else {
			throw new TypeError(
				`[static-application] Workbench artifact contains a non-regular entry: ${sourcePath}`,
			)
		}
	}
}

async function fingerprintArtifactTree(root: string): Promise<string>
async function fingerprintArtifactTree(root: string, required: false): Promise<string | null>
async function fingerprintArtifactTree(root: string, required?: boolean): Promise<string | null> {
	let rootStat
	try {
		rootStat = await lstat(root)
	} catch (error) {
		if (required === false && isNotFound(error)) return null
		throw new Error(`[static-application] Workbench artifact directory is missing: ${root}`, {
			cause: error,
		})
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
		throw new TypeError(`[static-application] Workbench artifact root is not a directory: ${root}`)
	}
	const records: string[] = []
	await collectTreeRecords(root, root, records)
	if (!records.some((record) => record.startsWith(`f:${WORKBENCH_FEDERATION_MANIFEST_FILE}:`))) {
		throw new Error(`[static-application] Workbench artifact has no manifest: ${root}`)
	}
	return sha256(Buffer.from(records.join('\n')))
}

async function collectTreeRecords(
	root: string,
	directory: string,
	records: string[],
): Promise<void> {
	const entries = await readdir(directory, { withFileTypes: true })
	entries.sort((left, right) => left.name.localeCompare(right.name))
	for (const entry of entries) {
		const path = resolve(directory, entry.name)
		const subpath = relative(root, path)
		if (entry.isDirectory()) {
			records.push(`d:${subpath}`)
			await collectTreeRecords(root, path, records)
		} else if (entry.isFile()) {
			records.push(`f:${subpath}:${sha256(await readFile(path))}`)
		} else {
			throw new TypeError(
				`[static-application] Workbench artifact contains a non-regular entry: ${path}`,
			)
		}
	}
}

async function writeInventory(
	root: string,
	inventory: WorkbenchFederationDeploymentInventory,
): Promise<void> {
	const target = resolve(root, WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE)
	const candidate = `${target}.candidate-${randomUUID()}`
	await mkdir(root, { recursive: true })
	try {
		await writeFile(candidate, `${JSON.stringify(inventory)}\n`, 'utf-8')
		await rename(candidate, target)
	} catch (error) {
		await rm(candidate, { force: true })
		throw error
	}
}

function sha256(input: Uint8Array): string {
	return createHash('sha256').update(input).digest('hex')
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'ENOENT'
	)
}
