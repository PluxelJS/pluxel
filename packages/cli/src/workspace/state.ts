import { existsSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve } from 'pathe'
import { loadOfficialCapability } from '../capability-loader'
import { CLI_DEFAULTS } from '../config'
import { detectPm, type PM } from '../utils/pm'
import { type PnpmWorkspace, readPnpmWorkspace, writePnpmWorkspace } from './pnpm'

export type WorkspaceTarget = 'pnpm'

type LoadWorkspaceInfo = (typeof import('@pluxel/rolldown/workspace/info'))['loadWorkspaceInfo']

export interface PnpmSource {
	path: string
	raw: string
	data: PnpmWorkspace
	patterns: string[]
}

export interface WorkspaceState {
	root: string
	packageManager: PM
	info: Awaited<ReturnType<LoadWorkspaceInfo>>
	pnpm?: PnpmSource
	effectivePatterns: string[]
}

export interface WorkspaceMutation {
	targets: WorkspaceTarget[]
	pattern: string
	action: 'add' | 'remove'
	changedTargets: WorkspaceTarget[]
}

export interface PatternInput {
	pattern: string
	hasGlob: boolean
}

export async function loadWorkspaceState(root: string): Promise<WorkspaceState> {
	const { loadWorkspaceInfo } = await loadOfficialCapability('rolldown-workspace-info')
	const absoluteRoot = normalize(resolve(root))
	const info = await loadWorkspaceInfo(absoluteRoot)
	const pnpmSource = readPnpmWorkspace(absoluteRoot)
	let pnpm: PnpmSource | undefined
	if (pnpmSource) {
		const current = Array.isArray(pnpmSource.data.packages) ? pnpmSource.data.packages : []
		pnpm = {
			path: pnpmSource.path,
			raw: pnpmSource.raw,
			data: pnpmSource.data,
			patterns: [...current],
		}
	}
	const effectivePatterns = pnpm?.patterns ?? []

	return {
		root: absoluteRoot,
		packageManager: await detectPm(absoluteRoot, CLI_DEFAULTS.packageManager.fallback),
		info,
		pnpm,
		effectivePatterns,
	}
}

export function addWorkspacePattern(root: string, input: string): Promise<WorkspaceMutation> {
	return mutateWorkspacePattern(root, input, 'add')
}

export function removeWorkspacePattern(root: string, input: string): Promise<WorkspaceMutation> {
	return mutateWorkspacePattern(root, input, 'remove')
}

async function mutateWorkspacePattern(
	root: string,
	input: string,
	action: WorkspaceMutation['action'],
) {
	const state = await loadWorkspaceState(root)
	const { pattern } = normalizePatternInput(state.root, input)
	const targets = resolveTargets(state)
	const changedTargets: WorkspaceTarget[] = []

	for (const target of targets) {
		if (target === 'pnpm' && state.pnpm) {
			const current = new Set(state.pnpm.patterns)
			const had = current.has(pattern)
			if (action === 'add' ? had : !had) continue
			if (action === 'add') current.add(pattern)
			else current.delete(pattern)
			const list = sortPatterns([...current])
			state.pnpm.data.packages = list
			writePnpmWorkspace(state.pnpm.path, state.pnpm.data)
			state.pnpm.patterns = list
			changedTargets.push('pnpm')
		}
	}

	return {
		targets,
		pattern,
		action,
		changedTargets,
	}
}

export function normalizePatternInput(root: string, input: string): PatternInput {
	const trimmed = input.trim()
	if (!trimmed) {
		throw new Error('Input cannot be empty')
	}
	const hasGlob = /[*?[\]]/.test(trimmed)
	const value = isAbsolute(trimmed) ? relative(root, trimmed) : trimmed
	let normalized = value.replaceAll('\\', '/')
	if (normalized.startsWith('./')) normalized = normalized.slice(2)
	if (!normalized) normalized = '.'
	const member = normalized.startsWith('!') ? normalized.slice(1) : normalized
	if (
		!member ||
		member.startsWith('/') ||
		member.split('/').includes('..') ||
		/[?[\]]/.test(member)
	) {
		throw new Error(
			`Unsupported workspace pattern ${JSON.stringify(input)}; expected a path inside ${root} using * or **`,
		)
	}
	return { pattern: normalized, hasGlob }
}

function resolveTargets(state: WorkspaceState): WorkspaceTarget[] {
	const targets: WorkspaceTarget[] = []
	if (state.pnpm) targets.push('pnpm')
	if (targets.length === 0) {
		throw new Error(
			`Cannot change workspace members without ${resolve(state.root, 'pnpm-workspace.yaml')}`,
		)
	}
	return targets
}

function sortPatterns(patterns: string[]) {
	return [...patterns].sort((a, b) => a.localeCompare(b))
}

export function ensureDirExists(root: string, pattern: string) {
	if (/[*?[\]]/.test(pattern)) return true
	const target = normalize(resolve(root, pattern))
	return existsSync(target)
}

export function resolveRelative(root: string, input: string) {
	const absolute = resolve(root, input)
	return relative(root, absolute).replaceAll('\\', '/')
}
