import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import {
	WORKBENCH_CONTENT_ARTIFACT_FILE,
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchContentDeploymentInventory,
	parseWorkbenchContentDeploymentInventory,
	parseWorkbenchContentSet,
	serializeWorkbenchContentDefinition,
	serializeWorkbenchContentSet,
	workbenchContentArtifactRoot,
	type WorkbenchContentDeploymentEntry,
	type WorkbenchContentDeploymentInventory,
} from '@pluxel/core/internal'
import { dirname, resolve } from 'pathe'
import type { WorkbenchSemanticContentCompilation } from './semantic-lowering.ts'
import { runWorkbenchOutputTransaction } from './build-scheduler.ts'

export function contentDeploymentEntry(
	compilation: WorkbenchSemanticContentCompilation,
): WorkbenchContentDeploymentEntry {
	const definitionDigest = sha256(
		new TextEncoder().encode(
			serializeWorkbenchContentDefinition(compilation.contentSet.definition),
		),
	)
	return Object.freeze({
		definition: compilation.contentSet.definition,
		definitionDigest,
		digest: compilation.digest,
		artifactRoot: workbenchContentArtifactRoot(definitionDigest, compilation.digest),
	})
}

/** Publishes one already-compiled Content set as an immutable single-file artifact. */
export async function publishWorkbenchContentArtifact(
	deploymentRoot: string,
	buildDir: string,
	compilation: WorkbenchSemanticContentCompilation,
): Promise<WorkbenchContentDeploymentEntry> {
	const entry = contentDeploymentEntry(compilation)
	const target = resolve(deploymentRoot, buildDir, 'workbench', entry.artifactRoot)
	await runWorkbenchOutputTransaction(target, async () => {
		if (await pathExists(target)) {
			await assertCommittedArtifact(target, compilation)
			return
		}
		const candidate = `${target}.candidate-${randomUUID()}`
		try {
			await mkdir(candidate, { recursive: true })
			await writeFile(resolve(candidate, WORKBENCH_CONTENT_ARTIFACT_FILE), compilation.bytes, {
				flag: 'wx',
			})
			await assertCommittedArtifact(candidate, compilation)
			await mkdir(dirname(target), { recursive: true })
			await rename(candidate, target)
		} catch (error) {
			await rm(candidate, { recursive: true, force: true })
			throw error
		}
	})
	return entry
}

export async function writeWorkbenchContentDeploymentInventory(
	deploymentRoot: string,
	buildDir: string,
	entries: readonly WorkbenchContentDeploymentEntry[],
): Promise<WorkbenchContentDeploymentInventory> {
	const sorted = [...entries].sort((left, right) =>
		pluginDefinitionIndexKey(left.definition).localeCompare(
			pluginDefinitionIndexKey(right.definition),
		),
	)
	const inventory = createWorkbenchContentDeploymentInventory(sorted)
	const target = resolve(
		deploymentRoot,
		buildDir,
		'workbench',
		WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	)
	const candidate = `${target}.candidate-${randomUUID()}`
	await mkdir(dirname(target), { recursive: true })
	try {
		await writeFile(candidate, `${JSON.stringify(inventory)}\n`, { encoding: 'utf-8', flag: 'wx' })
		await rename(candidate, target)
	} catch (error) {
		await rm(candidate, { force: true })
		throw error
	}
	return inventory
}

export async function readWorkbenchContentDeploymentInventory(
	workbenchRoot: string,
): Promise<WorkbenchContentDeploymentInventory> {
	const path = resolve(workbenchRoot, WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE)
	let input: unknown
	try {
		input = JSON.parse(await readFile(path, 'utf-8')) as unknown
	} catch (error) {
		throw new Error(`[workbench-content] cannot read deployment inventory: ${path}`, {
			cause: error,
		})
	}
	return parseWorkbenchContentDeploymentInventory(input)
}

async function assertCommittedArtifact(
	root: string,
	compilation: WorkbenchSemanticContentCompilation,
): Promise<void> {
	const path = resolve(root, WORKBENCH_CONTENT_ARTIFACT_FILE)
	const bytes = await readFile(path).catch((error) => {
		throw new Error(`[workbench-content] Content artifact is missing: ${path}`, { cause: error })
	})
	if (sha256(bytes) !== compilation.digest) {
		throw new Error(`[workbench-content] immutable Content artifact digest collision: ${root}`)
	}
	let contentSet
	try {
		contentSet = parseWorkbenchContentSet(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
	} catch (error) {
		throw new TypeError(`[workbench-content] Content artifact is invalid: ${path}`, {
			cause: error,
		})
	}
	const canonical = new TextEncoder().encode(serializeWorkbenchContentSet(contentSet))
	if (
		canonical.byteLength !== bytes.byteLength ||
		!Buffer.from(canonical).equals(Buffer.from(bytes)) ||
		serializeWorkbenchContentSet(contentSet) !==
			serializeWorkbenchContentSet(compilation.contentSet)
	) {
		throw new Error(`[workbench-content] immutable Content artifact collision: ${root}`)
	}
}

async function pathExists(path: string): Promise<boolean> {
	return stat(path)
		.then(() => true)
		.catch(() => false)
}

function sha256(input: Uint8Array): string {
	return createHash('sha256').update(input).digest('hex')
}
