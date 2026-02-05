import { existsSync } from 'node:fs'
import { Box, render, Text, useInput, useStdout } from 'ink'
import { resolve } from 'pathe'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	backupAndRewriteHmrConfigV1,
	createDefaultHmrConfigV1,
	type PluxelHmrConfigV1,
	readHmrConfigV1,
	writeHmrConfigV1,
} from '../hmr/config'
import {
	buildWorkspaceSnapshotFromScan,
	mergeHmrProfile,
	resolveHmrRootsExpanded,
	type WorkspaceSnapshot,
} from '../hmr/diagnose'
import { discoverPluginsFromPackages, scanWorkspacePackages } from '../hmr/discover'
import { writeHmrDiscoveredIndex } from '../hmr/discovered-index'
import { uniqPreserveOrder, uniqSorted } from '../hmr/utils'
import { type PickPackagesDiscoveredPlugin, PickPackagesDualBrowser } from './pick-packages'

type TabKey =
	| 'packages'
	| 'start'
	| 'doctor'
	| 'roots'
	| 'include'
	| 'exclude'
	| 'profiles'
	| 'help'

type PromptResult = { action: 'exit' } | { action: 'start'; snapshotJson: string }

type ConfigScope = 'profile' | 'defaults'

function clamp(n: number, min: number, max: number) {
	return Math.max(min, Math.min(max, n))
}

type InitialOpen =
	| { kind: 'packages'; mode?: 'enabled' | 'builtin' }
	| { kind: 'profiles' }
	| { kind: 'editList'; target: 'roots' | 'include' | 'exclude' }

function formatListInline(items: string[], max = 6) {
	if (!items.length) return '(none)'
	const head = items.slice(0, max)
	const rest = items.length - head.length
	return rest > 0 ? `${head.join(', ')}, +${rest}` : head.join(', ')
}

function tabLabel(tab: TabKey) {
	switch (tab) {
		case 'packages':
			return 'Packages'
		case 'start':
			return 'Start'
		case 'doctor':
			return 'Doctor'
		case 'roots':
			return 'Roots'
		case 'include':
			return 'Include'
		case 'exclude':
			return 'Exclude'
		case 'profiles':
			return 'Profiles'
		case 'help':
			return 'Help'
	}
}

function tabs(): TabKey[] {
	return ['packages', 'start', 'doctor', 'roots', 'include', 'exclude', 'profiles', 'help']
}

type Modal =
	| null
	| {
			kind: 'confirm'
			title: string
			message: string
			confirmLabel: string
			cancelLabel: string
			onConfirm: () => void
			onCancel: () => void
	  }
	| {
			kind: 'input'
			title: string
			message: string
			placeholder?: string
			initial?: string
			validate?: (value: string) => string | null
			onSubmit: (value: string) => void
			onCancel: () => void
	  }

function ModalOverlay(props: { modal: Exclude<Modal, null> }) {
	const { stdout } = useStdout()
	const rows = stdout?.rows ?? 24
	const height = Math.max(Math.min(rows - 4, 12), 6)

	const [value, setValue] = useState(
		props.modal.kind === 'input' ? (props.modal.initial ?? '') : '',
	)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (props.modal.kind === 'input') {
			setValue(props.modal.initial ?? '')
			setError(null)
		}
	}, [props.modal])

	useInput((input, key) => {
		if (props.modal.kind === 'confirm') {
			if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) props.modal.onCancel()
			else if (key.return) props.modal.onConfirm()
			else if (input.toLowerCase() === 'y') props.modal.onConfirm()
			else if (input.toLowerCase() === 'n') props.modal.onCancel()
			return
		}

		if (props.modal.kind === 'input') {
			if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) {
				props.modal.onCancel()
				return
			}
			if (key.return) {
				const trimmed = value.trim()
				const msg = props.modal.validate?.(trimmed) ?? null
				if (msg) {
					setError(msg)
					return
				}
				props.modal.onSubmit(trimmed)
				return
			}
			if (key.backspace || key.delete) {
				setValue((s) => s.slice(0, -1))
				return
			}
			if (key.ctrl && input.toLowerCase() === 'u') {
				setValue('')
				setError(null)
				return
			}
			if (key.ctrl || key.meta) return
			if (input && input.length === 1) {
				setValue((s) => s + input)
				setError(null)
			}
		}
	})

	const title = props.modal.title
	const message = props.modal.message

	return (
		<Box
			position="absolute"
			top={Math.floor((rows - height) / 2)}
			left={2}
			right={2}
			height={height}
			borderStyle="round"
			borderColor="yellow"
			flexDirection="column"
			paddingX={1}
		>
			<Text color="yellow">{title}</Text>
			<Text wrap="truncate">{message}</Text>
			<Box flexGrow={1} />
			{props.modal.kind === 'input' ? (
				<>
					<Text>
						{props.modal.placeholder ? `${props.modal.placeholder}: ` : ''}
						{value}
						{'▊'}
					</Text>
					<Text color={error ? 'red' : 'gray'}>
						{error ?? 'Enter submit • Esc/Ctrl+C cancel • Ctrl+U clear'}
					</Text>
				</>
			) : (
				<Text color="gray">
					Enter/{props.modal.confirmLabel} • Esc/Ctrl+C/{props.modal.cancelLabel} • y/n
				</Text>
			)}
		</Box>
	)
}

