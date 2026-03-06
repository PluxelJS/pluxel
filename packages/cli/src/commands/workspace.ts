import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { intro, isCancel, multiselect, note, outro } from '@clack/prompts'
import { type ArgValues, define } from 'gunshi'
import { basename, dirname, relative, resolve } from 'pathe'
import type picomatchModule from 'picomatch'
import picomatch from 'picomatch'
import { detectPm, runPackageManager } from '../utils/pm'
import type { WorkspaceCandidate } from '../workspace/candidates'
import { readWorkspaceCandidates, upsertWorkspaceCandidates } from '../workspace/candidates'
import { scanWorkspaceDirs } from '../workspace/scanner'
import {
	addWorkspacePattern,
	loadWorkspaceState,
	removeWorkspacePattern,
	resolveRelative,
} from '../workspace/state'

const workspaceRootArgs = {
	root: {
		type: 'string',
		description: 'Workspace root',
		default: '.',
	},
} as const

const workspacePatternArgs = {
	...workspaceRootArgs,
	pattern: {
		type: 'positional',
		description: 'Workspace pattern or folder to mutate',
	},
} as const

const workspacePullArgs = {
	...workspaceRootArgs,
	repo: {
		type: 'positional',
		description: 'Git URL to clone',
	},
	dir: {
		type: 'string',
		description: 'Destination base dir for pull (relative to root)',
		default: 'packages',
	},
	name: {
		type: 'string',
		description: 'Folder name for pull (auto from repo name by default)',
	},
	ref: {
		type: 'string',
		description: 'Git ref/branch for pull',
	},
	force: {
		type: 'boolean',
		description: 'Overwrite existing folder for pull',
		default: false,
	},
} as const

const workspaceScanArgs = {
	...workspaceRootArgs,
	base: {
		type: 'positional',
		description: 'Base directory to scan (relative to root)',
	},
} as const

type WorkspaceRootArgs = typeof workspaceRootArgs
type WorkspaceRootValues = ArgValues<WorkspaceRootArgs>
type WorkspacePatternArgs = typeof workspacePatternArgs
type WorkspacePatternValues = ArgValues<WorkspacePatternArgs>
type WorkspacePullArgs = typeof workspacePullArgs
type WorkspacePullValues = ArgValues<WorkspacePullArgs>
type WorkspaceScanArgs = typeof workspaceScanArgs
type WorkspaceScanValues = ArgValues<WorkspaceScanArgs>

function resolveWorkspaceRoot(values: WorkspaceRootValues) {
	return resolve(process.cwd(), values.root || '.')
}

const workspacePromptCommand = define({
	name: 'prompt',
	description: 'Interactive workspace toggler',
	toKebab: true,
	args: workspaceRootArgs,
	async run(ctx) {
		await handleInteractive(resolveWorkspaceRoot(ctx.values as WorkspaceRootValues), ctx.log)
	},
})

const workspaceListCommand = define({
	name: 'list',
	description: 'List active workspace patterns and detected packages',
	toKebab: true,
	args: workspaceRootArgs,
	async run(ctx) {
		await handleList(resolveWorkspaceRoot(ctx.values as WorkspaceRootValues), ctx.log)
	},
})

const workspaceAddCommand = define({
	name: 'add',
	description: 'Add/enable a workspace pattern',
	toKebab: true,
	args: workspacePatternArgs,
	async run(ctx) {
		const values = ctx.values as WorkspacePatternValues
		const workspaceRoot = resolveWorkspaceRoot(values)
		const pattern = values.pattern
		if (!pattern) throw new Error('Please provide a pattern or folder to add')
		const mutation = await addWorkspacePattern(workspaceRoot, pattern)
		reportMutation(ctx.log, workspaceRoot, mutation)
		if (mutation.changedTargets.length > 0) {
			await installWorkspaceDeps(workspaceRoot, ctx.log)
		}
	},
})

