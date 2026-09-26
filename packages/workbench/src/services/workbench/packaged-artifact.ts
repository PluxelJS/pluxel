import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { pluginDefinitionIndexKey } from '@pluxel/core'
import {
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	parseWorkbenchContentDeploymentInventory,
} from '@pluxel/core/internal'
import {
	WORKBENCH_FEDERATION_OUT_DIR,
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	parseWorkbenchFederationDeploymentInventory,
} from '@pluxel/core/federation'
import { isAbsolute, relative, resolve } from 'pathe'
import type {
	WorkbenchArtifactBatchCandidate,
	WorkbenchArtifactBatchCommit,
	WorkbenchArtifactCoordinator,
} from './WorkbenchArtifactCoordinator.ts'

/** Loads the one host-owned production inventory without invoking a source compiler. */
export async function loadPackagedWorkbenchDeployment(
	artifacts: WorkbenchArtifactCoordinator,
	workbenchRoot: string,
): Promise<readonly WorkbenchArtifactBatchCommit[]> {
	const candidates = await readPackagedWorkbenchCandidates(workbenchRoot)
	const prepared = await Promise.all(
		candidates.map((candidate) => artifacts.prepareCandidate(candidate)),
	)
	return Object.freeze(prepared.map((candidate) => artifacts.commitPrepared(candidate)))
}

/** Reads the same validated inventory for development admission without publishing it. */
export async function readPackagedWorkbenchCandidates(
	workbenchRoot: string,
	selected?: ReadonlySet<string>,
): Promise<readonly WorkbenchArtifactBatchCandidate[]> {
	const root = await canonicalWorkbenchRoot(workbenchRoot)
	const inventoryPath = resolve(root, WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE)
	let input: unknown
	try {
		input = JSON.parse(await readFile(inventoryPath, 'utf-8')) as unknown
	} catch (error) {
		throw new Error(`[workbench] cannot read production producer inventory: ${inventoryPath}`, {
			cause: error,
		})
	}
	const inventory = parseWorkbenchFederationDeploymentInventory(input)
	const candidates = new Map<string, WorkbenchArtifactBatchCandidate>()
	for (const producer of inventory.producers) {
		if (selected && !selected.has(pluginDefinitionIndexKey(producer.plan.definition))) continue
		const candidateRoot = await resolveDeploymentArtifactRoot(
			root,
			producer.artifactRoot,
			`${WORKBENCH_FEDERATION_OUT_DIR}/`,
			true,
		)
		const key = pluginDefinitionIndexKey(producer.plan.definition)
		if (candidates.has(key)) {
			throw new TypeError('[workbench] production deployment has duplicate definition artifacts')
		}
		candidates.set(
			key,
			Object.freeze({
				definition: producer.plan.definition,
				federation: Object.freeze({ plan: producer.plan, artifactRoot: candidateRoot }),
			}),
		)
	}

	const contentInventoryPath = resolve(root, WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE)
	let contentInput: unknown
	if (!existsSync(contentInventoryPath)) {
		contentInput = { version: 1, entries: [] }
	} else {
		try {
			contentInput = JSON.parse(await readFile(contentInventoryPath, 'utf-8')) as unknown
		} catch (error) {
			throw new Error(
				`[workbench] cannot read production Content inventory: ${contentInventoryPath}`,
				{
					cause: error,
				},
			)
		}
	}
	const contentInventory = parseWorkbenchContentDeploymentInventory(contentInput)
	for (const content of contentInventory.entries) {
		if (selected && !selected.has(pluginDefinitionIndexKey(content.definition))) continue
		const candidateRoot = await resolveDeploymentArtifactRoot(
			root,
			content.artifactRoot,
			'content/',
			false,
		)
		const key = pluginDefinitionIndexKey(content.definition)
		const existing = candidates.get(key)
		candidates.set(
			key,
			Object.freeze({
				definition: content.definition,
				...existing,
				content: Object.freeze({
					definition: content.definition,
					definitionDigest: content.definitionDigest,
					digest: content.digest,
					artifactRoot: candidateRoot,
				}),
			}),
		)
	}

	return Object.freeze(
		[...candidates]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, candidate]) => candidate),
	)
}

async function resolveDeploymentArtifactRoot(
	root: string,
	artifactRoot: string,
	prefix: string,
	stripPrefix: boolean,
): Promise<string> {
	if (!artifactRoot.startsWith(prefix)) {
		throw new TypeError('[workbench] production artifact root is outside the Workbench root')
	}
	const relativeRoot = stripPrefix ? artifactRoot.slice(prefix.length) : artifactRoot
	const candidateRoot = await realpath(resolve(root, relativeRoot)).catch((error) => {
		throw new Error(`[workbench] production artifact root does not exist: ${artifactRoot}`, {
			cause: error,
		})
	})
	const fromRoot = relative(root, candidateRoot)
	if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
		throw new TypeError(
			`[workbench] production artifact root escapes its deployment: ${artifactRoot}`,
		)
	}
	return candidateRoot
}

async function canonicalWorkbenchRoot(input: string): Promise<string> {
	if (typeof input !== 'string' || !input.trim()) {
		throw new TypeError('[workbench] production artifact root must be a non-empty path')
	}
	const root = await realpath(resolve(input)).catch((error) => {
		throw new Error('[workbench] production artifact root does not exist', { cause: error })
	})
	const rootStat = await stat(root)
	if (!rootStat.isDirectory()) {
		throw new TypeError('[workbench] production artifact root must be a directory')
	}
	return root
}
