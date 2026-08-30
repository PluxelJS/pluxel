import { existsSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import type { Context, PluginNodeAddress } from '@pluxel/core'
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
	WorkbenchArtifactRevision,
	WorkbenchArtifactService,
} from './WorkbenchArtifactService'

/** Loads the one host-owned production inventory without invoking a source compiler. */
export async function loadPackagedWorkbenchDeployment(
	artifacts: WorkbenchArtifactService,
	workbenchRoot: string,
): Promise<readonly WorkbenchArtifactRevision[]> {
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
	const committed: WorkbenchArtifactRevision[] = []
	for (const producer of inventory.producers) {
		const prefix = `${WORKBENCH_FEDERATION_OUT_DIR}/`
		if (!producer.artifactRoot.startsWith(prefix)) {
			throw new TypeError('[workbench] production artifact root is outside the Workbench root')
		}
		const candidateRoot = await realpath(
			resolve(root, producer.artifactRoot.slice(prefix.length)),
		).catch((error) => {
			throw new Error(
				`[workbench] production artifact root does not exist: ${producer.artifactRoot}`,
				{ cause: error },
			)
		})
		const fromRoot = relative(root, candidateRoot)
		if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
			throw new TypeError(
				`[workbench] production artifact root escapes its deployment: ${producer.artifactRoot}`,
			)
		}
		committed.push(
			await artifacts.commitCandidate({ plan: producer.plan, artifactRoot: candidateRoot }),
		)
	}
	return Object.freeze(committed)
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
