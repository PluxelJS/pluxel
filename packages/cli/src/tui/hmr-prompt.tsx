import { existsSync } from 'node:fs'
import type {
	LoaderHmrWorkspace,
	PluxelLoaderHmrConfigV2,
} from '@pluxel/runtime-dynamic/hmr/diagnose'
import { Box, render, Text, useInput, useStdout } from 'ink'
import { resolve } from 'pathe'
import { useEffect, useMemo, useRef, useState } from 'react'
import { writeLoaderHmrDiscoveredIndex } from '../hmr/discovered-index'
import { PickPackagesBrowser, type PickPackagesDiscoveredPlugin } from './pick-packages'

type TabKey = 'packages' | 'paths' | 'doctor' | 'snapshot'

type PromptResult = { action: 'exit' }

type ConfigScope = 'profile' | 'defaults'

type Overlay = 'profiles' | 'help' | null
type LoaderHmrDiagnoseModule = typeof import('@pluxel/runtime-dynamic/hmr/diagnose')
type ScanWorkspacePackages = LoaderHmrDiagnoseModule['scanWorkspacePackages']

function clamp(n: number, min: number, max: number) {
	return Math.max(min, Math.min(max, n))
}

function uniqPreserveOrder(items: readonly string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const raw of items) {
		const item = String(raw)
		if (seen.has(item)) continue
		seen.add(item)
		out.push(item)
	}
	return out
}

type PathsFocus = 'roots' | 'include' | 'exclude'

type InitialOpen =
	| { kind: 'packages' }
	| { kind: 'profiles' }
	| { kind: 'paths'; focus?: PathsFocus }

function formatListInline(items: string[], max = 6) {
	if (items.length === 0) return '(none)'
	const head = items.slice(0, max)
	const rest = items.length - head.length
	return rest > 0 ? `${head.join(', ')}, +${rest}` : head.join(', ')
}

function tabLabel(tab: TabKey) {
	switch (tab) {
		case 'packages':
			return 'Packages'
		case 'paths':
			return 'Paths'
		case 'doctor':
			return 'Doctor'
		case 'snapshot':
			return 'Snapshot'
	}
}

function tabs(): TabKey[] {
	return ['packages', 'paths', 'doctor', 'snapshot']
}

function TabBar(props: { tabs: TabKey[]; active: TabKey }) {
	return (
		<Text>
			{props.tabs.map((t, i) => {
				const active = t === props.active
				const label = `${i + 1}:${tabLabel(t)}`
				return (
					<Text key={t}>
						<Text color={active ? 'black' : 'gray'} backgroundColor={active ? 'cyan' : undefined}>
							{` ${label} `}
						</Text>
						{i < props.tabs.length - 1 ? <Text color="gray"> </Text> : null}
					</Text>
				)
			})}
		</Text>
	)
}

type Modal =
	| null
	| {
			kind: 'confirm'
			title: string
			message: string
			confirmLabel: string
			cancelLabel: string
			defaultFocus?: 'confirm' | 'cancel'
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
	const columns = stdout?.columns ?? 80
	const height = Math.max(Math.min(rows - 4, 12), 6)

	const [value, setValue] = useState(
		props.modal.kind === 'input' ? (props.modal.initial ?? '') : '',
	)
	const [error, setError] = useState<string | null>(null)
	const [confirmFocus, setConfirmFocus] = useState<'confirm' | 'cancel'>('confirm')

	useEffect(() => {
		if (props.modal.kind === 'input') {
			setValue(props.modal.initial ?? '')
			setError(null)
		}
		if (props.modal.kind === 'confirm') {
			setConfirmFocus(props.modal.defaultFocus ?? 'confirm')
		}
	}, [props.modal])

	useInput((input, key) => {
		if (props.modal.kind === 'confirm') {
			if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) props.modal.onCancel()
			else if (key.leftArrow || (key.shift && key.tab) || input.toLowerCase() === 'h')
				setConfirmFocus('cancel')
			else if (key.rightArrow || key.tab || input.toLowerCase() === 'l') setConfirmFocus('confirm')
			else if (key.return) {
				if (confirmFocus === 'confirm') props.modal.onConfirm()
				else props.modal.onCancel()
			} else if (input.toLowerCase() === 'y') props.modal.onConfirm()
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
			marginTop={Math.floor((rows - height) / 2)}
			marginLeft={2}
			width={Math.max(columns - 4, 1)}
			height={height}
			borderStyle="round"
			borderColor="yellow"
			backgroundColor="black"
			flexDirection="column"
			paddingX={1}
		>
			<Box width="100%" justifyContent="center">
				<Text color="yellow">{title}</Text>
			</Box>
			<Box width="100%" justifyContent="center">
				<Text wrap="truncate">{message}</Text>
			</Box>
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
				<>
					<Box width="100%" justifyContent="space-between">
						<Text
							color={confirmFocus === 'cancel' ? 'black' : 'gray'}
							backgroundColor={confirmFocus === 'cancel' ? 'yellow' : undefined}
						>
							{`[N] ${props.modal.cancelLabel}`}
						</Text>
						<Text
							color={confirmFocus === 'confirm' ? 'black' : 'green'}
							backgroundColor={confirmFocus === 'confirm' ? 'green' : undefined}
						>
							{`[Y] ${props.modal.confirmLabel}`}
						</Text>
					</Box>
					<Text color="gray">←/→ focus • Enter confirm • Esc cancel</Text>
				</>
			)}
		</Box>
	)
}