const workspaceRemoveCommand = define({
	name: 'remove',
	description: 'Remove/disable a workspace pattern',
	toKebab: true,
	args: workspacePatternArgs,
	async run(ctx) {
		const values = ctx.values as WorkspacePatternValues
		const workspaceRoot = resolveWorkspaceRoot(values)
		const pattern = values.pattern
		if (!pattern) throw new Error('Please provide a pattern or folder to remove')
		const mutation = await removeWorkspacePattern(workspaceRoot, pattern)
		reportMutation(ctx.log, workspaceRoot, mutation)
		if (mutation.changedTargets.length > 0) {
			await installWorkspaceDeps(workspaceRoot, ctx.log)
		}
	},
})

const workspacePullCommand = define({
	name: 'pull',
	description: 'Clone a repository and add it to workspace patterns',
	toKebab: true,
	args: workspacePullArgs,
	async run(ctx) {
		const values = ctx.values as WorkspacePullValues
		const workspaceRoot = resolveWorkspaceRoot(values)
		const repo = values.repo
		if (!repo) throw new Error('Please provide a git url for pull')
		const dir = values.dir || 'packages'
		const name = values.name || inferName(repo)
		const targetDir = resolve(workspaceRoot, dir, name)
		if (existsSync(targetDir) && !values.force) {
			throw new Error(`Target exists: ${targetDir}\nUse --force to overwrite.`)
		}
		await gitClone(repo, targetDir, values.ref)
		ctx.log(`Cloned into ${targetDir}`)
		const pattern = resolveRelative(workspaceRoot, targetDir)
		const mutation = await addWorkspacePattern(workspaceRoot, pattern)
		reportMutation(ctx.log, workspaceRoot, mutation)
		if (mutation.changedTargets.length > 0) {
			await installWorkspaceDeps(workspaceRoot, ctx.log)
		}
	},
})

const workspaceScanCommand = define({
	name: 'scan',
	description: 'Scan directories and refresh workspace candidate cache',
	toKebab: true,
	args: workspaceScanArgs,
	async run(ctx) {
		const values = ctx.values as WorkspaceScanValues
		const workspaceRoot = resolveWorkspaceRoot(values)
		const base = values.base || '.'
		const existing = readWorkspaceCandidates(workspaceRoot)
		const paths = await scanWorkspaceDirs(workspaceRoot, base)
		const updated = upsertWorkspaceCandidates(workspaceRoot, paths, existing, 'scan')
		ctx.log(`Recorded ${paths.length} candidate(s). Total tracked: ${updated.entries.length}.`)
	},
})

export const workspaceCommand = define({
	name: 'workspace',
	description: 'Manage workspaces (pnpm / yarn)',
	toKebab: true,
	args: workspaceRootArgs,
	subCommands: new Map([
		['prompt', workspacePromptCommand],
		['list', workspaceListCommand],
		['add', workspaceAddCommand],
		['remove', workspaceRemoveCommand],
		['pull', workspacePullCommand],
		['scan', workspaceScanCommand],
	]),
	async run(ctx) {
		await handleInteractive(resolveWorkspaceRoot(ctx.values as WorkspaceRootValues), ctx.log)
	},
})

