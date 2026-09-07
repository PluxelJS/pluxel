import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { pluginDefinitionIndexKey, type Context, type PluginNodeAddress } from '@pluxel/core'
import {
	WORKBENCH_CONTENT_DEPLOYMENT_INVENTORY_FILE,
	parseWorkbenchContentDeploymentInventory,
} from '@pluxel/core/internal'
import {
	WORKBENCH_FEDERATION_OUT_DIR,
	WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE,
	parseWorkbenchFederationDeploymentInventory,
} from '@pluxel/core/federation'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import { resolveModuleIdBaseDir } from '../../runtime/module-id'
import {
	pluginCatalogEntry,
	requireRuntimePluginGraphCoordinator,
} from '../../internal/reconciliation'
import type {
	WorkbenchArtifactBatchCandidate,
	WorkbenchArtifactBatchCommit,
	WorkbenchArtifactCoordinator,
} from './WorkbenchArtifactCoordinator'

/** Loads the one host-owned production inventory without invoking a source compiler. */
export async function loadPackagedWorkbenchDeployment(
	artifacts: WorkbenchArtifactCoordinator,
	workbenchRoot: string,
): Promise<readonly WorkbenchArtifactBatchCommit[]> {
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

	const ordered = [...candidates].sort(([left], [right]) => left.localeCompare(right))
	const prepared = await Promise.all(
		ordered.map(([, candidate]) => artifacts.prepareCandidate(candidate)),
	)
	return Object.freeze(prepared.map((candidate) => artifacts.commitPrepared(candidate)))
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

export function resolvePackagedNodeModule(
	root: Context,
	owner: PluginNodeAddress,
	artifactKey: string,
): string | null {
	const registryPath = pluginModuleId(root, owner)
	if (!registryPath) return null
	const baseDir = resolveModuleIdBaseDir(registryPath)
	if (!baseDir) return null
	const packageRoot = findNearestPackageRoot(baseDir)
	return resolve(packageRoot ?? baseDir, 'dist/artifacts/node', `${artifactKey}.mjs`)
}

function pluginModuleId(root: Context, owner: PluginNodeAddress): string | undefined {
	const moduleId = pluginCatalogEntry(
		requireRuntimePluginGraphCoordinator(root).catalogSnapshot(),
		owner.definition,
	)?.provenance.moduleId
	return typeof moduleId === 'string' ? moduleId : undefined
}

function findNearestPackageRoot(start: string): string | null {
	let current = start
	while (true) {
		if (existsSync(resolve(current, 'package.json'))) return current
		const parent = dirname(current)
		if (parent === current) return null
		current = parent
	}
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