function ScreenMask(props: { visible: boolean }) {
	const { stdout } = useStdout()
	const rows = stdout?.rows ?? 24
	const cols = stdout?.columns ?? 80
	const fill = useMemo(() => {
		if (!props.visible) return ''
		const line = ' '.repeat(Math.max(cols, 1))
		return Array.from({ length: Math.max(rows, 1) }, () => line).join('\n')
	}, [props.visible, rows, cols])
	if (!props.visible) return null
	return (
		<Box position="absolute" width={cols} height={rows} backgroundColor="black">
			<Text>{fill}</Text>
		</Box>
	)
}

function StringListPanel(props: {
	title: string
	items: string[]
	placeholder: string
	height: number
	disabled?: boolean
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
		if (props.disabled) return
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
					const next = [...props.items]
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
			const next = [...props.items]
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
					{props.items.length > 0 ? '' : '(empty)'}
				</Text>
			)}
		</Box>
	)
}

function ProfilesPanel(props: {
	active: string
	profiles: string[]
	height: number
	disabled?: boolean
	showHeader?: boolean
	bordered?: boolean
	autoActivate?: boolean
	hotkeysDisabled?: boolean
	onAction: (
		result:
			| { type: 'activate'; name: string }
			| { type: 'create' }
			| { type: 'rename'; from: string }
			| { type: 'clone'; from: string }
			| { type: 'delete'; name: string },
	) => void
}) {
	const showHeader = props.showHeader ?? true
	const bordered = props.bordered ?? true

	const rows = Math.max(props.height, 10)
	const headerRows = showHeader ? 2 : 0
	const bodyRows = Math.max(rows - headerRows, 6)
	const windowRows = Math.max(bodyRows - (bordered ? 2 : 0), 4)

	const [index, setIndex] = useState(0)
	const [offset, setOffset] = useState(0)

	useEffect(() => {
		setIndex((i) => clamp(i, 0, Math.max(props.profiles.length - 1, 0)))
	}, [props.profiles.length])

	useEffect(() => {
		const idx = Math.max(props.profiles.indexOf(props.active), 0)
		setIndex(idx)
		const count = props.profiles.length
		setOffset((prevOffset) => {
			if (!count) return 0
			const maxOffset = Math.max(count - windowRows, 0)
			let nextOffset = clamp(prevOffset, 0, maxOffset)
			if (idx < nextOffset) nextOffset = idx
			else if (idx >= nextOffset + windowRows) nextOffset = idx - windowRows + 1
			return clamp(nextOffset, 0, maxOffset)
		})
	}, [props.active, props.profiles.join('\n'), windowRows])

	function ensureVisible(nextIndex: number, count: number) {
		const maxOffset = Math.max(count - windowRows, 0)
		let nextOffset = clamp(offset, 0, maxOffset)
		if (nextIndex < nextOffset) nextOffset = nextIndex
		else if (nextIndex >= nextOffset + windowRows) nextOffset = nextIndex - windowRows + 1
		setOffset(clamp(nextOffset, 0, maxOffset))
	}

	useInput((input, key) => {
		if (props.disabled) return
		const count = props.profiles.length
		if (key.upArrow) {
			const next = clamp(index - 1, 0, Math.max(count - 1, 0))
			setIndex(next)
			ensureVisible(next, count)
			const nextName = props.profiles[next]
			if (props.autoActivate && nextName && nextName !== props.active) {
				props.onAction({ type: 'activate', name: nextName })
			}
			return
		}
		if (key.downArrow) {
			const next = clamp(index + 1, 0, Math.max(count - 1, 0))
			setIndex(next)
			ensureVisible(next, count)
			const nextName = props.profiles[next]
			if (props.autoActivate && nextName && nextName !== props.active) {
				props.onAction({ type: 'activate', name: nextName })
			}
			return
		}
		if (!key.ctrl && !key.meta && input === 'k') {
			const next = clamp(index - 1, 0, Math.max(count - 1, 0))
			setIndex(next)
			ensureVisible(next, count)
			const nextName = props.profiles[next]
			if (props.autoActivate && nextName && nextName !== props.active) {
				props.onAction({ type: 'activate', name: nextName })
			}
			return
		}
		if (!key.ctrl && !key.meta && input === 'j') {
			const next = clamp(index + 1, 0, Math.max(count - 1, 0))
			setIndex(next)
			ensureVisible(next, count)
			const nextName = props.profiles[next]
			if (props.autoActivate && nextName && nextName !== props.active) {
				props.onAction({ type: 'activate', name: nextName })
			}
			return
		}

		const current = props.profiles[index]
		if (!current) return

		if (key.return) {
			if (props.autoActivate) return
			if (props.hotkeysDisabled) return
			props.onAction({ type: 'activate', name: current })
			return
		}
		if (props.hotkeysDisabled) return
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
		}
	})

	const items = props.profiles.map((p, i) => {
		const n = i < 9 ? `${i + 1}` : i === 9 ? '0' : ''
		const num = n ? `${n}) ` : '   '
		const active = p === props.active ? '● ' : '  '
		return `${num}${active}${p}`
	})
	const window = items.slice(offset, offset + windowRows)

	return (
		<Box flexDirection="column" width="100%">
			{showHeader ? (
				<>
					<Text>Profiles</Text>
					<Text color="gray">
						↑/↓ move • Enter activate • n new • r rename • c clone • x delete
					</Text>
				</>
			) : null}
			<Box
				borderStyle={bordered ? 'round' : undefined}
				borderColor={bordered ? 'gray' : undefined}
				flexDirection="column"
				flexGrow={1}
				height={bodyRows}
			>
				{window.map((it, i) => {
					const idx = offset + i
					const active = idx === index
					const isActiveProfile = props.profiles[idx] === props.active
					const color = active ? 'cyan' : isActiveProfile ? 'yellow' : undefined
					return (
						<Text key={`${idx}:${it}`} color={color} wrap="truncate">
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
			packages: Awaited<ReturnType<ScanWorkspacePackages>>['packages']
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
	| { status: 'ok'; snapshot: LoaderHmrWorkspace; warnings: string[] }

function LoaderHmrPromptApp(props: {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
	diagnose: LoaderHmrDiagnoseModule
	skipPackages: Set<string>
	initialCfg: PluxelLoaderHmrConfigV2
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
	const {
		backupAndRewriteLoaderHmrConfigV2,
		buildLoaderHmrWorkspaceFromScan,
		createDefaultLoaderHmrConfigV2,
		discoverPluginsFromPackages,
		mergeLoaderHmrProfile,
		resolveLoaderHmrRootsExpanded,
		scanWorkspacePackages,
		writeLoaderHmrConfigV2,
	} = props.diagnose
	const [pathsFocus, setPathsFocus] = useState<PathsFocus>(() => {
		if (props.initialOpen?.kind === 'paths') return props.initialOpen.focus ?? 'roots'
		return 'roots'
	})
	const [scope, setScope] = useState<ConfigScope>('profile')
	const [cfg, setCfg] = useState<PluxelLoaderHmrConfigV2>(props.initialCfg)
	const [activeProfile, setActiveProfile] = useState(props.initialProfile)
	const [dirty, setDirty] = useState(props.initialDirty)
	const [toast, setToast] = useState<string>('')
	const [modal, setModal] = useState<Modal>(null)
	const [overlay, setOverlay] = useState<Overlay>(null)
	const [initialOpen, setInitialOpen] = useState<InitialOpen | null>(props.initialOpen ?? null)
	const [typing, setTyping] = useState(false)
	const [scan, setScan] = useState<ScanState>({ status: 'idle' })
	const [snapshot, setSnapshot] = useState<SnapshotState>({ status: 'idle' })
	const [doctorOffset, setDoctorOffset] = useState(0)
	const [doctorDetails, setDoctorDetails] = useState(false)
	const [scanNonce, setScanNonce] = useState(0)
	const scanKeyRef = useRef<string | null>(null)
	const profileNames = useMemo(
		() => Object.keys(cfg.profiles).sort((a, b) => a.localeCompare(b)),
		[cfg.profiles],
	)

	const rememberedRootsRef = useRef<{ profile: string[]; defaults: string[] }>({
		profile: [],
		defaults: [],
	})

	const doneRef = useRef(false)
	const tabHoldRef = useRef<{ lastAt: number; count: number }>({ lastAt: 0, count: 0 })
	function finish(result: PromptResult) {
		if (doneRef.current) return
		doneRef.current = true
		props.onDone(result)
	}

	useEffect(() => {
		if (!toast) return undefined
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
			defaultFocus: 'confirm',
			onConfirm: () => {
				try {
					const repaired = createDefaultLoaderHmrConfigV2()
					backupAndRewriteLoaderHmrConfigV2(props.configPath, repaired)
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
	}, [])

	const mergedResult = useMemo(() => {
		try {
			const env = { ...props.env, PLUXEL_HMR_PROFILE: activeProfile }
			return { merged: mergeLoaderHmrProfile(cfg, env), error: null as string | null }
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
				const rootsExpandedAbs = await resolveLoaderHmrRootsExpanded(rootDirAbs, merged.roots)
				const key = `${rootsExpandedAbs.join('\n')}\n---\n${merged.excludeGlobs.join('\n')}`

				if (scanKeyRef.current === key) return

				setScan({ status: 'scanning', phase: 'Scanning packages', key })

				const { packages: scanPackages } = await scanWorkspacePackages({
					rootDir: rootDirAbs,
					roots: rootsExpandedAbs,
					excludeGlobs: merged.excludeGlobs,
				})
				const discovered = discoverPluginsFromPackages(rootDirAbs, scanPackages)

				const discoveredForUi =
					props.skipPackages.size > 0
						? discovered.filter((p) => !props.skipPackages.has(p.name))
						: discovered

				writeLoaderHmrDiscoveredIndex({
					rootDir: rootDirAbs,
					configPath: props.configPath,
					activeProfile: merged.activeProfile,
					rootsExpandedAbs,
					excludeGlobs: merged.excludeGlobs,
					hiddenPackages: [...props.skipPackages],
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
		if (!merged) return undefined
		if (scan.status !== 'ready') return undefined
		const currentMerged = merged
		const readyScan = scan
		setSnapshot({ status: 'building' })

		const t = setTimeout(() => {
			async function run() {
				try {
					const rootDirAbs = resolve(props.rootDir)
					const snapshotRes = await buildLoaderHmrWorkspaceFromScan({
						rootDir: rootDirAbs,
						merged: currentMerged,
						rootsExpandedAbs: readyScan.rootsExpandedAbs,
						packages: readyScan.packages.map((p) => ({
							name: p.name,
							deps: p.deps,
							pkgDirAbs: p.pkgDirAbs,
						})),
						discovered: readyScan.discovered,
					})
					if (cancelled) return
					if (snapshotRes.ok === false) {
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
		merged.includeGlobs.join('\n'),
		merged.excludeGlobs.join('\n'),
		scan.status === 'ready' ? scan.key : 'no-scan',
		props.rootDir,
	])

	function saveConfig() {
		try {
			writeLoaderHmrConfigV2(props.configPath, { ...cfg, profile: activeProfile })
			setDirty(false)
			setToast(`Saved ${props.configPath}`)
		} catch (error) {
			setToast(error instanceof Error ? error.message : String(error))
		}
	}

	// Global keybindings (disabled while modal is open).
	useInput((input, key) => {
		if (doneRef.current) return
		if (modal) return

		const isTab = key.tab || input === '\t'
		const isShiftTab = (key.shift && key.tab) || input === '\x1b[Z'

		const toggleHelpOverlay = () => {
			setOverlay((prev) => (prev === 'help' ? null : 'help'))
		}

		const openProfilesOverlay = () => {
			setTab('packages')
			setOverlay('profiles')
		}

		const maybeOpenProfilesByTabHold = () => {
			if (tab === 'paths') return false
			const now = Date.now()
			const prev = tabHoldRef.current
			const nextCount = now - prev.lastAt < 240 ? prev.count + 1 : 1
			tabHoldRef.current = { lastAt: now, count: nextCount }
			// Require several repeats to avoid accidental double-tap.
			if (nextCount >= 4) {
				tabHoldRef.current = { lastAt: 0, count: 0 }
				openProfilesOverlay()
				return true
			}
			return false
		}

		const cyclePathsFocus = (dir: 1 | -1) => {
			const order: PathsFocus[] = ['roots', 'include', 'exclude']
			const idx = Math.max(order.indexOf(pathsFocus), 0)
			const next = order[(idx + dir + order.length) % order.length]
			if (next === pathsFocus) return
			setPathsFocus(next)
		}

		// Overlay open: keep only safe global shortcuts.
		if (overlay) {
			if (isTab && !isShiftTab) {
				maybeOpenProfilesByTabHold()
				return
			}
			if (input === '?' && !key.ctrl && !key.meta) {
				toggleHelpOverlay()
				return
			}
			if (key.ctrl && input.toLowerCase() === 'p') {
				openProfilesOverlay()
				return
			}
			if (key.ctrl && key.leftArrow) {
				const all = tabs()
				const idx = all.indexOf(tab)
				setTab(all[(idx - 1 + all.length) % all.length]!)
				setOverlay(null)
				return
			}
			if (key.ctrl && key.rightArrow) {
				const all = tabs()
				const idx = all.indexOf(tab)
				setTab(all[(idx + 1) % all.length]!)
				setOverlay(null)
				return
			}
			if (key.ctrl && input.toLowerCase() === 'r') {
				scanKeyRef.current = null
				setScanNonce((n) => n + 1)
				setToast('Rescanning…')
				return
			}
			if (key.ctrl && input.toLowerCase() === 's') {
				saveConfig()
				return
			}
			return
		}

		// While typing (e.g. filter/input), avoid global single-key actions.
		if (typing) {
			if (isTab && !isShiftTab && maybeOpenProfilesByTabHold()) return
			if (key.ctrl && input.toLowerCase() === 'p') {
				openProfilesOverlay()
				return
			}
			if (input === '?' && !key.ctrl && !key.meta) {
				toggleHelpOverlay()
				return
			}
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
					defaultFocus: 'cancel',
					onConfirm: () => {
						setModal(null)
						finish({ action: 'exit' })
					},
					onCancel: () => setModal(null),
				})
				return
			}
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
			if (key.ctrl && input.toLowerCase() === 'r') {
				scanKeyRef.current = null
				setScanNonce((n) => n + 1)
				setToast('Rescanning…')
				return
			}
			if (key.ctrl && input.toLowerCase() === 's') {
				saveConfig()
				return
			}
			return
		}

		// Long-press Tab (repeat) opens profile picker.
		if (isTab && !isShiftTab && maybeOpenProfilesByTabHold()) return

		// Profiles overlay from anywhere (jump to Packages).
		if (key.ctrl && input.toLowerCase() === 'p') {
			openProfilesOverlay()
			return
		}

		// Paths focus switching.
		if (tab === 'paths' && !key.ctrl && !key.meta && (isTab || isShiftTab)) {
			cyclePathsFocus(isShiftTab ? -1 : 1)
			return
		}
		if (tab === 'paths' && !key.ctrl && !key.meta) {
			const lower = input.toLowerCase()
			if (lower === 'r') {
				setPathsFocus('roots')
				return
			}
			if (lower === 'i') {
				setPathsFocus('include')
				return
			}
			if (lower === 'x') {
				setPathsFocus('exclude')
				return
			}
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
				defaultFocus: 'cancel',
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
		if (input === '?' && !key.ctrl && !key.meta) {
			toggleHelpOverlay()
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
		if (input.toLowerCase() === 's' && !key.ctrl && !key.meta && tab === 'paths') {
			setScope((p) => (p === 'profile' ? 'defaults' : 'profile'))
		}

		// Roots mode toggle
		if (
			tab === 'paths' &&
			pathsFocus === 'roots' &&
			input.toLowerCase() === 't' &&
			!key.ctrl &&
			!key.meta
		) {
			toggleRootsAuto()
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
			else if (!key.ctrl && !key.meta && input.toLowerCase() === 'd') setDoctorDetails((v) => !v)
		}
	})

	function setPackagesValue(enabled: string[]) {
		setCfg((prev) => {
			const profiles = { ...prev.profiles }
			const profile = profiles[activeProfile] ?? { enabled: [] }
			profiles[activeProfile] = {
				...profile,
				enabled,
			}
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
		if (target === 'roots' && normalized.length > 0) {
			if (scope === 'defaults') rememberedRootsRef.current.defaults = [...normalized]
			else rememberedRootsRef.current.profile = [...normalized]
		}
		setCfg((prev) => {
			const profiles = { ...prev.profiles }
			const profile = profiles[activeProfile] ?? { enabled: [] }
			if (scope === 'defaults') {
				const defaults = { ...prev.defaults }
				if (target === 'include') {
					if (normalized.length > 0) defaults.include = normalized
					else delete defaults.include
				} else if (target === 'exclude') {
					if (normalized.length > 0) defaults.exclude = normalized
					else delete defaults.exclude
				} else {
					// roots list only when custom; toggle handled separately
					defaults.roots = normalized.length > 0 ? normalized : 'auto'
				}
				return { ...prev, defaults, profiles }
			}

			if (target === 'include') {
				profiles[activeProfile] = {
					...profile,
					...(normalized.length > 0 ? { include: normalized } : {}),
				}
				if (normalized.length === 0) delete profiles[activeProfile].include
			} else if (target === 'exclude') {
				profiles[activeProfile] = {
					...profile,
					...(normalized.length > 0 ? { exclude: normalized } : {}),
				}
				if (normalized.length === 0) delete profiles[activeProfile].exclude
			} else {
				profiles[activeProfile] = { ...profile, roots: normalized.length > 0 ? normalized : 'auto' }
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
			if (remembered.length > 0) {
				setListForScope('roots', remembered)
				setToast('Roots: custom')
				return
			}
			setToast('Roots is auto. Add a root to switch to custom.')
			return
		}

		const list = current
		if (list.length > 0) {
			if (scope === 'defaults') rememberedRootsRef.current.defaults = [...list]
			else rememberedRootsRef.current.profile = [...list]
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
		return remembered.length > 0 ? remembered : []
	}

	// Auto-open flows used by focused HMR commands.
	useEffect(() => {
		if (!initialOpen) return
		if (modal) return
		if (initialOpen.kind === 'packages') {
			setTab('packages')
			setInitialOpen(null)
			return
		}
		if (initialOpen.kind === 'profiles') {
			setTab('packages')
			setOverlay('profiles')
			setInitialOpen(null)
			return
		}
		if (initialOpen.kind === 'paths') {
			setTab('paths')
			setPathsFocus(initialOpen.focus ?? 'roots')
			setInitialOpen(null)
		}
	}, [initialOpen, modal])

	const headerRows = 2
	const footerRows = 2
	const bodyRows = Math.max(rows - headerRows - footerRows, 10)
	const packagesHeaderRows = 2
	const packagesBodyRows = Math.max(bodyRows - packagesHeaderRows, 8)
	const pathsHeaderRows = 2
	const pathsBodyRows = Math.max(bodyRows - pathsHeaderRows, 8)
	const doctorWindowRows = Math.max(bodyRows - 2, 6)

	const doctorLines = useMemo(() => {
		if (snapshot.status === 'error') return snapshot.errors
		if (snapshot.status !== 'ok') return ['(no data yet)']
		const s = snapshot.snapshot
		const lines: string[] = [
			`profile: ${s.activeProfile}`,
			`selected packages: ${s.enabled.length}`,
			`entries: ${s.enabledEntries.length} (+include ${s.includedEntries.length})`,
			`watch roots: ${s.watchRoots.length}`,
			`discovered: ${s.discovered.length}${doctorDetails ? '' : ' (d details)'}`,
			'',
		]
		if (snapshot.warnings.length > 0) {
			lines.push('Warnings:')
			for (const w of snapshot.warnings) lines.push(w)
			lines.push('')
		}
		if (doctorDetails && s.discovered.length > 0) {
			lines.push('Discovered:')
			for (const p of s.discovered.slice(0, 200)) lines.push(`${p.name} -> ${p.entry}`)
			if (s.discovered.length > 200) lines.push(`…and ${s.discovered.length - 200} more`)
		}
		return lines
	}, [snapshot, doctorDetails])

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
	const rootsCount = rootsValue === 'auto' ? 0 : rootsValue.length
	const includeCount = (includeValue ?? []).length
	const excludeCount = (excludeValue ?? []).length

	const enabledPreview = formatListInline(profile.enabled ?? [], 6)
	const pathsTabs: Array<{ key: PathsFocus; label: string }> = [
		{
			key: 'roots',
			label: rootsValue === 'auto' ? 'Roots:auto' : `Roots:${rootsCount}`,
		},
		{
			key: 'include',
			label: `Include:${includeCount}`,
		},
		{
			key: 'exclude',
			label: `Exclude:${excludeCount}`,
		},
	]

	type ProfileAction =
		| { type: 'activate'; name: string }
		| { type: 'create' }
		| { type: 'rename'; from: string }
		| { type: 'clone'; from: string }
		| { type: 'delete'; name: string }

	function handleProfileAction(act: ProfileAction) {
		const names = profileNames

		if (act.type === 'activate') {
			setActiveProfile(act.name)
			return
		}

		if (act.type === 'create') {
			setModal({
				kind: 'input',
				title: 'New profile',
				message: 'Enter profile name',
				placeholder: 'hmr',
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
						const cloned = JSON.parse(
							JSON.stringify(data),
						) as PluxelLoaderHmrConfigV2['profiles'][string]
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
			const nextActive = names.find((name) => name !== act.name) ?? activeProfile
			setModal({
				kind: 'confirm',
				title: 'Delete profile',
				message: `Delete "${act.name}"?`,
				confirmLabel: 'Delete',
				cancelLabel: 'Cancel',
				defaultFocus: 'cancel',
				onConfirm: () => {
					setModal(null)
					setCfg((prev) => {
						const next = { ...prev.profiles }
						delete next[act.name]
						const remaining = Object.keys(next).sort((a, b) => a.localeCompare(b))
						const nextProfile = remaining[0] ?? prev.profile
						return {
							...prev,
							profiles: next,
							profile: prev.profile === act.name ? nextProfile : prev.profile,
						}
					})
					setActiveProfile((p) => (p === act.name ? nextActive : p))
					setDirty(true)
				},
				onCancel: () => setModal(null),
			})
		}
	}

	const profilePos = Math.max(profileNames.indexOf(activeProfile), 0) + 1
	const profileBadge =
		profileNames.length > 0
			? `${activeProfile} (${profilePos}/${profileNames.length})`
			: activeProfile
	const enabledCount = (profile.enabled ?? []).length
	const scanInfo =
		scan.status === 'ready'
			? {
					total: scan.discovered.length,
					visible: scan.discoveredForUi.length,
					roots: scan.rootsExpandedAbs.length,
				}
			: null
	const scanSummary = scanInfo
		? `scan: visible ${scanInfo.visible}${
				scanInfo.visible !== scanInfo.total
					? ` / total ${scanInfo.total} • hidden ${scanInfo.total - scanInfo.visible}`
					: ''
			} • roots ${scanInfo.roots}`
		: null

	const scanPart =
		scan.status === 'error'
			? { text: 'scan error', color: 'red' as const }
			: scan.status === 'scanning'
				? { text: `scan ${scan.phase}`, color: 'yellow' as const }
				: scan.status === 'ready'
					? { text: 'scan ok', color: 'gray' as const }
					: { text: 'scan idle', color: 'gray' as const }
	const snapshotPart =
		snapshot.status === 'error'
			? { text: `snapshot blocked (${snapshot.errors.length})`, color: 'red' as const }
			: snapshot.status === 'building'
				? { text: 'snapshot building', color: 'yellow' as const }
				: snapshot.status === 'ok'
					? { text: 'snapshot ok', color: 'gray' as const }
					: { text: 'snapshot idle', color: 'gray' as const }
	const statusParts = [
		{ key: 'scan', ...scanPart },
		{ key: 'snapshot', ...snapshotPart },
	]
	const doctorWindow = doctorLines.slice(doctorOffset, doctorOffset + doctorWindowRows)
	const doctorWindowEntries = doctorWindow.map((line, windowIndex) => ({
		key: String(doctorOffset + windowIndex),
		line,
	}))

	return (
		<Box flexDirection="column" width="100%">
			<TabBar tabs={tabList} active={tab} />
			<Text>
				<Text color="gray">Profile </Text>
				<Text color="cyan">{` ${profileBadge} `}</Text>
				{dirty ? <Text color="yellow">{' unsaved '}</Text> : <Text color="gray"> </Text>}
				{tab !== 'packages' ? <Text color="gray">{` selected ${enabledCount}`}</Text> : null}
				<Text color="gray"> • </Text>
				{statusParts.map((part, i) => {
					return (
						<Text key={part.key}>
							<Text color={part.color}>{part.text}</Text>
							{i < statusParts.length - 1 ? <Text color="gray"> • </Text> : null}
						</Text>
					)
				})}
			</Text>

			<Box flexDirection="column" flexGrow={1} height={bodyRows}>
				{tab === 'packages' ? (
					<Box flexDirection="column" width="100%">
						<Text color="gray">Enter/Space toggle • / filter • Tab(hold) profiles</Text>
						{scanSummary ? <Text color="gray">{scanSummary}</Text> : null}
						{scan.status === 'ready' ? (
							<PickPackagesBrowser
								discovered={scan.discoveredForUi}
								enabled={profile.enabled ?? []}
								height={packagesBodyRows}
								disabled={Boolean(modal) || Boolean(overlay)}
								onTypingChange={setTyping}
								onChange={setPackagesValue}
							/>
						) : (
							<Text color="gray">
								{scan.status === 'scanning' ? `Scanning… ${scan.phase}` : 'Waiting for scan…'}
							</Text>
						)}
					</Box>
				) : null}

				{tab === 'paths' ? (
					<Box flexDirection="column" width="100%">
						<Text>
							{pathsTabs.map((p, i) => {
								const active = p.key === pathsFocus
								return (
									<Text key={p.key}>
										<Text
											color={active ? 'black' : 'gray'}
											backgroundColor={active ? 'cyan' : undefined}
										>
											{` ${p.label} `}
										</Text>
										{i < pathsTabs.length - 1 ? <Text color="gray"> </Text> : null}
									</Text>
								)
							})}
						</Text>
						<Text color="gray">
							scope={scope} • Tab/Shift+Tab switch • r/i/x focus • s scope toggle
							{pathsFocus === 'roots' ? ' • t roots auto' : ''}
						</Text>
						{pathsFocus === 'roots' ? (
							<StringListPanel
								title={`Roots (${scope}) • mode=${rootsValue === 'auto' ? 'auto' : 'custom'}`}
								height={pathsBodyRows}
								placeholder="root folder"
								items={editableRootsList()}
								disabled={Boolean(modal) || Boolean(overlay)}
								onTypingChange={setTyping}
								onChange={(next) => {
									setListForScope('roots', next)
									setToast(next.length > 0 ? 'Roots: custom' : 'Roots: auto')
								}}
							/>
						) : pathsFocus === 'include' ? (
							<StringListPanel
								title={`Include (${scope})`}
								height={pathsBodyRows}
								placeholder="glob"
								items={listForScope('include')}
								disabled={Boolean(modal) || Boolean(overlay)}
								onTypingChange={setTyping}
								onChange={(next) => setListForScope('include', next)}
							/>
						) : (
							<StringListPanel
								title={`Exclude (${scope})`}
								height={pathsBodyRows}
								placeholder="glob"
								items={listForScope('exclude')}
								disabled={Boolean(modal) || Boolean(overlay)}
								onTypingChange={setTyping}
								onChange={(next) => setListForScope('exclude', next)}
							/>
						)}
					</Box>
				) : null}

				{tab === 'snapshot' ? (
					<Box flexDirection="column" width="100%">
						<Text>Snapshot</Text>
						<Text color="gray">Ctrl+S save • Ctrl+R rescan • Ctrl+←/→ tabs • q/Ctrl+C exit</Text>
						<Text>selected packages: {enabledPreview}</Text>
						<Text>
							roots({scope}): {rootsValue === 'auto' ? 'auto' : `${rootsCount} item(s)`}
						</Text>
						<Text>
							include({scope}): {includeCount} • exclude({scope}): {excludeCount}
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
						<Text color="gray">↑/↓ scroll • d details • Ctrl+R rescan • Ctrl+←/→ tabs</Text>
						<Box borderStyle="round" borderColor="gray" flexDirection="column" flexGrow={1}>
							{doctorWindowEntries.map((entry) => (
								<Text key={entry.key} wrap="truncate">
									{entry.line}
								</Text>
							))}
						</Box>
					</Box>
				) : null}
			</Box>

			<Text color={toast ? 'yellow' : 'gray'} wrap="truncate">
				{toast || `Tab ${tabIndex + 1}/${tabList.length} • ? help`}
			</Text>
			<Text color="gray" wrap="truncate">
				{
					'Keys: Ctrl+S save • Ctrl+R rescan • Ctrl+←/→ tabs • Ctrl+P profiles • Tab(hold) profiles • ? help • q quit'
				}
			</Text>

			<ScreenMask visible={Boolean(overlay) || Boolean(modal)} />
			{overlay === 'profiles' ? (
				<ProfilesOverlay
					active={activeProfile}
					profiles={profileNames}
					disabled={Boolean(modal)}
					onClose={() => setOverlay(null)}
					onAction={handleProfileAction}
				/>
			) : null}
			{overlay === 'help' ? <HelpOverlay tab={tab} onClose={() => setOverlay(null)} /> : null}
			{modal ? <ModalOverlay modal={modal} /> : null}
		</Box>
	)
}

function ProfilesOverlay(props: {
	active: string
	profiles: string[]
	disabled: boolean
	onClose: () => void
	onAction: Parameters<typeof ProfilesPanel>[0]['onAction']
}) {
	const { stdout } = useStdout()
	const rows = stdout?.rows ?? 24
	const columns = stdout?.columns ?? 80
	const height = Math.max(Math.min(rows - 4, 16), 10)

	const [query, setQuery] = useState('')
	const [searching, setSearching] = useState(false)

	const filteredProfiles = useMemo(() => {
		const q = query.trim().toLowerCase()
		if (!q) return props.profiles
		return props.profiles.filter((p) => p.toLowerCase().includes(q))
	}, [props.profiles, query])

	const quickPick = (idx: number) => {
		const name = filteredProfiles[idx]
		if (!name) return
		props.onAction({ type: 'activate', name })
		props.onClose()
	}

	useInput((input, key) => {
		if (props.disabled) return
		if (key.ctrl && input.toLowerCase() === 'p') {
			props.onClose()
			return
		}
		if (key.escape || (key.ctrl && input.toLowerCase() === 'c')) {
			props.onClose()
			return
		}

		if (searching) {
			if (key.return) {
				setSearching(false)
				return
			}
			if (key.backspace || key.delete) {
				setQuery((s) => s.slice(0, -1))
				return
			}
			if (key.ctrl && input.toLowerCase() === 'u') {
				setQuery('')
				return
			}
			if (key.ctrl || key.meta) return
			if (input && input.length === 1) {
				setQuery((s) => s + input)
			}
			return
		}

		if (!key.ctrl && !key.meta && input === '/') {
			setSearching(true)
			return
		}

		if (!key.ctrl && !key.meta && /^[1-9]$/.test(input)) {
			quickPick(Number(input) - 1)
			return
		}
		if (!key.ctrl && !key.meta && input === '0') {
			quickPick(9)
			return
		}

		if (key.return) {
			props.onClose()
		}
	})

	return (
		<Box
			position="absolute"
			marginTop={1}
			marginLeft={2}
			width={Math.max(columns - 4, 1)}
			height={height}
			borderStyle="round"
			borderColor="cyan"
			backgroundColor="black"
			paddingX={1}
			flexDirection="column"
		>
			<Text color="cyan" wrap="truncate">
				Profiles{' '}
				<Text color="black" backgroundColor="cyan">
					{` ${props.active} `}
				</Text>
				<Text color="gray">
					{' '}
					• 1-9/0 pick • / search • ↑/↓ activate • n new • r rename • c clone • x delete • Enter/Esc
					close
				</Text>
			</Text>
			<Text color="gray" wrap="truncate">
				<Text color={searching ? 'black' : 'gray'} backgroundColor={searching ? 'cyan' : undefined}>
					{' Search '}
				</Text>
				<Text color="gray">{`: ${query}`}</Text>
				{searching ? '▊' : query ? '' : ' (press / to search)'}
				<Text color="gray">{` • ${filteredProfiles.length}/${props.profiles.length}`}</Text>
			</Text>
			<ProfilesPanel
				active={props.active}
				profiles={filteredProfiles}
				height={height - 2}
				disabled={props.disabled}
				autoActivate
				hotkeysDisabled={searching}
				showHeader={false}
				bordered={false}
				onAction={props.onAction}
			/>
		</Box>
	)
}

function HelpKey(props: { children: string }) {
	return (
		<Text color="black" backgroundColor="cyan">
			{` ${props.children} `}
		</Text>
	)
}

function HelpOverlay(props: { tab: TabKey; onClose: () => void }) {
	const { stdout } = useStdout()
	const rows = stdout?.rows ?? 24
	const columns = stdout?.columns ?? 80
	const height = Math.max(Math.min(rows - 4, 14), 10)

	useInput((input, key) => {
		if (key.escape || (key.ctrl && input.toLowerCase() === 'c') || input === '?') {
			props.onClose()
		}
	})

	const tabName = tabLabel(props.tab)
	const tabLine =
		props.tab === 'packages' ? (
			<Text color="gray">
				<HelpKey>Enter/Space</HelpKey> toggle • <HelpKey>j/k</HelpKey> move • <HelpKey>/</HelpKey>{' '}
				filter • <HelpKey>e</HelpKey> mode • <HelpKey>Tab(hold)</HelpKey> profiles •{' '}
				<HelpKey>Ctrl+P</HelpKey> profiles
			</Text>
		) : props.tab === 'paths' ? (
			<Text color="gray">
				<HelpKey>Tab/Shift+Tab</HelpKey> section • <HelpKey>r/i/x</HelpKey> focus •{' '}
				<HelpKey>s</HelpKey> scope • <HelpKey>t</HelpKey> roots auto • <HelpKey>Enter</HelpKey> edit
			</Text>
		) : props.tab === 'doctor' ? (
			<Text color="gray">
				<HelpKey>↑/↓</HelpKey> scroll • <HelpKey>d</HelpKey> details
			</Text>
		) : (
			<Text color="gray">Snapshot summary • blocked → check Doctor</Text>
		)

	return (
		<Box
			position="absolute"
			marginTop={1}
			marginLeft={2}
			width={Math.max(columns - 4, 1)}
			height={height}
			borderStyle="round"
			borderColor="magenta"
			backgroundColor="black"
			paddingX={1}
			flexDirection="column"
		>
			<Text color="magenta" wrap="truncate">
				Help ({tabName}) • ?/Esc to close
			</Text>
			<Text color="cyan">Global</Text>
			<Text color="gray">
				<HelpKey>Ctrl+←/→</HelpKey> tabs • <HelpKey>Ctrl+S</HelpKey> save •{' '}
				<HelpKey>Ctrl+R</HelpKey> rescan • <HelpKey>Ctrl+P</HelpKey> profiles •{' '}
				<HelpKey>Tab(hold)</HelpKey> profiles • <HelpKey>q</HelpKey> quit
			</Text>
			<Text color="cyan">{tabName}</Text>
			{tabLine}
		</Box>
	)
}

export async function runLoaderHmrPromptTui(params: {
	rootDir: string
	configPath: string
	env: Record<string, string | undefined>
	diagnose: LoaderHmrDiagnoseModule
	skipPackages: Set<string>
	initialTab?: TabKey
	initialOpen?: InitialOpen
}): Promise<PromptResult> {
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		throw new Error('Interactive `pluxel hmr` requires a TTY.')
	}

	let initialCfg: PluxelLoaderHmrConfigV2
	let initialProfile = 'hmr'
	let initialDirty = false
	let initialParseError: string | null = null

	if (!existsSync(params.configPath)) {
		initialCfg = params.diagnose.createDefaultLoaderHmrConfigV2()
		initialProfile = params.env.PLUXEL_HMR_PROFILE ?? initialCfg.profile
		initialDirty = true
	} else {
		try {
			initialCfg = params.diagnose.readLoaderHmrConfigV2(params.configPath)
			initialProfile = params.env.PLUXEL_HMR_PROFILE ?? initialCfg.profile
		} catch (e) {
			initialCfg = params.diagnose.createDefaultLoaderHmrConfigV2()
			initialProfile = initialCfg.profile
			initialDirty = false
			initialParseError = e instanceof Error ? e.message : String(e)
		}
	}

	// Ensure at least one profile exists.
	if (Object.keys(initialCfg.profiles).length === 0) {
		initialCfg.profiles.hmr = { enabled: [] }
		initialCfg.profile = 'hmr'
		initialProfile = 'hmr'
		initialDirty = true
	}

	const defaultInitialOpen: InitialOpen | undefined = (() => {
		// First-time setup: prompt user to pick packages instead of a blank snapshot screen.
		if (!existsSync(params.configPath)) return { kind: 'packages' }
		return undefined
	})()

	return new Promise<PromptResult>((resolvePromise, reject) => {
		let resolved = false
		const { waitUntilExit, unmount } = render(
			<LoaderHmrPromptApp
				rootDir={params.rootDir}
				configPath={params.configPath}
				env={params.env}
				diagnose={params.diagnose}
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
