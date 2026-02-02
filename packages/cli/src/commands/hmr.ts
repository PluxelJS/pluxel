import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
	group,
	groupMultiselect,
	confirm,
	intro,
	isCancel,
	log,
	multiselect,
	note,
	outro,
	select,
	spinner,
	text,
} from '@clack/prompts'
import { type ArgValues, define } from 'gunshi'
import { resolve } from 'pathe'
import {
	backupAndRewriteHmrConfigV1,
	createDefaultHmrConfigV1,
	DEFAULT_HMR_CONFIG_BASENAME,
	readHmrConfigV1,
	writeHmrConfigV1,
} from '../hmr/config'
import { discoverPluginsFromPackages, scanWorkspacePackages } from '../hmr/discover'
import {
	buildWorkspaceSnapshotFromScan,
	diagnoseWorkspace,
	mergeHmrProfile,
	resolveHmrRootsExpanded,
} from '../hmr/diagnose'
import { uniqPreserveOrder } from '../hmr/utils'

const hmrCommandArgs = {
	root: {
		type: 'string',
		description: 'Workspace root',
		default: '.',
	},
	config: {
		type: 'string',
		description: `Config file path (default: ${DEFAULT_HMR_CONFIG_BASENAME})`,
		default: DEFAULT_HMR_CONFIG_BASENAME,
	},
	profile: {
		type: 'string',
		description: 'Profile name (overrides config.profile for this run)',
	},
	startCmd: {
		type: 'string',
		description:
			'Custom start command (runs in --root). When provided, replaces the default pluxel-hmr snapshot start.',
	},
} as const

type HmrArgs = typeof hmrCommandArgs
type HmrValues = ArgValues<HmrArgs>

function normalizePositionals(name: string | undefined, positionals: unknown) {
	if (!Array.isArray(positionals)) return []
	const list = positionals.map((v) => (v == null ? '' : String(v))).filter(Boolean)
	if (list.length && name && list[0] === name) return list.slice(1)
	return list
}

function resolvePluxelHmrBin(rootDir: string) {
	const base = resolve(rootDir, 'node_modules', '.bin')
	const candidates =
		process.platform === 'win32'
			? [
					resolve(base, 'pluxel-hmr.cmd'),
					resolve(base, 'pluxel-hmr.exe'),
					resolve(base, 'pluxel-hmr'),
				]
			: [resolve(base, 'pluxel-hmr')]
	for (const p of candidates) if (existsSync(p)) return p
	return 'pluxel-hmr'
}

async function spawnPluxelHmrStart(rootDir: string, snapshotJson: string) {
	const bin = resolvePluxelHmrBin(rootDir)
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(bin, ['start', '--snapshot-stdin'], {
			cwd: rootDir,
			stdio: ['pipe', 'inherit', 'inherit'],
			shell: process.platform === 'win32',
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`${bin} start failed (exit ${code ?? 'null'})`))
		})
		child.stdin?.write(snapshotJson)
		child.stdin?.end()
	})
}

async function spawnStartCommand(params: {
	rootDir: string
	command: string
	env: Record<string, string | undefined>
}) {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(params.command, [], {
			cwd: params.rootDir,
			stdio: 'inherit',
			shell: true,
			env: { ...process.env, ...params.env },
		})
		child.on('error', reject)
		child.on('exit', (code) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`start command failed (exit ${code ?? 'null'})`))
		})
	})
}

function formatList(items: string[], max = 60) {
	if (items.length <= max) return items.join('\n')
	const head = items.slice(0, max)
	return `${head.join('\n')}\n... (${items.length - max} more)`
}

function splitList(raw: string): string[] {
	return raw
		.split(/[\n,]/g)
		.map((s) => s.trim())
		.filter(Boolean)
}

function parseEnvList(raw: string | undefined): string[] {
	if (!raw) return []
	return splitList(raw)
}

function groupKeyForPkgDir(pkgDir: string) {
	const dir = pkgDir.replace(/\\/g, '/')
	if (!dir || dir === '.') return '.'
	const parts = dir.split('/').filter(Boolean)
	if (parts.length <= 1) return '.'
	return parts.slice(0, -1).join('/')
}

function buildFolderGroups(params: {
	discovered: Array<{ name: string; entry: string; pkgDir: string }>
	enabled: string[]
}) {
	const enabledSet = new Set(params.enabled)
	const byGroup = new Map<string, Array<{ name: string; entry: string; pkgDir: string }>>()
	for (const p of params.discovered) {
		const key = groupKeyForPkgDir(p.pkgDir)
		const list = byGroup.get(key)
		if (list) list.push(p)
		else byGroup.set(key, [p])
	}

	const keys = [...byGroup.keys()].sort((a, b) => a.localeCompare(b))
	const groups = keys.map((key) => {
		const items = (byGroup.get(key) ?? []).slice()
		const total = items.length
		const enabledCount = items.reduce((n, it) => n + (enabledSet.has(it.name) ? 1 : 0), 0)
		const label = key === '.' ? '(root)' : key
		return { key, label, total, enabledCount, items }
	})

	return groups
}

