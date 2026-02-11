import fs from 'node:fs'
import { dirname, resolve } from 'pathe'

const WORKSPACE_DEFAULT_DEST = 'plugins'

export type WorkspaceReason = 'pnpm-workspace' | 'turbo' | 'package-json' | 'explicit' | 'cwd'

type WorkspaceDetection = {
	root: string
	reason: Exclude<WorkspaceReason, 'explicit' | 'cwd'>
}

export type WorkspaceResolution = {
	root: string
	reason: WorkspaceReason
}

export function resolveWorkspaceRoot(cwd: string, rootInput?: string): WorkspaceResolution {
	const explicitRoot = typeof rootInput === 'string' && rootInput.trim().length > 0
	if (explicitRoot) {
		const root = resolve(cwd, rootInput)
		const inspected = inspectWorkspaceRoot(root)
		return { root, reason: inspected?.reason ?? 'explicit' }
	}

	const detected = detectWorkspaceRoot(cwd)
	if (detected) return detected

	return { root: cwd, reason: 'cwd' }
}

export function resolveDestination(rootInfo: WorkspaceResolution, destInput?: string) {
	const dest =
		typeof destInput === 'string' && destInput.trim().length > 0 ? destInput.trim() : undefined
	if (dest) {
		return { destBase: resolve(rootInfo.root, dest) }
	}
	const isWorkspace = rootInfo.reason !== 'cwd' && rootInfo.reason !== 'explicit'
	if (isWorkspace) {
		return { destBase: resolve(rootInfo.root, WORKSPACE_DEFAULT_DEST) }
	}
	return { destBase: rootInfo.root }
}

export function formatWorkspaceRoot(root: string, reason: WorkspaceReason) {
	if (reason === 'cwd' || reason === 'explicit') return root
	return `${root} (auto: ${reason})`
}

function detectWorkspaceRoot(cwd: string): WorkspaceDetection | null {
	let current = resolve(cwd)
	let firstPackageJson: string | null = null

	while (true) {
		const inspected = inspectWorkspaceRoot(current)
		if (inspected && inspected.reason !== 'package-json') {
			return inspected
		}
		if (!firstPackageJson && inspected?.reason === 'package-json') {
			firstPackageJson = current
		}

		const parent = dirname(current)
		if (parent === current) break
		current = parent
	}

	if (firstPackageJson) {
		return { root: firstPackageJson, reason: 'package-json' }
	}

	return null
}

function inspectWorkspaceRoot(root: string): WorkspaceDetection | null {
	if (existsFile(root, 'pnpm-workspace.yaml') || existsFile(root, 'pnpm-workspace.yml')) {
		return { root, reason: 'pnpm-workspace' }
	}
	if (existsFile(root, 'turbo.json') || existsFile(root, 'turbo.jsonc')) {
		return { root, reason: 'turbo' }
	}
	if (existsFile(root, 'package.json')) {
		return { root, reason: 'package-json' }
	}
	return null
}

function existsFile(root: string, name: string) {
	return fs.existsSync(resolve(root, name))
}