async function handleInteractive(root: string, log: (...args: unknown[]) => void) {
	let store = readWorkspaceCandidates(root)
	if (!store || store.entries.length === 0) {
		const scanned = await scanWorkspaceDirs(root)
		store = upsertWorkspaceCandidates(root, scanned, store, 'auto')
		note(`Auto-detected ${scanned.length} candidate(s).`, 'Workspace scan')
	}
	if (!store || store.entries.length === 0) {
		log('No workspace candidates recorded. Run `pluxel workspace scan`.')
		return
	}
	const state = await loadWorkspaceState(root)
	const patternSet = new Set(state.effectivePatterns)
	const matchers = createGlobMatchers(state.effectivePatterns)
	const optionDetails = buildCandidateOptions(store.entries)
	const details = optionDetails.map((detail) => describeOption(detail, root, patternSet, matchers))

	const options = details.map((detail) => ({
		value: detail.value,
		label: detail.label,
		hint: detail.hintParts.length > 0 ? detail.hintParts.join(' · ') : undefined,
	}))
	const initialValues = details.filter((detail) => detail.enabled).map((detail) => detail.value)

	intro('Workspace manager')
	const selection = await multiselect({
		message: 'Select workspaces to enable',
		required: false,
		initialValues,
		options,
	})
	if (isCancel(selection)) {
		outro('Cancelled.')
		return
	}
	const chosen = new Set(selection as string[])
	const result = { added: [] as string[], removed: [] as string[] }

	for (const detail of details) {
		const currentlyEnabled = detail.enabled
		const shouldEnable = chosen.has(detail.value)
		if (shouldEnable && !currentlyEnabled) {
			const mutation = await addWorkspacePattern(root, detail.value)
			if (mutation.changedTargets.length > 0) {
				result.added.push(detail.value)
			}
		} else if (!shouldEnable && currentlyEnabled) {
			const mutation = await removeWorkspacePattern(root, detail.value)
			if (mutation.changedTargets.length > 0) {
				result.removed.push(detail.value)
			}
		}
	}

	const changed = result.added.length > 0 || result.removed.length > 0
	const summary = [
		result.added.length ? `enabled: ${result.added.join(', ')}` : '',
		result.removed.length ? `disabled: ${result.removed.join(', ')}` : '',
	]
		.filter(Boolean)
		.join('\n')
	if (changed) {
		await installWorkspaceDeps(root, log)
	}
	outro(summary || 'No changes.')
}

async function handleList(root: string, log: (...args: unknown[]) => void) {
	const state = await loadWorkspaceState(root)
	log(`workspace root: ${state.root}`)
	log(`package manager: ${state.packageManager}`)
	const sources: string[] = []
	if (state.manifest) sources.push(state.manifest.path)
	if (state.pnpm) sources.push(state.pnpm.path)
	log(`config files: ${sources.length ? sources.join(', ') : 'none (using defaults)'}`)
	log('patterns:')
	for (const p of state.effectivePatterns) {
		log(`  - ${p}`)
	}
	if (state.info.packageDirs.length) {
		log('packages:')
		for (const dir of state.info.packageDirs) {
			log(`  • ${relative(root, dir)}`)
		}
	} else {
		log('packages: (none detected)')
	}
}

function reportMutation(
	log: (...args: unknown[]) => void,
	root: string,
	mutation: Awaited<ReturnType<typeof addWorkspacePattern>>,
) {
	if (mutation.changedTargets.length === 0) {
		log(`No changes (${mutation.action} kept existing state).`)
		return
	}
	const rel = resolveRelative(root, mutation.pattern)
	log(`${mutation.action} ${rel} in: ${mutation.changedTargets.join(', ')}`)
}

async function installWorkspaceDeps(root: string, log: (...args: unknown[]) => void) {
	const pm = await detectPm(root)
	log(`\n→ Running ${pm} install to sync workspaces...`)
	await runPackageManager(pm, ['install'], root)
}

function inferName(repo: string) {
	const clean = repo.replace(/\/+$/, '')
	const base = basename(clean)
	const name = base.endsWith('.git') ? base.slice(0, -4) : base
	return name || 'workspace'
}

async function gitClone(repo: string, targetDir: string, ref?: string) {
	const args = ['clone', '--depth=1']
	if (ref) args.push('--branch', ref)
	args.push(repo, targetDir)
	await run('git', args, dirname(targetDir))
}

function run(cmd: string, args: string[], cwd: string) {
	return new Promise<void>((resolvePromise, reject) => {
		const child = spawn(cmd, args, {
			stdio: 'inherit',
			cwd,
			shell: process.platform === 'win32',
		})
		child.on('exit', (code) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`${cmd} ${args.join(' ')} failed`))
		})
	})
}