function buildFolderGroupedPluginOptions(params: {
	discovered: Array<{ name: string; entry: string; pkgDir: string }>
	enabled: string[]
}) {
	const enabledSet = new Set(params.enabled)
	const byGroup = new Map<string, Array<{ name: string; entry: string; pkgDir: string }>>()

	for (const p of params.discovered) {
		const key = groupKeyForPkgDir(p.pkgDir)
		const list = byGroup.get(key)
		if (list) list.push(p)
		else byGroup.set(key, [p])
	}

	const keys = [...byGroup.keys()].sort((a, b) => a.localeCompare(b))
	const out: Record<string, Array<{ value: string; label: string; hint: string }>> = {}

	for (const key of keys) {
		const items = (byGroup.get(key) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
		const enabledCount = items.reduce((n, it) => n + (enabledSet.has(it.name) ? 1 : 0), 0)
		const label = key === '.' ? `(root) (${enabledCount}/${items.length})` : `${key} (${enabledCount}/${items.length})`
		out[label] = items.map((p) => ({ value: p.name, label: p.name, hint: p.entry }))
	}

	return out
}

function resolveMissingEnabledPluginDeps(params: {
	packages: Array<{ name: string; deps: string[] }>
	discovered: Array<{ name: string }>
	enabled: string[]
	hidden?: Set<string>
}) {
	const depsByName = new Map(params.packages.map((p) => [p.name, p.deps]))
	const discoveredSet = new Set(params.discovered.map((p) => p.name))
	const enabledSet = new Set(params.enabled)
	const hidden = params.hidden ?? new Set<string>()

	const missing = new Set<string>()
	const missingHidden = new Set<string>()
	for (const name of params.enabled) {
		const deps = depsByName.get(name) ?? []
		for (const dep of deps) {
			if (!discoveredSet.has(dep)) continue
			if (enabledSet.has(dep)) continue
			if (hidden.has(dep)) missingHidden.add(dep)
			else missing.add(dep)
		}
	}
	return { missing: [...missing].sort(), missingHidden: [...missingHidden].sort() }
}

async function maybeAddDependencyPackagesToProfile(params: {
	enabled: string[]
	packages: Array<{ name: string; deps: string[] }>
	discovered: Array<{ name: string }>
	hidden?: Set<string>
}) {
	const enabled = uniqPreserveOrder(params.enabled)
	const { missing, missingHidden } = resolveMissingEnabledPluginDeps({
		packages: params.packages,
		discovered: params.discovered,
		enabled,
		hidden: params.hidden,
	})

	if (missingHidden.length) {
		note(
			`Some selected plugin packages depend on hidden plugin packages: ${missingHidden.join(', ')}.\n` +
				`Unhide them (PLUXEL_HMR_SKIP_PACKAGES) or add them to the profile if DI fails.`,
			'Dependency warning',
		)
	}

	if (!missing.length) return enabled
	const ok = await confirm({
		message: `Also add ${missing.length} dependency plugin package(s) to this profile?`,
		initialValue: true,
	})
	if (isCancel(ok) || !ok) return enabled
	return uniqPreserveOrder([...enabled, ...missing])
}

function ensureProfile(cfg: ReturnType<typeof readHmrConfigV1>, name: string) {
	if (!cfg.profiles[name]) cfg.profiles[name] = { enabled: [] }
}

function suggestProfileName(existing: string[], base = 'dev') {
	const set = new Set(existing)
	if (!set.has(base)) return base
	for (let i = 2; i < 1000; i++) {
		const next = `${base}${i}`
		if (!set.has(next)) return next
	}
	return `${base}-${Date.now()}`
}

function cloneProfileData(profile: any): any {
	if (!profile || typeof profile !== 'object') return { enabled: [] }
	const roots = profile.roots
	return {
		...(roots !== undefined
			? { roots: roots === 'auto' ? 'auto' : Array.isArray(roots) ? roots.slice() : roots }
			: {}),
		enabled: Array.isArray(profile.enabled) ? profile.enabled.slice() : [],
		...(Array.isArray(profile.include) ? { include: profile.include.slice() } : {}),
		...(Array.isArray(profile.exclude) ? { exclude: profile.exclude.slice() } : {}),
	}
}

async function scanWorkspaceForProfile(params: {
	rootDir: string
	cfg: ReturnType<typeof readHmrConfigV1>
	activeProfile: string
	env: Record<string, string | undefined>
	cache?: WorkspaceScanCache | null
}) {
	const merged = mergeHmrProfile(params.cfg, { ...params.env, PLUXEL_HMR_PROFILE: params.activeProfile })
	const rootsExpandedAbs = await resolveHmrRootsExpanded(params.rootDir, merged.roots)

	const key = `${rootsExpandedAbs.join('\n')}\n---\n${merged.excludeGlobs.join('\n')}`
	const prev = params.cache
	if (prev && prev.key === key) {
		return { merged, rootsExpandedAbs, packages: prev.packages, discovered: prev.discovered, cache: prev }
	}

	const sp = spinner()
	sp.start('Scanning workspace packages (package.json only)')
	const { packages } = await scanWorkspacePackages({
		rootDir: params.rootDir,
		roots: rootsExpandedAbs,
		excludeGlobs: merged.excludeGlobs,
	})
	const discovered = discoverPluginsFromPackages(params.rootDir, packages)
	sp.stop(`Discovered ${discovered.length} plugin package(s)`)

	const cache: WorkspaceScanCache = { key, rootsExpandedAbs, packages, discovered }
	return { merged, rootsExpandedAbs, packages, discovered, cache }
}

type WorkspaceScanCache = {
	key: string
	rootsExpandedAbs: string[]
	packages: Awaited<ReturnType<typeof scanWorkspacePackages>>['packages']
	discovered: ReturnType<typeof discoverPluginsFromPackages>
}

async function promptEditRoots(current: 'auto' | string[]) {
	const { mode, list } = await group(
		{
			mode: async () => {
				const pick = await select({
					message: 'Roots',
					initialValue: current === 'auto' ? 'auto' : 'custom',
					options: [
						{ label: 'auto (workspace packages)', value: 'auto' as const },
						{ label: 'custom (list)', value: 'custom' as const },
					],
				})
				return pick
			},
			list: async ({ results }) => {
				if (results.mode !== 'custom') return undefined
				const raw = await text({
					message: 'Custom roots (newline or comma separated)',
					placeholder: 'packages/plugins\npackages/tools',
					defaultValue: Array.isArray(current) ? current.join('\n') : '',
				})
				return raw
			},
		},
		{
			onCancel: () => {
				throw new Error('cancelled')
			},
		},
	)

	if (mode === 'auto') return 'auto' as const
	const roots = splitList(list ?? '')
	return roots.length ? uniqPreserveOrder(roots) : []
}

async function promptEditStringList(params: {
	message: string
	placeholder?: string
	current?: string[]
}) {
	const raw = await text({
		message: params.message,
		placeholder: params.placeholder,
		defaultValue: (params.current ?? []).join('\n'),
	})
	if (isCancel(raw)) throw new Error('cancelled')
	return uniqPreserveOrder(splitList(String(raw)))
}

async function promptPickProfile(cfg: ReturnType<typeof readHmrConfigV1>, initial?: string) {
	const keys = Object.keys(cfg.profiles)
	if (!keys.length) {
		cfg.profiles.dev = { enabled: [] }
		cfg.profile = 'dev'
		return 'dev'
	}
	const pick = await select({
		message: 'Select profile',
		initialValue: initial && keys.includes(initial) ? initial : cfg.profile,
		options: keys.sort((a, b) => a.localeCompare(b)).map((p) => ({ label: p, value: p })),
	})
	if (isCancel(pick)) throw new Error('cancelled')
	return String(pick)
}

async function promptManageProfiles(params: {
	cfg: ReturnType<typeof readHmrConfigV1>
	activeProfile: string
}): Promise<{ activeProfile: string; changed: boolean }> {
	let changed = false
	let active = params.activeProfile
	const cfg = params.cfg

	while (true) {
		const keys = Object.keys(cfg.profiles).sort((a, b) => a.localeCompare(b))
		if (!keys.length) {
			cfg.profiles.dev = { enabled: [] }
			cfg.profile = 'dev'
			active = 'dev'
			changed = true
		}

		const action = await select({
			message: 'Manage profiles',
			options: [
				{ label: `Switch (current: ${active})`, value: 'switch' as const },
				{ label: 'Create (clone current)', value: 'create' as const },
				{ label: 'Clone from…', value: 'clone' as const },
				{ label: 'Rename…', value: 'rename' as const },
				{ label: 'Delete…', value: 'delete' as const },
				{ label: 'Back', value: 'back' as const },
			],
		})
		if (isCancel(action) || action === 'back') return { activeProfile: active, changed }

		if (action === 'switch') {
			const next = await promptPickProfile(cfg, active)
			active = next
			cfg.profile = next
			changed = true
			continue
		}

		if (action === 'create') {
			const name = await text({
				message: 'New profile name',
				defaultValue: suggestProfileName(keys, active),
				validate: (v) => {
					const s = String(v ?? '').trim()
					if (!s) return 'Profile name is required'
					if (cfg.profiles[s]) return 'Profile already exists'
					return undefined
				},
			})
			if (isCancel(name)) return { activeProfile: active, changed }

			cfg.profiles[String(name)] = cloneProfileData(cfg.profiles[active])
			active = String(name)
			cfg.profile = active
			changed = true
			continue
		}

		if (action === 'clone') {
			const from = await promptPickProfile(cfg, active)
			const name = await text({
				message: `Clone "${from}" into…`,
				defaultValue: suggestProfileName(keys, from),
				validate: (v) => {
					const s = String(v ?? '').trim()
					if (!s) return 'Profile name is required'
					if (cfg.profiles[s]) return 'Profile already exists'
					return undefined
				},
			})
			if (isCancel(name)) return { activeProfile: active, changed }
			cfg.profiles[String(name)] = cloneProfileData(cfg.profiles[from])
			active = String(name)
			cfg.profile = active
			changed = true
			continue
		}

		if (action === 'rename') {
			const from = await promptPickProfile(cfg, active)
			const name = await text({
				message: `Rename "${from}" to…`,
				defaultValue: from,
				validate: (v) => {
					const s = String(v ?? '').trim()
					if (!s) return 'Profile name is required'
					if (s !== from && cfg.profiles[s]) return 'Profile already exists'
					return undefined
				},
			})
			if (isCancel(name)) return { activeProfile: active, changed }
			const to = String(name)
			if (to !== from) {
				cfg.profiles[to] = cfg.profiles[from]!
				delete cfg.profiles[from]
				if (cfg.profile === from) cfg.profile = to
				if (active === from) active = to
				changed = true
			}
			continue
		}

		if (action === 'delete') {
			if (Object.keys(cfg.profiles).length <= 1) {
				log.warn('Cannot delete the last profile.')
				continue
			}
			const target = await promptPickProfile(cfg, active)
			const ok = await confirm({ message: `Delete profile "${target}"?`, initialValue: false })
			if (isCancel(ok) || !ok) continue

			delete cfg.profiles[target]
			if (active === target) {
				const remaining = Object.keys(cfg.profiles).sort((a, b) => a.localeCompare(b))
				active = remaining[0]!
			}
			if (cfg.profile === target) cfg.profile = active
			changed = true
			continue
		}
	}
}

export const hmrCommand = define({
	name: 'hmr',
	description: 'HMR workspace profiles (prompt/start/doctor)',
	args: hmrCommandArgs,
	async run(ctx) {
		const values = ctx.values as HmrValues
		const [actionRaw] = normalizePositionals(ctx.name, ctx.positionals)
		const action = (actionRaw || 'prompt').toLowerCase()

		const rootDir = resolve(process.cwd(), values.root || '.')
		const configPath = resolve(rootDir, values.config || DEFAULT_HMR_CONFIG_BASENAME)
		const env = {
			...process.env,
			...(values.profile ? { PLUXEL_HMR_PROFILE: values.profile } : {}),
			...(values.startCmd ? { PLUXEL_HMR_START_CMD: values.startCmd } : {}),
		}
		const startCmd = env.PLUXEL_HMR_START_CMD
		const skipPackages = new Set(parseEnvList(env.PLUXEL_HMR_SKIP_PACKAGES))

		if (action === 'doctor') {
			intro('Pluxel HMR doctor')
			const sp = spinner()
			sp.start('Diagnosing workspace')
			const res = await diagnoseWorkspace({ rootDir, configPath, env })
			if (!res.ok) {
				sp.stop('Failed')
				note(res.errors.join('\n'), 'Errors')
				throw new Error('doctor failed')
			}
			sp.stop('OK')

			for (const w of res.warnings) note(w, 'Warning')

			const s = res.snapshot
			note(
				[
					`profile: ${s.activeProfile}`,
					`enabled: ${s.enabled.length}`,
					`discovered: ${s.discovered.length}`,
					`startup entries: ${s.enabledEntries.length} (+include ${s.includedEntries.length})`,
					`watch roots: ${s.watchRoots.length}`,
				].join('\n'),
				'Summary',
			)

			if (s.discovered.length) {
				note(formatList(s.discovered.map((p) => `${p.name} -> ${p.entry}`)), 'Discovered plugin packages')
			}
			if (s.includedEntries.length) {
				note(formatList(s.includedEntries), 'Resolved include entries')
			}

			outro('Done')
			return
		}

		if (action === 'start') {
			intro('Pluxel HMR start')
			const sp = spinner()
			sp.start('Diagnosing workspace')
			const res = await diagnoseWorkspace({ rootDir, configPath, env })
			if (!res.ok) {
				sp.stop('Failed')
				note(res.errors.join('\n'), 'Errors')
				throw new Error('start blocked')
			}
			sp.stop('OK')

			for (const w of res.warnings) note(w, 'Warning')
			const sp2 = spinner()
			sp2.start('Starting HMR')
			if (startCmd) {
				await spawnStartCommand({ rootDir, command: startCmd, env })
			} else {
				await spawnPluxelHmrStart(rootDir, JSON.stringify(res.snapshot))
			}
			sp2.stop('HMR exited')
			outro('Done')
			return
		}

		if (action !== 'prompt' && action !== 'interactive') {
			throw new Error(`Unknown action: ${action}`)
		}

		intro('Pluxel HMR')

		let cfg: ReturnType<typeof readHmrConfigV1> | null = null
		let parseError: unknown | null = null
		let dirty = false
		let setupMode: 'missing' | 'repaired' | null = null

		if (existsSync(configPath)) {
			try {
				cfg = readHmrConfigV1(configPath)
			} catch (error) {
				parseError = error
			}
		}

		if (!cfg && !existsSync(configPath)) {
			cfg = createDefaultHmrConfigV1()
			setupMode = 'missing'
			dirty = true
		}

		if (!cfg && parseError) {
			note(parseError instanceof Error ? parseError.message : String(parseError), 'Config parse failed')
			const ok = await confirm({ message: 'Backup and regenerate config?', initialValue: true })
			if (isCancel(ok) || !ok) {
				outro('Cancelled')
				return
			}
			const repaired = createDefaultHmrConfigV1()
			const { backupPath } = backupAndRewriteHmrConfigV1(configPath, repaired)
			note(`Backed up to ${backupPath}`, 'hmr config')
			cfg = repaired
			setupMode = 'repaired'
			dirty = true
		}
		if (!cfg) throw new Error('Failed to load hmr config')

		if (Object.keys(cfg.profiles).length === 0) {
			cfg.profiles.dev = { enabled: [] }
			cfg.profile = 'dev'
			dirty = true
		}

		let activeProfile = values.profile ?? env.PLUXEL_HMR_PROFILE ?? cfg.profile
		ensureProfile(cfg, activeProfile)

		// First-time setup: default to enable-all (fastest path).
		if (setupMode) {
			if (setupMode === 'missing') {
				const name = await text({
					message: 'Create initial profile',
					defaultValue: String(activeProfile || 'dev'),
					validate: (v) => {
						const s = String(v ?? '').trim()
						if (!s) return 'Profile name is required'
						return undefined
					},
				})
				if (isCancel(name)) {
					outro('Cancelled')
					return
				}
				activeProfile = String(name).trim()
				ensureProfile(cfg, activeProfile)
				cfg.profile = activeProfile
				dirty = true
			}

			note(
				setupMode === 'missing'
					? 'No config file found; running first-time setup.'
					: 'Config was regenerated; running setup.',
				'hmr',
			)

			const scan = await scanWorkspaceForProfile({ rootDir, cfg, activeProfile, env })
			const discoveredForUi = skipPackages.size
				? scan.discovered.filter((p) => !skipPackages.has(p.name))
				: scan.discovered
			const discoveredNames = discoveredForUi.map((p) => p.name)

			if (skipPackages.size) {
				note(`Hidden packages: ${[...skipPackages].join(', ')}`, 'PLUXEL_HMR_SKIP_PACKAGES')
			}

			const pluginsHostDemoDir = resolve(rootDir, 'packages/plugins/host/src/demo')
			const canPresetPluginsHost = existsSync(pluginsHostDemoDir)

			const setupPreset = await select({
				message: 'Initial setup',
				initialValue: 'all',
				options: [
					{ label: 'Enable all discovered plugin packages', value: 'all' as const },
					{ label: 'Enable by folder group(s)…', value: 'groups' as const },
					...(canPresetPluginsHost
						? [{ label: 'Preset: plugins-host demos', value: 'preset:plugins-host' as const }]
						: []),
					{ label: 'Start empty (enable later)', value: 'empty' as const },
				],
			})
			if (isCancel(setupPreset)) {
				outro('Cancelled')
				return
			}

			if (setupPreset === 'preset:plugins-host') {
				cfg.profile = activeProfile
				cfg.profiles[activeProfile] = {
					...(cfg.profiles[activeProfile] ?? { enabled: [] }),
					enabled: [],
					include: ['packages/plugins/host/src/demo/**/*.ts'],
					exclude: [
						'packages/plugins/host/src/demo/**/ui/**',
						'packages/plugins/host/src/demo/env.ts',
					],
				}
			} else {
				let initialEnabled: string[] = []
				if (setupPreset === 'all') initialEnabled = discoveredNames
				else if (setupPreset === 'groups') {
					const groups = buildFolderGroups({ discovered: scan.discovered, enabled: [] })
					const defaultGroups = groups.some((g) => g.key === 'chatbots') ? ['chatbots'] : []
					const picked = await multiselect({
						message: 'Pick folder groups to enable (fast path)',
						options: groups.map((g) => ({
							value: g.key,
							label: `${g.label} (${g.total})`,
						})),
						initialValues: defaultGroups,
					})
					if (isCancel(picked)) {
						outro('Cancelled')
						return
					}
					const pickedSet = new Set((picked as string[]).map(String))
					initialEnabled = scan.discovered
						.filter((p) => pickedSet.has(groupKeyForPkgDir(p.pkgDir)))
						.map((p) => p.name)
				}

				const options = buildFolderGroupedPluginOptions({ discovered: discoveredForUi, enabled: initialEnabled })
				const enabledPickRaw = await groupMultiselect({
					message:
						'Profile plugin packages (selected entries; group by folder; toggle groups to batch add/remove)',
					options,
					initialValues: initialEnabled,
					selectableGroups: true,
				})
				if (isCancel(enabledPickRaw)) {
					outro('Cancelled')
					return
				}

				const enabledFinal = await maybeAddDependencyPackagesToProfile({
					enabled: (enabledPickRaw as string[]).slice(),
					packages: scan.packages.map((p) => ({ name: p.name, deps: p.deps })),
					discovered: scan.discovered,
					hidden: skipPackages,
				})

				const include = await promptEditStringList({
					message: 'Extra include entry globs (optional; newline or comma separated)',
					placeholder: 'packages/plugins/host/src/demo/PluginEventsDemo.ts',
					current: cfg.profiles[activeProfile]?.include ?? [],
				}).catch(() => null)

				cfg.profile = activeProfile
				cfg.profiles[activeProfile] = {
					...(cfg.profiles[activeProfile] ?? { enabled: [] }),
					enabled: enabledFinal,
					...(include && include.length ? { include } : {}),
				}
			}
			dirty = true

			writeHmrConfigV1(configPath, cfg)
			note(
				setupMode === 'missing' ? `Created ${configPath}` : `Rewrote ${configPath}`,
				'hmr config',
			)

			const res = await buildWorkspaceSnapshotFromScan({
				rootDir,
				merged: mergeHmrProfile(cfg, { ...env, PLUXEL_HMR_PROFILE: activeProfile }),
				rootsExpandedAbs: scan.rootsExpandedAbs,
				packages: scan.packages.map((p) => ({ name: p.name, deps: p.deps, pkgDirAbs: p.pkgDirAbs })),
				discovered: scan.discovered,
			})
			if (!res.ok) {
				note(res.errors.join('\n'), 'Errors')
				outro('Config saved, but start is blocked')
				return
			}

			for (const w of res.warnings) note(w, 'Warning')
			const startOk = await confirm({ message: 'Start HMR now?', initialValue: true })
			if (isCancel(startOk) || !startOk) {
				outro('Done')
				return
			}
			if (startCmd) {
				await spawnStartCommand({ rootDir, command: startCmd, env })
			} else {
				await spawnPluxelHmrStart(rootDir, JSON.stringify(res.snapshot))
			}
			outro('HMR exited')
			return
		}

		let scanCache: WorkspaceScanCache | null = null

		while (true) {
			const scan = await scanWorkspaceForProfile({ rootDir, cfg, activeProfile, env, cache: scanCache })
			scanCache = scan.cache
			const currentProfile = cfg.profiles[activeProfile] ?? { enabled: [] }
			const discoveredForUi = skipPackages.size
				? scan.discovered.filter((p) => !skipPackages.has(p.name))
				: scan.discovered
			const rootsLabel =
				scan.merged.roots === 'auto'
					? 'auto'
					: scan.merged.roots.length
						? `custom(${scan.merged.roots.length})`
						: 'custom(0)'

			note(
				[
					`profile: ${activeProfile}`,
					`discovered: ${scan.discovered.length}`,
					`profile packages: ${currentProfile.enabled.length}`,
					`include: ${scan.merged.includeGlobs.length}`,
					`exclude: ${scan.merged.excludeGlobs.length}`,
					`roots: ${rootsLabel}`,
				].join('\n'),
				'Status',
			)

			const pluginsHostDemoDir = resolve(rootDir, 'packages/plugins/host/src/demo')
			const canPresetPluginsHost = existsSync(pluginsHostDemoDir)

			const actionPick = await select({
				message: 'Next action',
				initialValue: 'start',
				options: [
					{ label: 'Start HMR', value: 'start' as const },
					{ label: 'Doctor (show discovery + validation)', value: 'doctor' as const },
					...(canPresetPluginsHost
						? [{ label: 'Apply preset: plugins-host demos', value: 'preset:plugins-host' as const }]
						: []),
					{ label: 'Edit profile packages (folder groups)', value: 'enabled' as const },
					{ label: 'Edit include globs', value: 'include' as const },
					{ label: 'Edit exclude globs', value: 'exclude' as const },
					{ label: 'Edit roots', value: 'roots' as const },
					{ label: 'Switch profile', value: 'switch' as const },
					{ label: 'Manage profiles…', value: 'profiles' as const },
					{ label: `Write config (${dirty ? 'dirty' : 'clean'})`, value: 'write' as const },
					{ label: 'Exit', value: 'exit' as const },
				],
			})
			if (isCancel(actionPick) || actionPick === 'exit') {
				outro('Done')
				return
			}

			if (actionPick === 'preset:plugins-host') {
				cfg.profiles[activeProfile] = {
					...currentProfile,
					enabled: [],
					include: ['packages/plugins/host/src/demo/**/*.ts'],
					exclude: [
						'packages/plugins/host/src/demo/**/ui/**',
						'packages/plugins/host/src/demo/env.ts',
					],
				}

				dirty = true
				scanCache = null
				log.success('Applied preset for plugins-host demos.')
				continue
			}

			if (actionPick === 'write') {
				if (!dirty) {
					log.info('No changes to write.')
					continue
				}
				const ok = await confirm({ message: `Write ${configPath}?`, initialValue: true })
				if (isCancel(ok) || !ok) continue
				writeHmrConfigV1(configPath, cfg)
				dirty = false
				log.success('Config written.')
				continue
			}

			if (actionPick === 'profiles') {
				const res = await promptManageProfiles({ cfg, activeProfile })
				activeProfile = res.activeProfile
				dirty = dirty || res.changed
				scanCache = null
				continue
			}

			if (actionPick === 'switch') {
				activeProfile = await promptPickProfile(cfg, activeProfile)
				ensureProfile(cfg, activeProfile)
				cfg.profile = activeProfile
				dirty = true
				scanCache = null
				continue
			}

			if (actionPick === 'enabled') {
				const discoveredNames = new Set(discoveredForUi.map((p) => p.name))
				const currentEnabled = (currentProfile.enabled ?? []).filter((n) => discoveredNames.has(n))
				const options = buildFolderGroupedPluginOptions({ discovered: discoveredForUi, enabled: currentEnabled })
				const pick = await groupMultiselect({
					message:
						'Profile plugin packages (selected entries; group by folder; toggle groups to batch add/remove)',
					options,
					initialValues: currentEnabled,
					selectableGroups: true,
				})
				if (isCancel(pick)) continue

				const nextEnabled = await maybeAddDependencyPackagesToProfile({
					enabled: (pick as string[]).slice(),
					packages: scan.packages.map((p) => ({ name: p.name, deps: p.deps })),
					discovered: scan.discovered,
					hidden: skipPackages,
				})
				cfg.profiles[activeProfile] = { ...currentProfile, enabled: nextEnabled }
				dirty = true
				continue
			}

			if (actionPick === 'include') {
				const scope = await select({
					message: 'Edit include globs in…',
					options: [
						{ label: `profile: ${activeProfile}`, value: 'profile' as const },
						{ label: 'defaults (applies to all profiles)', value: 'defaults' as const },
					],
				})
				if (isCancel(scope)) continue
				if (scope === 'defaults') {
					const next = await promptEditStringList({
						message: 'defaults.include (optional)',
						placeholder: 'packages/plugins/host/src/demo/PluginEventsDemo.ts',
						current: cfg.defaults?.include ?? [],
					}).catch(() => null)
					if (next) {
						cfg.defaults = { ...(cfg.defaults ?? {}), ...(next.length ? { include: next } : {}) }
						if (!next.length && cfg.defaults) delete (cfg.defaults as any).include
						dirty = true
					}
				} else {
					const next = await promptEditStringList({
						message: `${activeProfile}.include (optional)`,
						placeholder: 'packages/plugins/host/src/demo/PluginEventsDemo.ts',
						current: currentProfile.include ?? [],
					}).catch(() => null)
					if (next) {
						cfg.profiles[activeProfile] = { ...currentProfile, ...(next.length ? { include: next } : {}) }
						if (!next.length) delete (cfg.profiles[activeProfile] as any).include
						dirty = true
					}
				}
				continue
			}

			if (actionPick === 'exclude') {
				const scope = await select({
					message: 'Edit exclude globs in…',
					options: [
						{ label: `profile: ${activeProfile}`, value: 'profile' as const },
						{ label: 'defaults (applies to all profiles)', value: 'defaults' as const },
					],
				})
				if (isCancel(scope)) continue
				if (scope === 'defaults') {
					const next = await promptEditStringList({
						message: 'defaults.exclude (optional)',
						placeholder: '**/node_modules/**\n**/dist/**',
						current: cfg.defaults?.exclude ?? [],
					}).catch(() => null)
					if (next) {
						cfg.defaults = { ...(cfg.defaults ?? {}), ...(next.length ? { exclude: next } : {}) }
						if (!next.length && cfg.defaults) delete (cfg.defaults as any).exclude
						dirty = true
						scanCache = null
					}
				} else {
					const next = await promptEditStringList({
						message: `${activeProfile}.exclude (optional)`,
						placeholder: '**/node_modules/**\n**/dist/**',
						current: currentProfile.exclude ?? [],
					}).catch(() => null)
					if (next) {
						cfg.profiles[activeProfile] = { ...currentProfile, ...(next.length ? { exclude: next } : {}) }
						if (!next.length) delete (cfg.profiles[activeProfile] as any).exclude
						dirty = true
						scanCache = null
					}
				}
				continue
			}

			if (actionPick === 'roots') {
				const scope = await select({
					message: 'Edit roots in…',
					options: [
						{ label: `profile: ${activeProfile}`, value: 'profile' as const },
						{ label: 'defaults (applies to all profiles)', value: 'defaults' as const },
					],
				})
				if (isCancel(scope)) continue
				if (scope === 'defaults') {
					const next = await promptEditRoots(cfg.defaults?.roots ?? 'auto').catch(() => null)
					if (next) {
						cfg.defaults = { ...(cfg.defaults ?? {}), roots: next }
						dirty = true
						scanCache = null
					}
				} else {
					const base = currentProfile.roots ?? cfg.defaults?.roots ?? 'auto'
					const next = await promptEditRoots(base).catch(() => null)
					if (next) {
						cfg.profiles[activeProfile] = { ...currentProfile, roots: next }
						dirty = true
						scanCache = null
					}
				}
				continue
			}

			if (actionPick === 'doctor') {
				const sp = spinner()
				sp.start('Diagnosing workspace')
				const res = await diagnoseWorkspace({ rootDir, configPath, env: { ...env, PLUXEL_HMR_PROFILE: activeProfile } })
				if (!res.ok) {
					sp.stop('Failed')
					note(res.errors.join('\n'), 'Errors')
				} else {
					sp.stop('OK')
					for (const w of res.warnings) note(w, 'Warning')
					note(
						[
							`profile: ${res.snapshot.activeProfile}`,
							`enabled: ${res.snapshot.enabled.length}`,
							`discovered: ${res.snapshot.discovered.length}`,
							`startup entries: ${res.snapshot.enabledEntries.length} (+include ${res.snapshot.includedEntries.length})`,
							`watch roots: ${res.snapshot.watchRoots.length}`,
						].join('\n'),
						'Summary',
					)
					if (res.snapshot.discovered.length) {
						note(
							formatList(res.snapshot.discovered.map((p) => `${p.name} -> ${p.entry}`)),
							'Discovered plugin packages',
						)
					}
					if (res.snapshot.includedEntries.length) {
						note(formatList(res.snapshot.includedEntries), 'Resolved include entries')
					}
				}
				continue
			}

			if (actionPick === 'start') {
				if (dirty) {
					const ok = await confirm({ message: `Write ${configPath} before start?`, initialValue: true })
					if (!isCancel(ok) && ok) {
						writeHmrConfigV1(configPath, cfg)
						dirty = false
					}
				}

				const res = await buildWorkspaceSnapshotFromScan({
					rootDir,
					merged: mergeHmrProfile(cfg, { ...env, PLUXEL_HMR_PROFILE: activeProfile }),
					rootsExpandedAbs: scan.rootsExpandedAbs,
					packages: scan.packages.map((p) => ({ name: p.name, deps: p.deps, pkgDirAbs: p.pkgDirAbs })),
					discovered: scan.discovered,
				})
				if (!res.ok) {
					note(res.errors.join('\n'), 'Errors')
					continue
				}
				for (const w of res.warnings) note(w, 'Warning')
				const sp2 = spinner()
				sp2.start('Starting HMR')
				if (startCmd) {
					await spawnStartCommand({ rootDir, command: startCmd, env })
				} else {
					await spawnPluxelHmrStart(rootDir, JSON.stringify(res.snapshot))
				}
				sp2.stop('HMR exited')
				outro('Done')
				return
			}
		}
	},
})
