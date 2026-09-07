import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'pathe'
import { intersects, validRange } from 'semver'
import { sourcePnpmfileBootstrapContents } from '../source/execution'

export const SUPPORTED_PNPM_MAJOR = 11
const SUPPORTED_PNPM_RANGE = '>=11 <12'

export interface WorkspaceGovernanceDiagnostics {
	errors: string[]
	warnings: string[]
}

export function diagnoseWorkspaceGovernance(root: string): WorkspaceGovernanceDiagnostics {
	const errors: string[] = []
	const warnings: string[] = []
	const manifestPath = resolve(root, 'package.json')
	if (!existsSync(manifestPath))
		return { errors: [`Workspace has no package.json: ${manifestPath}`], warnings }

	let manifest: Record<string, unknown>
	try {
		const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
		if (!isRecord(value)) throw new Error('root must be an object')
		manifest = value
	} catch (error) {
		return {
			errors: [
				`Cannot read workspace package.json: ${error instanceof Error ? error.message : String(error)}`,
			],
			warnings,
		}
	}

	checkPackageManager(manifest, errors)
	if (!existsSync(resolve(root, 'pnpm-workspace.yaml'))) {
		errors.push('Pluxel workspaces must declare members and catalogs in pnpm-workspace.yaml')
	}

	if (existsSync(resolve(root, 'pluxel.sources.jsonc'))) {
		const pnpmfilePath = resolve(root, '.pnpmfile.cjs')
		if (!existsSync(pnpmfilePath)) {
			warnings.push('Source overlay is inactive; run `pluxel source install` before using it')
		} else if (readFileSync(pnpmfilePath, 'utf8') !== sourcePnpmfileBootstrapContents()) {
			errors.push('Source workspace bootstrap is stale or custom; run `pluxel source install`')
		}
	}

	if (existsSync(resolve(root, 'docs/pluxel'))) {
		warnings.push('docs/pluxel is a copied framework snapshot; link to `pluxel docs` instead')
	}
	return { errors, warnings }
}

function checkPackageManager(manifest: Record<string, unknown>, errors: string[]): void {
	const packageManager = manifest.packageManager
	const devEngines = isRecord(manifest.devEngines) ? manifest.devEngines : undefined
	const devPackageManager = isRecord(devEngines?.packageManager)
		? devEngines.packageManager
		: undefined

	if (packageManager === undefined && devPackageManager === undefined) {
		errors.push('Declare pnpm policy with packageManager or devEngines.packageManager')
		return
	}
	if (packageManager !== undefined) {
		if (typeof packageManager !== 'string') {
			errors.push('packageManager must be an exact pnpm version such as pnpm@11.25.0')
		} else {
			const match = /^pnpm@(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
				packageManager,
			)
			if (!match) errors.push('packageManager must be an exact pnpm version such as pnpm@11.25.0')
			else if (Number(match[1]) !== SUPPORTED_PNPM_MAJOR) {
				errors.push(`packageManager must use supported pnpm major ${SUPPORTED_PNPM_MAJOR}`)
			}
		}
	}
	if (devPackageManager !== undefined) {
		if (devPackageManager.name !== 'pnpm')
			errors.push('devEngines.packageManager.name must be pnpm')
		const version = devPackageManager.version
		if (
			typeof version !== 'string' ||
			validRange(version) === null ||
			!intersects(version, SUPPORTED_PNPM_RANGE)
		) {
			errors.push(`devEngines.packageManager.version must accept pnpm ${SUPPORTED_PNPM_MAJOR}`)
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