function StringListPanel(props: {
	title: string
	items: string[]
	placeholder: string
	height: number
	onTypingChange?: (typing: boolean) => void
	onChange: (next: string[]) => void
}) {
	const rows = Math.max(props.height, 10)
	const headerRows = 3
	const footerRows = 2
	const bodyRows = Math.max(rows - headerRows - footerRows, 5)
	const windowRows = Math.max(bodyRows - 2, 3)

	const [index, setIndex] = useState(0)
	const [offset, setOffset] = useState(0)

	const [inputMode, setInputMode] = useState<{ kind: 'add' | 'edit'; value: string } | null>(null)
	const [inputError, setInputError] = useState<string | null>(null)

	useEffect(() => {
		props.onTypingChange?.(Boolean(inputMode))
		return () => props.onTypingChange?.(false)
	}, [inputMode])

	useEffect(() => {
		setIndex((i) => clamp(i, 0, Math.max(props.items.length - 1, 0)))
	}, [props.items.length])

	function ensureVisible(nextIndex: number, count: number) {
		const maxOffset = Math.max(count - windowRows, 0)
		let nextOffset = clamp(offset, 0, maxOffset)
		if (nextIndex < nextOffset) nextOffset = nextIndex
		else if (nextIndex >= nextOffset + windowRows) nextOffset = nextIndex - windowRows + 1
		setOffset(clamp(nextOffset, 0, maxOffset))
	}

	useInput((input, key) => {
		if (key.escape) {
			if (inputMode) {
				setInputMode(null)
				setInputError(null)
			}
			return
		}

		if (inputMode) {
			if (key.return) {
				const v = inputMode.value.trim()
				if (!v) {
					setInputError('Required')
					return
				}
				if (inputMode.kind === 'add') props.onChange([...props.items, v])
				else {
					const next = props.items.slice()
					next[index] = v
					props.onChange(next)
				}
				setInputMode(null)
				setInputError(null)
				return
			}
			if (key.backspace || key.delete) {
				setInputMode((m) => (m ? { ...m, value: m.value.slice(0, -1) } : m))
				setInputError(null)
				return
			}
			if (key.ctrl && input.toLowerCase() === 'u') {
				setInputMode((m) => (m ? { ...m, value: '' } : m))
				setInputError(null)
				return
			}
			if (key.ctrl || key.meta) return
			if (input && input.length === 1) {
				setInputMode((m) => (m ? { ...m, value: m.value + input } : m))
				setInputError(null)
			}
			return
		}

		const count = props.items.length
		if (key.upArrow) {
			const next = clamp(index - 1, 0, Math.max(count - 1, 0))
			setIndex(next)
			ensureVisible(next, count)
			return
		}
		if (key.downArrow) {
			const next = clamp(index + 1, 0, Math.max(count - 1, 0))
			setIndex(next)
			ensureVisible(next, count)
			return
		}
		if (input === 'a' && !key.ctrl && !key.meta) {
			setInputMode({ kind: 'add', value: '' })
			setInputError(null)
			return
		}
		if ((input === 'e' || key.return) && !key.ctrl && !key.meta) {
			if (!count) {
				setInputMode({ kind: 'add', value: '' })
				setInputError(null)
				return
			}
			setInputMode({ kind: 'edit', value: props.items[index] ?? '' })
			setInputError(null)
			return
		}
		if (input === 'd' && !key.ctrl && !key.meta) {
			if (!count) return
			const next = props.items.slice()
			next.splice(index, 1)
			props.onChange(next)
			const nextIndex = clamp(index, 0, Math.max(next.length - 1, 0))
			setIndex(nextIndex)
			ensureVisible(nextIndex, next.length)
		}
	})

	const window = props.items.slice(offset, offset + windowRows)

	return (
		<Box flexDirection="column" width="100%" height={rows}>
			<Text>{props.title}</Text>
			<Text color="gray">
				{inputMode
					? 'Type • Enter submit • Esc cancel • Ctrl+U clear'
					: '↑/↓ move • Enter/e edit • a add • d delete'}
			</Text>
			<Box
				borderStyle="round"
				borderColor="gray"
				flexDirection="column"
				flexGrow={1}
				height={bodyRows}
			>
				{window.map((it, i) => {
					const idx = offset + i
					const active = idx === index
					return (
						<Text key={`${idx}:${it}`} color={active ? 'cyan' : undefined} wrap="truncate">
							{active ? '› ' : '  '}
							{it}
						</Text>
					)
				})}
			</Box>
			{inputMode ? (
				<Text wrap="truncate" color={inputError ? 'red' : 'gray'}>
					{props.placeholder}: {inputMode.value}
					{'▊'}
				</Text>
			) : (
				<Text color="gray" wrap="truncate">
					{props.items.length ? '' : '(empty)'}
				</Text>
			)}
		</Box>
	)
}

function ProfilesPanel(props: {
	active: string
	profiles: string[]
	height: number
	onAction: (
		result:
			| { type: 'activate'; name: string }
			| { type: 'create' }
			| { type: 'rename'; from: string }
			| { type: 'clone'; from: string }
			| { type: 'delete'; name: string },
	) => void
}) {
	const rows = Math.max(props.height, 10)
	const headerRows = 4
	const footerRows = 2
	const bodyRows = Math.max(rows - headerRows - footerRows, 6)
	const windowRows = Math.max(bodyRows - 2, 4)

	const [index, setIndex] = useState(0)
	const [offset, setOffset] = useState(0)

	useEffect(() => {
		setIndex((i) => clamp(i, 0, Math.max(props.profiles.length - 1, 0)))
	}, [props.profiles.length])

	function ensureVisible(nextIndex: number, count: number) {
		const maxOffset = Math.max(count - windowRows, 0)
		let nextOffset = clamp(offset, 0, maxOffset)
		if (nextIndex < nextOffset) nextOffset = nextIndex
		else if (nextIndex >= nextOffset + windowRows) nextOffset = nextIndex - windowRows + 1
		setOffset(clamp(nextOffset, 0, maxOffset))
	}

	useInput((input, key) => {
		const count = props.profiles.length
		if (key.upArrow) {
			const next = clamp(index - 1, 0, Math.max(count - 1, 0))
			setIndex(next)
			ensureVisible(next, count)
			return
		}
		if (key.downArrow) {
			const next = clamp(index + 1, 0, Math.max(count - 1, 0))
			setIndex(next)
			ensureVisible(next, count)
			return
		}

		const current = props.profiles[index]
		if (!current) return

		if (key.return) {
			props.onAction({ type: 'activate', name: current })
			return
		}
		if (input === 'n') {
			props.onAction({ type: 'create' })
			return
		}
		if (input === 'r') {
			props.onAction({ type: 'rename', from: current })
			return
		}
		if (input === 'c') {
			props.onAction({ type: 'clone', from: current })
			return
		}
		if (input === 'x') {
			props.onAction({ type: 'delete', name: current })
			return
		}
	})

	const items = props.profiles.map((p) => (p === props.active ? `${p} (active)` : p))
	const window = items.slice(offset, offset + windowRows)

	return (
		<Box flexDirection="column" width="100%">
			<Text>Profiles</Text>
			<Text color="gray">↑/↓ move • Enter activate • n new • r rename • c clone • x delete</Text>
			<Box
				borderStyle="round"
				borderColor="gray"
				flexDirection="column"
				flexGrow={1}
				height={bodyRows}
			>
				{window.map((it, i) => {
					const idx = offset + i
					const active = idx === index
					return (
						<Text key={`${idx}:${it}`} color={active ? 'cyan' : undefined} wrap="truncate">
							{active ? '› ' : '  '}
							{it}
						</Text>
					)
				})}
			</Box>
		</Box>
	)
}

