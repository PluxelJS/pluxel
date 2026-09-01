import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { pluginDefinitionIndexKey, type Context, type PluginNodeAddress } from '@pluxel/core'
import {
	WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE,
	parseWorkbenchPageDeploymentInventory,
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

	const pageInventoryPath = resolve(root, WORKBENCH_PAGE_DEPLOYMENT_INVENTORY_FILE)
	let pageInput: unknown
	if (!existsSync(pageInventoryPath)) {
		pageInput = { version: 1, pages: [] }
	} else {
		try {
			pageInput = JSON.parse(await readFile(pageInventoryPath, 'utf-8')) as unknown
		} catch (error) {
			throw new Error(`[workbench] cannot read production Page inventory: ${pageInventoryPath}`, {
				cause: error,
			})
		}
	}
	const pageInventory = parseWorkbenchPageDeploymentInventory(pageInput)
	for (const page of pageInventory.pages) {
		const candidateRoot = await resolveDeploymentArtifactRoot(
			root,
			page.artifactRoot,
			'pages/',
			false,
		)
		const key = pluginDefinitionIndexKey(page.definition)
		const existing = candidates.get(key)
		candidates.set(
			key,
			Object.freeze({
				definition: page.definition,
				...existing,
				pages: Object.freeze({
					definition: page.definition,
					definitionDigest: page.definitionDigest,
					digest: page.digest,
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