function containsGlob(input: string) {
	return /[*?[\]]/.test(input)
}

type GlobMatcher = {
	pattern: string
	match: picomatchModule.Matcher
}

function createGlobMatchers(patterns: string[]): GlobMatcher[] {
	return patterns.filter(containsGlob).map((pattern) => ({
		pattern,
		match: picomatch(pattern, { dot: true }),
	}))
}

interface CandidateOptionDetail {
	value: string
	label: string
	type: 'group' | 'single'
	prefix?: string
	paths: string[]
	sources: string[]
}

interface ResolvedOptionDetail extends CandidateOptionDetail {
	enabled: boolean
	hintParts: string[]
}

function buildCandidateOptions(entries: WorkspaceCandidate[]): CandidateOptionDetail[] {
	const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
	const groups = new Map<string, WorkspaceCandidate[]>()
	const singles: WorkspaceCandidate[] = []

	for (const entry of sorted) {
		const path = entry.path
		const divider = path.lastIndexOf('/')
		if (divider === -1) {
			singles.push(entry)
			continue
		}
		const parent = path.slice(0, divider)
		if (!parent) {
			singles.push(entry)
			continue
		}
		if (!groups.has(parent)) groups.set(parent, [])
		groups.get(parent)!.push(entry)
	}

	const details: CandidateOptionDetail[] = []

	for (const entry of singles) {
		details.push({
			value: entry.path,
			label: entry.path,
			type: 'single',
			paths: [entry.path],
			sources: entry.source && entry.source !== 'auto' ? [entry.source] : [],
		})
	}

	for (const [prefix, entriesInGroup] of groups) {
		if (entriesInGroup.length <= 1) {
			const entry = entriesInGroup[0]
			if (!entry) continue
			details.push({
				value: entry.path,
				label: entry.path,
				type: 'single',
				paths: [entry.path],
				sources: entry.source && entry.source !== 'auto' ? [entry.source] : [],
			})
			continue
		}
		details.push({
			value: `${prefix}/*`,
			label: `${prefix}/*`,
			type: 'group',
			prefix,
			paths: entriesInGroup.map((entry) => entry.path),
			sources: collectSources(entriesInGroup),
		})
	}

	return details.sort((a, b) => a.label.localeCompare(b.label))
}

function describeOption(
	detail: CandidateOptionDetail,
	root: string,
	patterns: Set<string>,
	matchers: GlobMatcher[],
): ResolvedOptionDetail {
	const hintParts: string[] = []
	if (detail.type === 'group') {
		const children = collectGroupChildren(detail)
		if (children.length > 0) hintParts.push(children.join(', '))
	}
	const missing = detail.paths.every((path) => !existsSync(resolve(root, path)))
	if (missing) hintParts.push('missing')

	const direct = patterns.has(detail.value)
	const matchedGlob = direct ? undefined : findMatchingPattern(detail.paths, matchers)
	if (!direct && matchedGlob) {
		hintParts.push(`via ${matchedGlob}`)
	}
	for (const source of detail.sources) {
		if (source) hintParts.push(source)
	}

	const enabled = direct || Boolean(matchedGlob)
	return {
		...detail,
		enabled,
		hintParts,
	}
}

function collectSources(entries: WorkspaceCandidate[]) {
	const seen = new Set<string>()
	for (const entry of entries) {
		if (entry.source && entry.source !== 'auto') {
			seen.add(entry.source)
		}
	}
	return [...seen]
}

function findMatchingPattern(paths: string[], matchers: GlobMatcher[]) {
	for (const matcher of matchers) {
		for (const path of paths) {
			if (matcher.match(path)) {
				return matcher.pattern
			}
		}
	}
	return undefined
}

function collectGroupChildren(detail: CandidateOptionDetail) {
	if (detail.type !== 'group') return []
	const prefix = detail.prefix ?? ''
	const start = prefix ? prefix.length + 1 : 0
	return detail.paths.map((path) => path.slice(start))
}