type ScanState =
	| { status: 'idle' }
	| { status: 'scanning'; phase: string; key: string | null }
	| {
			status: 'ready'
			key: string
			rootsExpandedAbs: string[]
			discovered: Array<{ name: string; entry: string; pkgDir: string }>
			discoveredForUi: PickPackagesDiscoveredPlugin[]
			packages: Awaited<ReturnType<typeof scanWorkspacePackages>>['packages']
	  }
	| { status: 'error'; error: string }

type SnapshotState =
	| { status: 'idle' }
	| { status: 'building' }
	| {
			status: 'error'
			errors: string[]
			discovered?: Array<{ name: string; entry: string; pkgDir: string }>
	  }
	| { status: 'ok'; snapshot: WorkspaceSnapshot; warnings: string[] }

function HmrPromptApp(props: {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
	skipPackages: Set<string>
	initialCfg: PluxelHmrConfigV1
	initialProfile: string
	initialDirty: boolean
	initialParseError: string | null
	initialTab?: TabKey
	initialOpen?: InitialOpen
	onDone: (r: PromptResult) => void
}) {
	const { stdout } = useStdout()
	const rows = stdout?.rows ?? 24

	const [tab, setTab] = useState<TabKey>(props.initialTab ?? 'packages')
	const [scope, setScope] = useState<ConfigScope>('profile')
	const [cfg, setCfg] = useState<PluxelHmrConfigV1>(props.initialCfg)
	const [activeProfile, setActiveProfile] = useState(props.initialProfile)
	const [dirty, setDirty] = useState(props.initialDirty)
	const [toast, setToast] = useState<string>('')
	const [modal, setModal] = useState<Modal>(null)
	const [initialOpen, setInitialOpen] = useState<InitialOpen | null>(props.initialOpen ?? null)
	const [typing, setTyping] = useState(false)
	const [packagesInitialMode] = useState<'enabled' | 'builtin' | undefined>(() => {
		if (props.initialOpen?.kind !== 'packages') return undefined
		return props.initialOpen.mode
	})

	const [scan, setScan] = useState<ScanState>({ status: 'idle' })
	const [snapshot, setSnapshot] = useState<SnapshotState>({ status: 'idle' })
	const [doctorOffset, setDoctorOffset] = useState(0)
	const [scanNonce, setScanNonce] = useState(0)
	const scanKeyRef = useRef<string | null>(null)

	const rememberedRootsRef = useRef<{ profile: string[]; defaults: string[] }>({
		profile: [],
		defaults: [],
	})

	const doneRef = useRef(false)
	function finish(result: PromptResult) {
		if (doneRef.current) return
		doneRef.current = true
		props.onDone(result)
	}

	useEffect(() => {
		if (!toast) return
		const t = setTimeout(() => setToast(''), 2500)
		return () => clearTimeout(t)
	}, [toast])

	// Config sanity: ensure profile exists.
	useEffect(() => {
		if (!cfg.profiles[activeProfile]) {
			setCfg((prev) => ({
				...prev,
				profiles: { ...prev.profiles, [activeProfile]: { enabled: [] } },
			}))
			setDirty(true)
		}
	}, [cfg.profiles, activeProfile])

	// Initial parse error flow is handled as a modal (fail fast).
	useEffect(() => {
		if (!props.initialParseError) return
		setModal({
			kind: 'confirm',
			title: 'Config parse failed',
			message: props.initialParseError,
			confirmLabel: 'Regenerate',
			cancelLabel: 'Exit',
			onConfirm: () => {
				try {
					const repaired = createDefaultHmrConfigV1()
					backupAndRewriteHmrConfigV1(props.configPath, repaired)
					setCfg(repaired)
					setActiveProfile(repaired.profile)
					setDirty(false)
					setToast('Config regenerated.')
				} catch (e) {
					setToast(e instanceof Error ? e.message : String(e))
				} finally {
					setModal(null)
					setScanNonce((n) => n + 1)
				}
			},
			onCancel: () => {
				setModal(null)
				finish({ action: 'exit' })
			},
		})
		// run once on mount
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	const mergedResult = useMemo(() => {
		try {
			const env = { ...props.env, PLUXEL_HMR_PROFILE: activeProfile }
			return { merged: mergeHmrProfile(cfg, env), error: null as string | null }
		} catch (error) {
			return {
				merged: null,
				error: error instanceof Error ? error.message : String(error),
			}
		}
	}, [cfg, props.env, activeProfile])
	const merged = mergedResult.merged

	// Fail fast on config merge errors (instead of silently stalling).
	useEffect(() => {
		if (!mergedResult.error) return
		scanKeyRef.current = null
		setScan({ status: 'error', error: `Config error: ${mergedResult.error}` })
		setSnapshot({ status: 'error', errors: [`Config error: ${mergedResult.error}`] })
	}, [mergedResult.error])

	// Scan workspace packages only when roots/exclude change (or when explicitly refreshed).
	useEffect(() => {
		let cancelled = false
		async function run() {
			if (!merged) return

			try {
				const rootDirAbs = resolve(props.rootDir)
				const rootsExpandedAbs = await resolveHmrRootsExpanded(rootDirAbs, merged.roots)
				const key = `${rootsExpandedAbs.join('\n')}\n---\n${merged.excludeGlobs.join('\n')}`

				if (scanKeyRef.current === key) return

				setScan({ status: 'scanning', phase: 'Scanning packages', key })

				const { packages: scanPackages } = await scanWorkspacePackages({
					rootDir: rootDirAbs,
					roots: rootsExpandedAbs,
					excludeGlobs: merged.excludeGlobs,
				})
				const discovered = discoverPluginsFromPackages(rootDirAbs, scanPackages)

				const discoveredForUi = props.skipPackages.size
					? discovered.filter((p) => !props.skipPackages.has(p.name))
					: discovered

				writeHmrDiscoveredIndex({
					rootDir: rootDirAbs,
					configPath: props.configPath,
					activeProfile: merged.activeProfile,
					rootsExpandedAbs,
					excludeGlobs: merged.excludeGlobs,
					hiddenPackages: [...props.skipPackages],
					builtinPackages: merged.builtinPackages,
					omitFromEntries: merged.builtinPackages,
					discovered,
				})

				if (cancelled) return

				setScan({
					status: 'ready',
					key,
					rootsExpandedAbs,
					packages: scanPackages,
					discovered,
					discoveredForUi,
				})
				scanKeyRef.current = key
			} catch (error) {
				if (cancelled) return
				const msg = error instanceof Error ? error.message : String(error)
				setScan({ status: 'error', error: msg })
				setSnapshot({ status: 'error', errors: [`Scan error: ${msg}`] })
			}
		}
		void run()
		return () => {
			cancelled = true
		}
	}, [
		merged?.activeProfile,
		merged?.roots,
		merged?.excludeGlobs.join('\n'),
		props.rootDir,
		props.configPath,
		props.skipPackages,
		scanNonce,
	])

	// Snapshot build: derived from scan + merged; debounce to avoid thrash while selecting packages.
	useEffect(() => {
		let cancelled = false
		if (!merged) return
		if (scan.status !== 'ready') return
		setSnapshot({ status: 'building' })

		const t = setTimeout(() => {
			async function run() {
				try {
					const rootDirAbs = resolve(props.rootDir)
					const omitPackages = merged.builtinPackages?.length
						? uniqSorted(merged.builtinPackages)
						: undefined
					const snapshotRes = await buildWorkspaceSnapshotFromScan({
						rootDir: rootDirAbs,
						merged,
						rootsExpandedAbs: scan.rootsExpandedAbs,
						packages: scan.packages.map((p) => ({
							name: p.name,
							deps: p.deps,
							pkgDirAbs: p.pkgDirAbs,
						})),
						discovered: scan.discovered,
						omitPackages,
					})
					if (cancelled) return
					if (!snapshotRes.ok) {
						setSnapshot({
							status: 'error',
							errors: snapshotRes.errors,
							discovered: snapshotRes.discovered,
						})
					} else {
						setSnapshot({
							status: 'ok',
							snapshot: snapshotRes.snapshot,
							warnings: snapshotRes.warnings,
						})
					}
				} catch (error) {
					if (cancelled) return
					const msg = error instanceof Error ? error.message : String(error)
					setSnapshot({ status: 'error', errors: [msg] })
				}
			}
			void run()
		}, 120)

		return () => {
			cancelled = true
			clearTimeout(t)
		}
	}, [
		merged.activeProfile,
		merged.enabled.join('\n'),
		merged.builtinPackages.join('\n'),
		merged.includeGlobs.join('\n'),
		merged.excludeGlobs.join('\n'),
		scan.status === 'ready' ? scan.key : 'no-scan',
		props.rootDir,
	])

	function saveConfig() {
		try {
			writeHmrConfigV1(props.configPath, { ...cfg, profile: activeProfile })
			setDirty(false)
			setToast(`Saved ${props.configPath}`)
		} catch (error) {
			setToast(error instanceof Error ? error.message : String(error))
		}
	}

	function startIfReady() {
		if (snapshot.status !== 'ok') {
			setToast('Start blocked: fix errors (see Doctor tab).')
			setTab('doctor')
			return
		}
		setModal({
			kind: 'confirm',
			title: 'Start HMR',
			message: dirty ? 'Config is dirty. Start with current (unsaved) config state?' : 'Start now?',
			confirmLabel: 'Start',
			cancelLabel: 'Cancel',
			onConfirm: () => {
				setModal(null)
				finish({ action: 'start', snapshotJson: JSON.stringify(snapshot.snapshot) })
			},
			onCancel: () => setModal(null),
		})
	}

	// Global keybindings (disabled while modal is open).
	useInput((input, key) => {
		if (doneRef.current) return
		if (modal) return

		// While typing (e.g. filter/input), avoid global single-key actions.
		if (typing) {
			// Quit
			if (key.ctrl && input.toLowerCase() === 'c') {
				if (!dirty) {
					finish({ action: 'exit' })
					return
				}
				setModal({
					kind: 'confirm',
					title: 'Unsaved changes',
					message: 'Exit without saving?',
					confirmLabel: 'Exit',
					cancelLabel: 'Cancel',
					onConfirm: () => {
						setModal(null)
						finish({ action: 'exit' })
					},
					onCancel: () => setModal(null),
				})
				return
			}

			// Tabs (keep available)
			if (key.ctrl && key.leftArrow) {
				const all = tabs()
				const idx = all.indexOf(tab)
				setTab(all[(idx - 1 + all.length) % all.length]!)
				return
			}
			if (key.ctrl && key.rightArrow) {
				const all = tabs()
				const idx = all.indexOf(tab)
				setTab(all[(idx + 1) % all.length]!)
				return
			}

			// Refresh / Save (ctrl-only)
			if (key.ctrl && input.toLowerCase() === 'r') {
				scanKeyRef.current = null
				setScanNonce((n) => n + 1)
				setToast('Rescanning…')
				return
			}
			if (key.ctrl && input.toLowerCase() === 's') {
				saveConfig()
			}
			return
		}

		// Quit
		if (input === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
			if (!dirty) {
				finish({ action: 'exit' })
				return
			}
			setModal({
				kind: 'confirm',
				title: 'Unsaved changes',
				message: 'Exit without saving?',
				confirmLabel: 'Exit',
				cancelLabel: 'Cancel',
				onConfirm: () => {
					setModal(null)
					finish({ action: 'exit' })
				},
				onCancel: () => setModal(null),
			})
			return
		}

		// Tabs
		if (key.ctrl && key.leftArrow) {
			const all = tabs()
			const idx = all.indexOf(tab)
			setTab(all[(idx - 1 + all.length) % all.length]!)
			return
		}
		if (key.ctrl && key.rightArrow) {
			const all = tabs()
			const idx = all.indexOf(tab)
			setTab(all[(idx + 1) % all.length]!)
			return
		}
		if (/^[1-9]$/.test(input)) {
			const i = Number(input) - 1
			const all = tabs()
			if (i >= 0 && i < all.length) setTab(all[i]!)
			return
		}

		// Help
		if (input === '?' || input.toLowerCase() === 'h') {
			setTab('help')
			return
		}

		// Refresh
		if (key.ctrl && input.toLowerCase() === 'r') {
			scanKeyRef.current = null
			setScanNonce((n) => n + 1)
			setToast('Rescanning…')
			return
		}

		// Save
		if (
			(input.toLowerCase() === 'w' && !key.ctrl && !key.meta) ||
			(key.ctrl && input.toLowerCase() === 's')
		) {
			saveConfig()
			return
		}

		// Scope switch (roots/include/exclude)
		if (input.toLowerCase() === 's' && !key.ctrl && !key.meta) {
			if (tab === 'roots' || tab === 'include' || tab === 'exclude') {
				setScope((p) => (p === 'profile' ? 'defaults' : 'profile'))
			}
		}

		// Roots mode toggle
		if (tab === 'roots' && input.toLowerCase() === 't' && !key.ctrl && !key.meta) {
			toggleRootsAuto()
			return
		}

		// Start
		if (key.return && tab === 'start') {
			startIfReady()
			return
		}

		// Doctor scroll
		if (tab === 'doctor') {
			const maxOffset = Math.max(doctorLines.length - doctorWindowRows, 0)
			const page = Math.max(doctorWindowRows - 1, 1)
			if (key.upArrow) setDoctorOffset((o) => clamp(o - 1, 0, maxOffset))
			else if (key.downArrow) setDoctorOffset((o) => clamp(o + 1, 0, maxOffset))
			else if (key.pageUp || (key.ctrl && input.toLowerCase() === 'u'))
				setDoctorOffset((o) => clamp(o - page, 0, maxOffset))
			else if (key.pageDown || (key.ctrl && input.toLowerCase() === 'd'))
				setDoctorOffset((o) => clamp(o + page, 0, maxOffset))
			else if (!key.ctrl && !key.meta && input === 'g') setDoctorOffset(0)
			else if (!key.ctrl && !key.meta && input === 'G') setDoctorOffset(maxOffset)
		}
	})

	function setPackagesValue(next: { enabled: string[]; builtin: string[] }) {
		setCfg((prev) => {
			const profiles = { ...prev.profiles }
			const profile = profiles[activeProfile] ?? { enabled: [] }
			profiles[activeProfile] = {
				...profile,
				enabled: next.enabled,
				...(next.builtin.length ? { builtin: next.builtin } : {}),
			}
			if (!next.builtin.length) delete profiles[activeProfile].builtin
			return { ...prev, profiles }
		})
		setDirty(true)
	}

	function listForScope(target: 'roots' | 'include' | 'exclude') {
		const profile = cfg.profiles[activeProfile] ?? { enabled: [] }
		if (scope === 'defaults') {
			const defaults = cfg.defaults
			if (target === 'roots') return defaults?.roots === 'auto' ? [] : (defaults?.roots ?? [])
			if (target === 'include') return defaults?.include ?? []
			return defaults?.exclude ?? []
		}
		if (target === 'roots') return profile.roots === 'auto' ? [] : (profile.roots ?? [])
		if (target === 'include') return profile.include ?? []
		return profile.exclude ?? []
	}

	function setListForScope(target: 'roots' | 'include' | 'exclude', next: string[]) {
		const normalized = uniqPreserveOrder(next.map((s) => s.trim()).filter(Boolean))
		if (target === 'roots' && normalized.length) {
			if (scope === 'defaults') rememberedRootsRef.current.defaults = normalized.slice()
			else rememberedRootsRef.current.profile = normalized.slice()
		}
		setCfg((prev) => {
			const profiles = { ...prev.profiles }
			const profile = profiles[activeProfile] ?? { enabled: [] }
			if (scope === 'defaults') {
				const defaults = { ...(prev.defaults ?? {}) }
				if (target === 'include') {
					if (normalized.length) defaults.include = normalized
					else delete defaults.include
				} else if (target === 'exclude') {
					if (normalized.length) defaults.exclude = normalized
					else delete defaults.exclude
				} else {
					// roots list only when custom; toggle handled separately
					defaults.roots = normalized.length ? normalized : 'auto'
				}
				return { ...prev, defaults, profiles }
			}

			if (target === 'include') {
				profiles[activeProfile] = {
					...profile,
					...(normalized.length ? { include: normalized } : {}),
				}
				if (!normalized.length) delete profiles[activeProfile].include
			} else if (target === 'exclude') {
				profiles[activeProfile] = {
					...profile,
					...(normalized.length ? { exclude: normalized } : {}),
				}
				if (!normalized.length) delete profiles[activeProfile].exclude
			} else {
				profiles[activeProfile] = { ...profile, roots: normalized.length ? normalized : 'auto' }
			}
			return { ...prev, profiles }
		})
		setDirty(true)
		setScanNonce((n) => n + 1)
	}

	function toggleRootsAuto() {
		const profile = cfg.profiles[activeProfile] ?? { enabled: [] }
		const current =
			scope === 'defaults' ? (cfg.defaults?.roots ?? 'auto') : (profile.roots ?? 'auto')

		if (current === 'auto') {
			const remembered =
				scope === 'defaults'
					? rememberedRootsRef.current.defaults
					: rememberedRootsRef.current.profile
			if (remembered.length) {
				setListForScope('roots', remembered)
				setToast('Roots: custom')
				return
			}
			setToast('Roots is auto. Add a root to switch to custom.')
			return
		}

		const list = current
		if (list.length) {
			if (scope === 'defaults') rememberedRootsRef.current.defaults = list.slice()
			else rememberedRootsRef.current.profile = list.slice()
		}
		setListForScope('roots', [])
		setToast('Roots: auto')
	}

	function editableRootsList() {
		const profile = cfg.profiles[activeProfile] ?? { enabled: [] }
		const roots = scope === 'defaults' ? (cfg.defaults?.roots ?? 'auto') : (profile.roots ?? 'auto')
		if (roots !== 'auto') return roots
		const remembered =
			scope === 'defaults'
				? rememberedRootsRef.current.defaults
				: rememberedRootsRef.current.profile
		return remembered.length ? remembered : []
	}

	// Auto-open flows (when invoked via `pluxel hmr enabled/builtin` etc).
	useEffect(() => {
		if (!initialOpen) return
		if (modal) return
		if (initialOpen.kind === 'packages') {
			setTab('packages')
			setInitialOpen(null)
			return
		}
		if (initialOpen.kind === 'profiles') {
			setTab('profiles')
			setInitialOpen(null)
			return
		}
		if (initialOpen.kind === 'editList') {
			setTab(initialOpen.target)
			setInitialOpen(null)
		}
	}, [initialOpen, modal])

	const headerRows = 2
	const footerRows = 2
	const bodyRows = Math.max(rows - headerRows - footerRows, 10)
	const doctorWindowRows = Math.max(bodyRows - 2, 6)

	const doctorLines = useMemo(() => {
		if (snapshot.status === 'error') return snapshot.errors
		if (snapshot.status !== 'ok') return ['(no data yet)']
		const s = snapshot.snapshot
		const lines: string[] = []
		lines.push(`profile: ${s.activeProfile}`)
		lines.push(`enabled: ${s.enabled.length}`)
		lines.push(`builtin: ${s.builtinPackages.length}`)
		lines.push(`discovered: ${s.discovered.length}`)
		lines.push(`startup entries: ${s.enabledEntries.length}`)
		lines.push(`include entries: ${s.includedEntries.length}`)
		lines.push(`watch roots: ${s.watchRoots.length}`)
		lines.push('')
		if (snapshot.warnings.length) {
			lines.push('Warnings:')
			for (const w of snapshot.warnings) lines.push(w)
			lines.push('')
		}
		if (s.discovered.length) {
			lines.push('Discovered:')
			for (const p of s.discovered.slice(0, 200)) lines.push(`${p.name} -> ${p.entry}`)
			if (s.discovered.length > 200) lines.push(`…and ${s.discovered.length - 200} more`)
		}
		return lines
	}, [snapshot])

	useEffect(() => {
		const maxOffset = Math.max(doctorLines.length - doctorWindowRows, 0)
		setDoctorOffset((o) => clamp(o, 0, maxOffset))
	}, [doctorLines.length, doctorWindowRows])

	const tabList = tabs()
	const tabIndex = tabList.indexOf(tab)

	const profile = cfg.profiles[activeProfile] ?? { enabled: [] }
	const rootsValue =
		scope === 'defaults' ? (cfg.defaults?.roots ?? 'auto') : (profile.roots ?? 'auto')
	const includeValue =
		scope === 'defaults' ? (cfg.defaults?.include ?? []) : (profile.include ?? [])
	const excludeValue =
		scope === 'defaults' ? (cfg.defaults?.exclude ?? []) : (profile.exclude ?? [])

	const enabledPreview = formatListInline(profile.enabled ?? [], 6)
	const builtinPreview = formatListInline(profile.builtin ?? [], 6)

	type ProfileAction =
		| { type: 'activate'; name: string }
		| { type: 'create' }
		| { type: 'rename'; from: string }
		| { type: 'clone'; from: string }
		| { type: 'delete'; name: string }

	function handleProfileAction(act: ProfileAction) {
		const names = Object.keys(cfg.profiles).sort((a, b) => a.localeCompare(b))

		if (act.type === 'activate') {
			setActiveProfile(act.name)
			setCfg((prev) => ({ ...prev, profile: act.name }))
			setDirty(true)
			return
		}

		if (act.type === 'create') {
			setModal({
				kind: 'input',
				title: 'New profile',
				message: 'Enter profile name',
				placeholder: 'dev',
				onSubmit: (name) => {
					setModal(null)
					setCfg((prev) => ({
						...prev,
						profiles: { ...prev.profiles, [name]: { enabled: [] } },
						profile: name,
					}))
					setActiveProfile(name)
					setDirty(true)
				},
				onCancel: () => setModal(null),
				validate: (v) => {
					if (!v.trim()) return 'Required'
					if (cfg.profiles[v]) return 'Already exists'
					return null
				},
			})
			return
		}

		if (act.type === 'rename') {
			setModal({
				kind: 'input',
				title: 'Rename profile',
				message: `Rename "${act.from}" to…`,
				initial: act.from,
				onSubmit: (name) => {
					setModal(null)
					setCfg((prev) => {
						const nextProfiles = { ...prev.profiles }
						nextProfiles[name] = nextProfiles[act.from]!
						delete nextProfiles[act.from]
						const nextProfile = prev.profile === act.from ? name : prev.profile
						return { ...prev, profiles: nextProfiles, profile: nextProfile }
					})
					setActiveProfile((p) => (p === act.from ? name : p))
					setDirty(true)
				},
				onCancel: () => setModal(null),
				validate: (v) => {
					if (!v.trim()) return 'Required'
					if (v !== act.from && cfg.profiles[v]) return 'Already exists'
					return null
				},
			})
			return
		}

		if (act.type === 'clone') {
			setModal({
				kind: 'input',
				title: 'Clone profile',
				message: `Clone "${act.from}" to…`,
				placeholder: `${act.from}2`,
				onSubmit: (name) => {
					setModal(null)
					setCfg((prev) => {
						const data = prev.profiles[act.from] ?? { enabled: [] }
						const cloned = JSON.parse(JSON.stringify(data)) as PluxelHmrConfigV1['profiles'][string]
						return { ...prev, profiles: { ...prev.profiles, [name]: cloned } }
					})
					setDirty(true)
				},
				onCancel: () => setModal(null),
				validate: (v) => {
					if (!v.trim()) return 'Required'
					if (cfg.profiles[v]) return 'Already exists'
					return null
				},
			})
			return
		}

		if (act.type === 'delete') {
			if (names.length <= 1) {
				setToast('Cannot delete the last profile.')
				return
			}
			setModal({
				kind: 'confirm',
				title: 'Delete profile',
				message: `Delete "${act.name}"?`,
				confirmLabel: 'Delete',
				cancelLabel: 'Cancel',
				onConfirm: () => {
					setModal(null)
					setCfg((prev) => {
						const next = { ...prev.profiles }
						delete next[act.name]
						const remaining = Object.keys(next).sort((a, b) => a.localeCompare(b))
						const nextActive = remaining[0]!
						return {
							...prev,
							profiles: next,
							profile: prev.profile === act.name ? nextActive : prev.profile,
						}
					})
					setActiveProfile((p) => (p === act.name ? (names.find((n) => n !== act.name) ?? p) : p))
					setDirty(true)
				},
				onCancel: () => setModal(null),
			})
		}
	}

	const statusLine =
		scan.status === 'scanning'
			? `scanning: ${scan.phase}`
			: scan.status === 'error'
				? `scan error: ${scan.error}`
				: scan.status === 'ready'
					? `discovered=${scan.discoveredForUi.length} roots=${scan.rootsExpandedAbs.length}`
					: 'idle'

	const snapshotLine =
		snapshot.status === 'ok'
			? `entries=${snapshot.snapshot.enabledEntries.length} watchRoots=${snapshot.snapshot.watchRoots.length} warnings=${snapshot.warnings.length}`
			: snapshot.status === 'error'
				? `errors=${snapshot.errors.length}`
				: snapshot.status
	const doctorWindow = doctorLines.slice(doctorOffset, doctorOffset + doctorWindowRows)

	return (
		<Box flexDirection="column" width="100%">
			<Text>
				{tabList
					.map((t, i) => {
						const active = t === tab
						const label = `${i + 1}:${tabLabel(t)}`
						return active ? `[${label}]` : ` ${label} `
					})
					.join(' | ')}
			</Text>
			<Text color="gray">
				profile={activeProfile} • scope={scope} • dirty={dirty ? 'yes' : 'no'} • {statusLine} •{' '}
				{snapshotLine}
			</Text>

			<Box flexDirection="column" flexGrow={1} height={bodyRows}>
				{tab === 'packages' ? (
					scan.status === 'ready' ? (
						<PickPackagesDualBrowser
							discovered={scan.discoveredForUi}
							enabled={profile.enabled ?? []}
							builtin={profile.builtin ?? []}
							initialMode={packagesInitialMode}
							height={bodyRows}
							onTypingChange={setTyping}
							onChange={setPackagesValue}
						/>
					) : (
						<Text color="gray">
							{scan.status === 'scanning' ? `Scanning… ${scan.phase}` : 'Waiting for scan…'}
						</Text>
					)
				) : null}

				{tab === 'start' ? (
					<Box flexDirection="column" width="100%">
						<Text>Start</Text>
						<Text color="gray">
							Enter start • w/Ctrl+S save • Ctrl+R rescan • Ctrl+←/→ or 1-9 tabs • q/Ctrl+C exit
						</Text>
						<Text>enabled: {enabledPreview}</Text>
						<Text>builtin: {builtinPreview}</Text>
						<Text>
							roots({scope}):{' '}
							{rootsValue === 'auto' ? 'auto' : `${(rootsValue ?? []).length} item(s)`}
						</Text>
						<Text>
							include({scope}): {(includeValue ?? []).length} • exclude({scope}):{' '}
							{(excludeValue ?? []).length}
						</Text>
						<Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
							<Text
								color={
									snapshot.status === 'ok'
										? 'green'
										: snapshot.status === 'error'
											? 'red'
											: 'yellow'
								}
							>
								{snapshot.status === 'ok'
									? 'Ready'
									: snapshot.status === 'error'
										? 'Blocked'
										: 'Working…'}
							</Text>
							{snapshot.status === 'error' ? (
								<Text wrap="truncate">{snapshot.errors[0] ?? '(unknown error)'}</Text>
							) : snapshot.status === 'ok' ? (
								<Text wrap="truncate">
									entries={snapshot.snapshot.enabledEntries.length} • watchRoots=
									{snapshot.snapshot.watchRoots.length} • warnings={snapshot.warnings.length}
								</Text>
							) : (
								<Text wrap="truncate">building snapshot…</Text>
							)}
						</Box>
					</Box>
				) : null}

				{tab === 'doctor' ? (
					<Box flexDirection="column" width="100%">
						<Text>Doctor</Text>
						<Text color="gray">
							↑/↓ scroll • PgUp/PgDn (or Ctrl+U/D) • g/G top/bottom • Ctrl+R rescan • Ctrl+←/→ tabs
						</Text>
						<Box borderStyle="round" borderColor="gray" flexDirection="column" flexGrow={1}>
							{doctorWindow.map((line, i) => (
								<Text key={`${doctorOffset + i}:${line}`} wrap="truncate">
									{line}
								</Text>
							))}
						</Box>
					</Box>
				) : null}

				{tab === 'roots' ? (
					<StringListPanel
						title={`Roots (${scope}) • mode=${rootsValue === 'auto' ? 'auto' : 'custom'} (t toggle)`}
						height={bodyRows}
						placeholder="root folder"
						items={editableRootsList()}
						onTypingChange={setTyping}
						onChange={(next) => {
							setListForScope('roots', next)
							setToast(next.length ? 'Roots: custom' : 'Roots: auto')
						}}
					/>
				) : null}

				{tab === 'include' ? (
					<StringListPanel
						title={`Include (${scope})`}
						height={bodyRows}
						placeholder="glob"
						items={listForScope('include')}
						onTypingChange={setTyping}
						onChange={(next) => setListForScope('include', next)}
					/>
				) : null}

				{tab === 'exclude' ? (
					<StringListPanel
						title={`Exclude (${scope})`}
						height={bodyRows}
						placeholder="glob"
						items={listForScope('exclude')}
						onTypingChange={setTyping}
						onChange={(next) => setListForScope('exclude', next)}
					/>
				) : null}

				{tab === 'profiles' ? (
					<ProfilesPanel
						active={activeProfile}
						profiles={Object.keys(cfg.profiles).sort((a, b) => a.localeCompare(b))}
						height={bodyRows}
						onAction={handleProfileAction}
					/>
				) : null}

				{tab === 'help' ? (
					<Box flexDirection="column" width="100%">
						<Text>Help</Text>
						<Text color="gray">
							Ctrl+←/→ or 1-9 switch tabs • Ctrl+R rescan • w/Ctrl+S save • Enter start (Start tab)
							• q/Ctrl+C exit
						</Text>
						<Text color="gray">
							Packages: inline browser (no Enter). e/b mode; x swap; Space(on folder) apply mode; /
							filter (Esc leaves filter).
						</Text>
						<Text color="gray">Roots/Include/Exclude: s switches scope(profile/defaults)</Text>
					</Box>
				) : null}
			</Box>

			<Text color={toast ? 'yellow' : 'gray'} wrap="truncate">
				{toast || `Tab ${tabIndex + 1}/${tabList.length} • press ? for help`}
			</Text>
			<Text color="gray" wrap="truncate">
				Keys: Ctrl+←/→ tabs • 1-9 jump • Ctrl+R rescan • w/Ctrl+S save • ? help • q/Ctrl+C quit
			</Text>

			{modal ? <ModalOverlay modal={modal} /> : null}
		</Box>
	)
}

export async function runHmrPromptTui(params: {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
	skipPackages: Set<string>
	initialTab?: TabKey
	initialOpen?: InitialOpen
}): Promise<PromptResult> {
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		throw new Error('Interactive `pluxel hmr` requires a TTY.')
	}

	let initialCfg: PluxelHmrConfigV1
	let initialProfile = 'dev'
	let initialDirty = false
	let initialParseError: string | null = null

	if (!existsSync(params.configPath)) {
		initialCfg = createDefaultHmrConfigV1()
		initialProfile = params.env.PLUXEL_HMR_PROFILE ?? initialCfg.profile
		initialDirty = true
	} else {
		try {
			initialCfg = readHmrConfigV1(params.configPath)
			initialProfile = params.env.PLUXEL_HMR_PROFILE ?? initialCfg.profile
		} catch (e) {
			initialCfg = createDefaultHmrConfigV1()
			initialProfile = initialCfg.profile
			initialDirty = false
			initialParseError = e instanceof Error ? e.message : String(e)
		}
	}

	// Ensure at least one profile exists.
	if (Object.keys(initialCfg.profiles).length === 0) {
		initialCfg.profiles.dev = { enabled: [] }
		initialCfg.profile = 'dev'
		initialProfile = 'dev'
		initialDirty = true
	}

	const defaultInitialOpen: InitialOpen | undefined = (() => {
		// First-time setup: prompt user to pick packages instead of a blank start screen.
		if (!existsSync(params.configPath)) return { kind: 'packages', mode: 'enabled' }
		return undefined
	})()

	return new Promise<PromptResult>((resolvePromise, reject) => {
		let resolved = false
		const { waitUntilExit, unmount } = render(
			<HmrPromptApp
				rootDir={params.rootDir}
				configPath={params.configPath}
				env={params.env}
				skipPackages={params.skipPackages}
				initialCfg={initialCfg}
				initialProfile={initialProfile}
				initialDirty={initialDirty}
				initialParseError={initialParseError}
				initialTab={params.initialTab ?? 'packages'}
				initialOpen={params.initialOpen ?? defaultInitialOpen}
				onDone={(r) => {
					if (resolved) return
					resolved = true
					resolvePromise(r)
					unmount()
				}}
			/>,
			{ exitOnCtrlC: false },
		)

		waitUntilExit().catch((err) => {
			if (resolved) return
			resolved = true
			reject(err)
		})
	})
}
