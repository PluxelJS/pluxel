import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import {
	WORKBENCH_PAGE_ARTIFACT_FILE,
	WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE,
	createWorkbenchPageDeploymentInventory,
	parseWorkbenchPageDeploymentInventory,
	parseWorkbenchPageSet,
	serializeWorkbenchPageDefinition,
	serializeWorkbenchPageSet,
	workbenchPageArtifactRoot,
	type WorkbenchPageDeploymentEntryV1,
	type WorkbenchPageDeploymentInventoryV1,
} from '@pluxel/core/internal'
import { dirname, resolve } from 'pathe'
import type { WorkbenchSemanticPageCompilation } from './semantic-lowering.ts'
import { runWorkbenchOutputTransaction } from './build-scheduler.ts'

export function pageDeploymentEntry(
	compilation: WorkbenchSemanticPageCompilation,
): WorkbenchPageDeploymentEntryV1 {
	const definitionDigest = sha256(
		new TextEncoder().encode(serializeWorkbenchPageDefinition(compilation.pageSet.definition)),
	)
	return Object.freeze({
		definition: compilation.pageSet.definition,
		definitionDigest,
		digest: compilation.digest,
		artifactRoot: workbenchPageArtifactRoot(definitionDigest, compilation.digest),
	})
}

/** Publishes one already-compiled Page set as an immutable single-file artifact. */
export async function publishWorkbenchPageArtifact(
	deploymentRoot: string,
	buildDir: string,
	compilation: WorkbenchSemanticPageCompilation,
): Promise<WorkbenchPageDeploymentEntryV1> {
	const entry = pageDeploymentEntry(compilation)
	const target = resolve(deploymentRoot, buildDir, 'workbench', entry.artifactRoot)
	await runWorkbenchOutputTransaction(target, async () => {
		if (await pathExists(target)) {
			await assertCommittedArtifact(target, compilation)
			return
		}
		const candidate = `${target}.candidate-${randomUUID()}`
		try {
			await mkdir(candidate, { recursive: true })
			await writeFile(resolve(candidate, WORKBENCH_PAGE_ARTIFACT_FILE), compilation.bytes, {
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

export async function writeWorkbenchPageDeploymentInventory(
	deploymentRoot: string,
	buildDir: string,
	entries: readonly WorkbenchPageDeploymentEntryV1[],
): Promise<WorkbenchPageDeploymentInventoryV1> {
	const sorted = [...entries].sort((left, right) =>
		pluginDefinitionIndexKey(left.definition).localeCompare(
			pluginDefinitionIndexKey(right.definition),
		),
	)
	const inventory = createWorkbenchPageDeploymentInventory(sorted)
	const target = resolve(
		deploymentRoot,
		buildDir,
		'workbench',
		WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE,
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

export async function readWorkbenchPageDeploymentInventory(
	workbenchRoot: string,
): Promise<WorkbenchPageDeploymentInventoryV1> {
	const path = resolve(workbenchRoot, WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE)
	let input: unknown
	try {
		input = JSON.parse(await readFile(path, 'utf-8')) as unknown
	} catch (error) {
		throw new Error(`[workbench-page] cannot read deployment inventory: ${path}`, {
			cause: error,
		})
	}
	return parseWorkbenchPageDeploymentInventory(input)
}

async function assertCommittedArtifact(
	root: string,
	compilation: WorkbenchSemanticPageCompilation,
): Promise<void> {
	const path = resolve(root, WORKBENCH_PAGE_ARTIFACT_FILE)
	const bytes = await readFile(path).catch((error) => {
		throw new Error(`[workbench-page] Page artifact is missing: ${path}`, { cause: error })
	})
	if (sha256(bytes) !== compilation.digest) {
		throw new Error(`[workbench-page] immutable Page artifact digest collision: ${root}`)
	}
	let pageSet
	try {
		pageSet = parseWorkbenchPageSet(JSON.parse(new TextDecoder().decode(bytes)) as unknown)
	} catch (error) {
		throw new TypeError(`[workbench-page] Page artifact is invalid: ${path}`, { cause: error })
	}
	const canonical = new TextEncoder().encode(serializeWorkbenchPageSet(pageSet))
	if (
		canonical.byteLength !== bytes.byteLength ||
		!Buffer.from(canonical).equals(Buffer.from(bytes)) ||
		serializeWorkbenchPageSet(pageSet) !== serializeWorkbenchPageSet(compilation.pageSet)
	) {
		throw new Error(`[workbench-page] immutable Page artifact content collision: ${root}`)
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
