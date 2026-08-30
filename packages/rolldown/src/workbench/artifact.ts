import { readFile, stat } from 'node:fs/promises'
import {
	WORKBENCH_FEDERATION_MANIFEST_FILE,
	assertWorkbenchFederationSnapshotContract,
	parseWorkbenchFederationDeploymentInventory,
	parseWorkbenchFederationManifestContract,
	workbenchFederationDeploymentInventoryPath,
	type WorkbenchFederationDeploymentInventory,
	type WorkbenchFederationManifestExpectation,
	type WorkbenchFederationProducerPlan,
} from '@pluxel/core/federation'
import {
	generateSnapshotFromManifest,
	type Manifest,
	type ProviderModuleInfo,
} from '@module-federation/sdk'
import { join } from 'pathe'
import type { WorkbenchFederationCompatibilitySet } from './build-contract.ts'

export type WorkbenchFederationArtifactExpectation = Readonly<{
	plan: WorkbenchFederationProducerPlan
	compatibility: WorkbenchFederationCompatibilitySet
}>

export type WorkbenchArtifactValidation =
	| Readonly<{ valid: true; manifest: Manifest; snapshot: ProviderModuleInfo }>
	| Readonly<{ valid: false; reason: string }>

/** Reads the canonical host-owned producer inventory from one deployment root. */
export async function readWorkbenchFederationDeploymentInventory(
	deploymentRoot: string,
): Promise<WorkbenchFederationDeploymentInventory> {
	const path = join(deploymentRoot, workbenchFederationDeploymentInventoryPath(''))
	let input: unknown
	try {
		input = JSON.parse(await readFile(path, 'utf-8'))
	} catch (error) {
		throw new Error(`[workbench-ui] cannot read deployment producer inventory: ${path}`, {
			cause: error,
		})
	}
	return parseWorkbenchFederationDeploymentInventory(input)
}

/** Validates the standard MF Manifest/Snapshot and its exact Profile 1 declared inventory. */
export async function validateWorkbenchFederationArtifact(
	outDir: string,
	expected: WorkbenchFederationArtifactExpectation,
): Promise<WorkbenchArtifactValidation> {
	const manifestPath = join(outDir, WORKBENCH_FEDERATION_MANIFEST_FILE)
	let manifest: Manifest
	let files: readonly string[]
	try {
		const input = JSON.parse(await readFile(manifestPath, 'utf-8')) as unknown
		files = parseWorkbenchFederationManifestContract(
			input,
			expected satisfies WorkbenchFederationManifestExpectation,
		).files
		manifest = input as Manifest
	} catch (error) {
		return {
			valid: false,
			reason: `invalid ${WORKBENCH_FEDERATION_MANIFEST_FILE}: ${message(error)}`,
		}
	}

	for (const asset of files) {
		if (!(await isFile(join(outDir, asset)))) {
			return { valid: false, reason: `artifact asset missing: ${asset}` }
		}
	}

	let snapshot: ProviderModuleInfo
	try {
		snapshot = generateSnapshotFromManifest(manifest, {
			version: expected.plan.buildRevision,
		})
		assertWorkbenchFederationSnapshotContract(snapshot, expected.plan)
	} catch (error) {
		return {
			valid: false,
			reason: `manifest cannot produce a standard Snapshot: ${message(error)}`,
		}
	}
	return { valid: true, manifest, snapshot }
}

async function isFile(path: string): Promise<boolean> {
	const fileStat = await stat(path).catch((): null => null)
	return fileStat?.isFile() === true
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
