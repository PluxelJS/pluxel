import { existsSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve } from 'pathe'
import type { PackageJson } from 'pkg-types'
import { loadOfficialCapability } from '../capability-loader'
import { CLI_DEFAULTS } from '../config'
import { detectPm, type PM } from '../utils/pm'
import { manifestPathFor, readRawManifest, writeManifest } from './manifest'
import { type PnpmWorkspace, readPnpmWorkspace, writePnpmWorkspace } from './pnpm'

export type WorkspaceTarget = 'manifest' | 'pnpm'

type LoadWorkspaceInfo = (typeof import('@pluxel/rolldown/workspace/info'))['loadWorkspaceInfo']
type WorkspaceInfoModule = typeof import('@pluxel/rolldown/workspace/info')

type WorkspacesObject = Exclude<NonNullable<PackageJson['workspaces']>, string[]>

export interface ManifestSource {
	path: string
	raw: string
	data: PackageJson
	mode: 'array' | 'object' | null
	objectSource?: WorkspacesObject
	patterns: string[]
}

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
	manifest?: ManifestSource
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
	const { extractPackageWorkspaces, loadWorkspaceInfo } =
		await loadOfficialCapability<WorkspaceInfoModule>('rolldown-workspace-info')
	const absoluteRoot = normalize(resolve(root))
	const info = await loadWorkspaceInfo(absoluteRoot)
	const manifestPath = manifestPathFor(absoluteRoot)
	let manifest: ManifestSource | undefined
	if (manifestPath) {
		const { data, raw } = readRawManifest(manifestPath)
		const { mode, patterns, objectSource } = readManifestPatterns(data)
		manifest = {
			path: manifestPath,
			raw,
			data,
			mode,
			objectSource,
			patterns,
		}
	}
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
	const effectivePatterns = pnpm?.patterns.length
		? [...pnpm.patterns]
		: manifest?.patterns.length
			? [...manifest.patterns]
			: extractPackageWorkspaces(info.manifest)

	return {
		root: absoluteRoot,
		packageManager: await detectPm(absoluteRoot, CLI_DEFAULTS.packageManager.fallback),
		info,
		manifest,
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
		if (target === 'manifest' && state.manifest) {
			const current = new Set(state.manifest.patterns)
			const had = current.has(pattern)
			if (action === 'add' ? had : !had) continue
			if (action === 'add') current.add(pattern)
			else current.delete(pattern)
			const list = sortPatterns([...current])
			applyManifestPatterns(state.manifest, list)
			writeManifest(state.manifest.path, state.manifest.data, state.manifest.raw)
			state.manifest.patterns = list
			changedTargets.push('manifest')
		} else if (target === 'pnpm' && state.pnpm) {
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
	return { pattern: normalized, hasGlob }
}

function resolveTargets(state: WorkspaceState): WorkspaceTarget[] {
	const targets: WorkspaceTarget[] = []
	if (state.pnpm) targets.push('pnpm')
	if (state.manifest) targets.push('manifest')
	if (targets.length === 0) {
		throw new Error('No workspace configuration files found (package.json or pnpm-workspace.yaml)')
	}
	return targets
}

function readManifestPatterns(manifest: PackageJson) {
	const raw = manifest.workspaces
	if (!raw) {
		return {
			mode: null as const,
			patterns: [] as string[],
			objectSource: undefined as WorkspacesObject | undefined,
		}
	}
	if (Array.isArray(raw)) {
		return { mode: 'array' as const, patterns: [...raw], objectSource: undefined }
	}
	const objectSource: WorkspacesObject = { ...raw }
	const packages = Array.isArray(raw.packages) ? [...raw.packages] : []
	return { mode: 'object' as const, patterns: packages, objectSource }
}

function applyManifestPatterns(source: ManifestSource, patterns: string[]) {
	if (patterns.length === 0) {
		delete source.data.workspaces
		return
	}
	if (source.mode === 'array') {
		source.data.workspaces = [...patterns]
		return
	}

	const current = source.data.workspaces
	const base: WorkspacesObject =
		source.mode === 'object'
			? { ...source.objectSource }
			: current && !Array.isArray(current)
				? { ...current }
				: {}

	base.packages = [...patterns]
	source.data.workspaces = base
	source.mode = 'object'
	source.objectSource = base
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
