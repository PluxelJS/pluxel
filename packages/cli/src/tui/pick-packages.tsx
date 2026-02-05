import { Box, render, Text, useInput, useStdout } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'

export type PickPackagesDiscoveredPlugin = { name: string; entry: string; pkgDir: string }

function normalizePath(p: string) {
	return p.replace(/\\/g, '/')
}

function groupKeyForPkgDir(pkgDir: string) {
	const dir = normalizePath(pkgDir)
	if (!dir || dir === '.') return '.'
	const parts = dir.split('/').filter(Boolean)
	if (parts.length <= 1) return '.'
	return parts.slice(0, -1).join('/')
}

function parseFilterQuery(raw: string) {
	const tokens = String(raw ?? '')
		.trim()
		.split(/\s+/g)
		.filter(Boolean)

	const include: string[] = []
	const exclude: string[] = []
	for (const t of tokens) {
		if (t.startsWith('!') && t.length > 1) exclude.push(t.slice(1).toLowerCase())
		else include.push(t.toLowerCase())
	}
	return { include, exclude }
}

function filterDiscovered(discovered: PickPackagesDiscoveredPlugin[], query: string) {
	const { include, exclude } = parseFilterQuery(query)
	if (!include.length && !exclude.length) return discovered

	return discovered.filter((p) => {
		const hay = `${p.name}\n${p.pkgDir}\n${p.entry}`.toLowerCase()
		for (const ex of exclude) if (hay.includes(ex)) return false
		for (const inc of include) if (!hay.includes(inc)) return false
		return true
	})
}

function formatPreviewNames(names: string[], max = 2) {
	const head = names.slice(0, max)
	const rest = names.length - head.length
	return rest > 0 ? `${head.join(', ')}, +${rest}` : head.join(', ')
}

type GroupInfo = {
	key: string
	label: string
	total: number
	selectedCount: number
	enabledCount?: number
	builtinCount?: number
	previewNames: string[]
}

function buildGroups(discovered: PickPackagesDiscoveredPlugin[], selected: Set<string>) {
	const byGroup = new Map<string, PickPackagesDiscoveredPlugin[]>()
	for (const p of discovered) {
		const key = groupKeyForPkgDir(p.pkgDir)
		const list = byGroup.get(key)
		if (list) list.push(p)
		else byGroup.set(key, [p])
	}

	const keys = [...byGroup.keys()].sort((a, b) => a.localeCompare(b))
	const groups: GroupInfo[] = keys.map((key) => {
		const items = (byGroup.get(key) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
		const total = items.length
		const selectedCount = items.reduce((n, it) => n + (selected.has(it.name) ? 1 : 0), 0)
		const labelBase = key === '.' ? '(root)' : key
		const previewNames = items.map((it) => it.name)
		return {
			key,
			label: `${labelBase} (${selectedCount}/${total})`,
			total,
			selectedCount,
			previewNames,
		}
	})

	const allTotal = discovered.length
	const allSelected = discovered.reduce((n, it) => n + (selected.has(it.name) ? 1 : 0), 0)
	const allPreviewNames = discovered.map((it) => it.name).sort((a, b) => a.localeCompare(b))
	return [
		{
			key: '__ALL__',
			label: `(all) (${allSelected}/${allTotal})`,
			total: allTotal,
			selectedCount: allSelected,
			previewNames: allPreviewNames,
		},
		...groups,
	]
}

type PickPackagesMode = 'enabled' | 'builtin'

function buildGroupsDual(
	discovered: PickPackagesDiscoveredPlugin[],
	enabled: Set<string>,
	builtin: Set<string>,
) {
	const byGroup = new Map<string, PickPackagesDiscoveredPlugin[]>()
	for (const p of discovered) {
		const key = groupKeyForPkgDir(p.pkgDir)
		const list = byGroup.get(key)
		if (list) list.push(p)
		else byGroup.set(key, [p])
	}

	const keys = [...byGroup.keys()].sort((a, b) => a.localeCompare(b))
	const groups: GroupInfo[] = keys.map((key) => {
		const items = (byGroup.get(key) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name))
		const total = items.length
		const enabledCount = items.reduce((n, it) => n + (enabled.has(it.name) ? 1 : 0), 0)
		const builtinCount = items.reduce((n, it) => n + (builtin.has(it.name) ? 1 : 0), 0)
		const selectedCount = enabledCount + builtinCount
		const labelBase = key === '.' ? '(root)' : key
		const previewNames = items.map((it) => it.name)
		return {
			key,
			label: `${labelBase} (E${enabledCount} B${builtinCount} / ${total})`,
			total,
			selectedCount,
			enabledCount,
			builtinCount,
			previewNames,
		}
	})

	const allTotal = discovered.length
	const allEnabled = discovered.reduce((n, it) => n + (enabled.has(it.name) ? 1 : 0), 0)
	const allBuiltin = discovered.reduce((n, it) => n + (builtin.has(it.name) ? 1 : 0), 0)
	const allSelected = allEnabled + allBuiltin
	const allPreviewNames = discovered.map((it) => it.name).sort((a, b) => a.localeCompare(b))
	return [
		{
			key: '__ALL__',
			label: `(all) (E${allEnabled} B${allBuiltin} / ${allTotal})`,
			total: allTotal,
			selectedCount: allSelected,
			enabledCount: allEnabled,
			builtinCount: allBuiltin,
			previewNames: allPreviewNames,
		},
		...groups,
	]
}

function clamp(n: number, min: number, max: number) {
	return Math.max(min, Math.min(max, n))
}

function ensureVisibleWindow(params: {
	count: number
	index: number
	window: number
	offset: number
}) {
	const { count, index, window } = params
	if (window <= 0) return 0
	const maxOffset = Math.max(count - window, 0)
	let offset = clamp(params.offset, 0, maxOffset)
	if (index < offset) offset = index
	else if (index >= offset + window) offset = index - window + 1
	return clamp(offset, 0, maxOffset)
}

function setHasAnyInList(names: string[], selected: Set<string>) {
	for (const n of names) if (selected.has(n)) return true
	return false
}

export type PickPackagesParams = {
	title: string
	message: string
	discovered: PickPackagesDiscoveredPlugin[]
	initialSelected: string[]
}

type Focus = 'filter' | 'groups' | 'packages'

export function PickPackagesPicker(props: {
	params: PickPackagesParams
	onDone: (result: string[] | null) => void
}) {
	const { stdout } = useStdout()

	const discoveredSorted = useMemo(
		() =>
			props.params.discovered
				.slice()
				.sort((a, b) => a.pkgDir.localeCompare(b.pkgDir) || a.name.localeCompare(b.name)),
		[props.params.discovered],
	)

	const discoveredSet = useMemo(
		() => new Set(discoveredSorted.map((p) => p.name)),
		[discoveredSorted],
	)
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(props.params.initialSelected.filter((n) => discoveredSet.has(n))),
	)

	const [filter, setFilter] = useState('')
	const filtered = useMemo(
		() => filterDiscovered(discoveredSorted, filter),
		[discoveredSorted, filter],
	)

	const [activeGroupKey, setActiveGroupKey] = useState<string>('__ALL__')
	const [focus, setFocus] = useState<Focus>('packages')

	// Indices & scroll offsets.
	const groups = useMemo(() => buildGroups(filtered, selected), [filtered, selected])
	const [groupIndex, setGroupIndex] = useState(0)
	const [groupOffset, setGroupOffset] = useState(0)
	const [pkgIndex, setPkgIndex] = useState(0)
	const [pkgOffset, setPkgOffset] = useState(0)

	// Keep groupIndex/activeGroupKey consistent across filter changes.
	useEffect(() => {
		const foundIdx = groups.findIndex((g) => g.key === activeGroupKey)
		const nextIdx = foundIdx >= 0 ? foundIdx : 0
		setGroupIndex(nextIdx)
		setActiveGroupKey(groups[nextIdx]?.key ?? '__ALL__')
	}, [groups, activeGroupKey])

	const packagesInGroup = useMemo(() => {
		const list =
			activeGroupKey === '__ALL__'
				? filtered
				: filtered.filter((p) => groupKeyForPkgDir(p.pkgDir) === activeGroupKey)
		return list.slice().sort((a, b) => a.name.localeCompare(b.name))
	}, [filtered, activeGroupKey])

	// Clamp package index when switching groups / filter.
	useEffect(() => {
		setPkgIndex((idx) => clamp(idx, 0, Math.max(packagesInGroup.length - 1, 0)))
	}, [packagesInGroup.length])

	// Window sizing based on terminal rows.
	const rows = stdout?.rows ?? 24
	const headerRows = 3
	const filterRows = 1
	const footerRows = 2
	const bodyRows = Math.max(rows - headerRows - filterRows - footerRows, 5)
	const listRows = Math.max(bodyRows - 2, 3) // account for borders/labels

	useEffect(() => {
		setGroupOffset((o) =>
			ensureVisibleWindow({ count: groups.length, index: groupIndex, window: listRows, offset: o }),
		)
	}, [groups.length, groupIndex, listRows])

	useEffect(() => {
		setPkgOffset((o) =>
			ensureVisibleWindow({
				count: packagesInGroup.length,
				index: pkgIndex,
				window: listRows,
				offset: o,
			}),
		)
	}, [packagesInGroup.length, pkgIndex, listRows])

	const doneRef = useRef(false)
	function finish(result: string[] | null) {
		if (doneRef.current) return
		doneRef.current = true
		props.onDone(result)
	}

	function toggleName(name: string) {
		setSelected((prev) => {
			const next = new Set(prev)
			if (next.has(name)) next.delete(name)
			else next.add(name)
			return next
		})
	}

	function toggleMany(names: string[], enable: boolean) {
		setSelected((prev) => {
			const next = new Set(prev)
			for (const n of names) {
				if (enable) next.add(n)
				else next.delete(n)
			}
			return next
		})
	}

	function invertMany(names: string[]) {
		setSelected((prev) => {
			const next = new Set(prev)
			for (const n of names) {
				if (next.has(n)) next.delete(n)
				else next.add(n)
			}
			return next
		})
	}

	useInput((input, key) => {
		if (doneRef.current) return
		// Cancel / Confirm
		if (key.escape || (key.ctrl && input === 'c')) {
			finish(null)
			return
		}
		if (key.ctrl && input.toLowerCase() === 's') {
			finish([...selected].sort((a, b) => a.localeCompare(b)))
			return
		}

		// Focus shortcuts
		if (input === '\t') {
			setFocus((f) => (f === 'filter' ? 'groups' : f === 'groups' ? 'packages' : 'filter'))
			return
		}
		if (input === '/' && !key.ctrl && !key.meta) {
			setFocus('filter')
			return
		}
		if (!key.ctrl && !key.meta && focus !== 'filter' && key.leftArrow) {
			setFocus('groups')
			return
		}
		if (!key.ctrl && !key.meta && focus !== 'filter' && key.rightArrow) {
			setFocus('packages')
			return
		}

		// Filter editing
		if (focus === 'filter') {
			if (key.return) {
				setFocus('packages')
				return
			}
			if (key.backspace || key.delete) {
				setFilter((s) => s.slice(0, -1))
				return
			}
			if (key.ctrl && input.toLowerCase() === 'u') {
				setFilter('')
				return
			}
			// Ignore control sequences.
			if (key.ctrl || key.meta) return
			if (input && input.length === 1) {
				setFilter((s) => s + input)
			}
			return
		}

		// Helpers (apply to visible group list)
		const visibleNames = packagesInGroup.map((p) => p.name)
		if (input === 'c' && !key.ctrl && !key.meta) {
			setSelected(new Set())
			return
		}
		if (input === 'a' && !key.ctrl && !key.meta) {
			if (visibleNames.length) toggleMany(visibleNames, true)
			return
		}
		if (input === 'i' && !key.ctrl && !key.meta) {
			if (visibleNames.length) invertMany(visibleNames)
			return
		}
		if (input === 'g' && !key.ctrl && !key.meta) {
			if (!visibleNames.length) return
			const any = setHasAnyInList(visibleNames, selected)
			toggleMany(visibleNames, !any)
			return
		}

		// Group navigation
		if (focus === 'groups') {
			if (key.upArrow) {
				setGroupIndex((i) => clamp(i - 1, 0, Math.max(groups.length - 1, 0)))
				return
			}
			if (key.downArrow) {
				setGroupIndex((i) => clamp(i + 1, 0, Math.max(groups.length - 1, 0)))
				return
			}
			if (key.return) {
				const g = groups[groupIndex]
				if (g) setActiveGroupKey(g.key)
				setFocus('packages')
				return
			}
			return
		}

		// Package navigation / selection
		if (focus === 'packages') {
			if (key.upArrow) {
				setPkgIndex((i) => clamp(i - 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.downArrow) {
				setPkgIndex((i) => clamp(i + 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.return || input === ' ') {
				const p = packagesInGroup[pkgIndex]
				if (!p) return
				toggleName(p.name)
				return
			}
		}
	})

	// Apply selected group index → active group key (when focus is groups and user moves).
	useEffect(() => {
		const g = groups[groupIndex]
		if (!g) return
		setActiveGroupKey(g.key)
	}, [groupIndex, groups])

	const groupCount = useMemo(
		() => new Set(filtered.map((p) => groupKeyForPkgDir(p.pkgDir))).size,
		[filtered],
	)
	const groupLabel = activeGroupKey === '__ALL__' ? '(all)' : activeGroupKey || '(none)'
	const filterLabel = filter ? `filter="${filter}"` : 'filter=(none)'

	const groupWindow = groups.slice(groupOffset, groupOffset + listRows)
	const pkgWindow = packagesInGroup.slice(pkgOffset, pkgOffset + listRows)
	const previewMax = groups.length <= listRows ? 8 : 2

	const currentPkg = packagesInGroup[pkgIndex]
	const currentPkgDesc = currentPkg ? currentPkg.entry : ''

	const focusTag = (tag: Focus) => (focus === tag ? '*' : ' ')

	return (
		<Box flexDirection="column" width="100%">
			<Text>
				{props.params.title}
				{'\n'}
				{props.params.message}
			</Text>
			<Text color="gray">
				selected={selected.size} • visible={filtered.length} • groups={groupCount} • group=
				{groupLabel} • {filterLabel}
			</Text>
			<Text>
				{focusTag('filter')} Filter: {filter}
				{focus === 'filter' ? '▊' : filter ? '' : ' (type to filter; use !token to exclude)'}
			</Text>

			<Box flexDirection="row" width="100%" height={bodyRows}>
				<Box flexDirection="column" width="35%" borderStyle="round" borderColor="gray">
					<Text>{focusTag('groups')} Folders</Text>
					{groupWindow.map((g, i) => {
						const idx = groupOffset + i
						const active = idx === groupIndex
						const line = `${active ? '›' : ' '} ${g.label}`
						return (
							<Text key={g.key} color={active ? 'cyan' : undefined} wrap="truncate">
								{line}
								{'  '}
								<Text color="gray">{formatPreviewNames(g.previewNames, previewMax)}</Text>
							</Text>
						)
					})}
				</Box>

				<Box
					flexDirection="column"
					flexGrow={1}
					marginLeft={1}
					borderStyle="round"
					borderColor="gray"
				>
					<Text>{focusTag('packages')} Packages</Text>
					{pkgWindow.map((p, i) => {
						const idx = pkgOffset + i
						const active = idx === pkgIndex
						const checked = selected.has(p.name)
						const line = `${active ? '›' : ' '} ${checked ? '[x]' : '[ ]'} ${p.name}`
						return (
							<Text key={p.name} color={active ? 'cyan' : undefined} wrap="truncate">
								{line}
							</Text>
						)
					})}
				</Box>
			</Box>

			<Text color="gray" wrap="truncate">
				{currentPkgDesc}
			</Text>
			<Text color="gray" wrap="truncate">
				Tab focus • / filter • ←/→ pane • ↑/↓ move • Enter/Space toggle • g group • a all • i invert
				• c clear • Ctrl+S confirm • Esc/Ctrl+C cancel • Ctrl+U clear filter
			</Text>
		</Box>
	)
}

export async function pickPackagesTui(params: PickPackagesParams): Promise<string[] | null> {
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		throw new Error('TUI requires a TTY (interactive terminal).')
	}

	return new Promise<string[] | null>((resolve, reject) => {
		let resolved = false
		const { waitUntilExit, unmount } = render(
			<PickPackagesPicker
				params={params}
				onDone={(result) => {
					if (resolved) return
					resolved = true
					resolve(result)
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

export type PickPackagesDualParams = {
	title: string
	message: string
	discovered: PickPackagesDiscoveredPlugin[]
	initialEnabled: string[]
	initialBuiltin: string[]
	initialMode?: PickPackagesMode
}

export function PickPackagesDualPicker(props: {
	params: PickPackagesDualParams
	onDone: (result: { enabled: string[]; builtin: string[] } | null) => void
}) {
	const { stdout } = useStdout()

	const discoveredSorted = useMemo(
		() =>
			props.params.discovered
				.slice()
				.sort((a, b) => a.pkgDir.localeCompare(b.pkgDir) || a.name.localeCompare(b.name)),
		[props.params.discovered],
	)

	const discoveredSet = useMemo(
		() => new Set(discoveredSorted.map((p) => p.name)),
		[discoveredSorted],
	)

	type Selection = { enabled: Set<string>; builtin: Set<string> }
	const [selection, setSelection] = useState<Selection>(() => {
		const initialBuiltin = props.params.initialBuiltin.filter((n) => discoveredSet.has(n))
		const builtinSet = new Set(initialBuiltin)
		const initialEnabled = props.params.initialEnabled
			.filter((n) => discoveredSet.has(n))
			.filter((n) => !builtinSet.has(n))
		return { enabled: new Set(initialEnabled), builtin: new Set(initialBuiltin) }
	})
	const enabled = selection.enabled
	const builtin = selection.builtin

	const [mode, setMode] = useState<PickPackagesMode>(props.params.initialMode ?? 'enabled')
	const [filter, setFilter] = useState('')
	const filtered = useMemo(
		() => filterDiscovered(discoveredSorted, filter),
		[discoveredSorted, filter],
	)

	const [activeGroupKey, setActiveGroupKey] = useState<string>('__ALL__')
	const [focus, setFocus] = useState<Focus>('packages')

	// Indices & scroll offsets.
	const groups = useMemo(
		() => buildGroupsDual(filtered, enabled, builtin),
		[filtered, enabled, builtin],
	)
	const [groupIndex, setGroupIndex] = useState(0)
	const [groupOffset, setGroupOffset] = useState(0)
	const [pkgIndex, setPkgIndex] = useState(0)
	const [pkgOffset, setPkgOffset] = useState(0)

	// Keep groupIndex/activeGroupKey consistent across filter changes.
	useEffect(() => {
		const foundIdx = groups.findIndex((g) => g.key === activeGroupKey)
		const nextIdx = foundIdx >= 0 ? foundIdx : 0
		setGroupIndex(nextIdx)
		setActiveGroupKey(groups[nextIdx]?.key ?? '__ALL__')
	}, [groups, activeGroupKey])

	const packagesInGroup = useMemo(() => {
		const list =
			activeGroupKey === '__ALL__'
				? filtered
				: filtered.filter((p) => groupKeyForPkgDir(p.pkgDir) === activeGroupKey)
		return list.slice().sort((a, b) => a.name.localeCompare(b.name))
	}, [filtered, activeGroupKey])

	// Clamp package index when switching groups / filter.
	useEffect(() => {
		setPkgIndex((idx) => clamp(idx, 0, Math.max(packagesInGroup.length - 1, 0)))
	}, [packagesInGroup.length])

	// Window sizing based on terminal rows.
	const rows = stdout?.rows ?? 24
	const headerRows = 3
	const filterRows = 1
	const footerRows = 2
	const bodyRows = Math.max(rows - headerRows - filterRows - footerRows, 5)
	const listRows = Math.max(bodyRows - 2, 3) // account for borders/labels

	useEffect(() => {
		setGroupOffset((o) =>
			ensureVisibleWindow({ count: groups.length, index: groupIndex, window: listRows, offset: o }),
		)
	}, [groups.length, groupIndex, listRows])

	useEffect(() => {
		setPkgOffset((o) =>
			ensureVisibleWindow({
				count: packagesInGroup.length,
				index: pkgIndex,
				window: listRows,
				offset: o,
			}),
		)
	}, [packagesInGroup.length, pkgIndex, listRows])

	const doneRef = useRef(false)
	function finish(result: { enabled: string[]; builtin: string[] } | null) {
		if (doneRef.current) return
		doneRef.current = true
		props.onDone(result)
	}

	function toggleName(name: string) {
		setSelection((prev) => {
			const nextEnabled = new Set(prev.enabled)
			const nextBuiltin = new Set(prev.builtin)
			const active = mode === 'enabled' ? prev.enabled.has(name) : prev.builtin.has(name)
			if (active) {
				nextEnabled.delete(name)
				nextBuiltin.delete(name)
				return { enabled: nextEnabled, builtin: nextBuiltin }
			}
			if (mode === 'enabled') {
				nextEnabled.add(name)
				nextBuiltin.delete(name)
			} else {
				nextBuiltin.add(name)
				nextEnabled.delete(name)
			}
			return { enabled: nextEnabled, builtin: nextBuiltin }
		})
	}

	function applyMany(
		names: string[],
		op: 'toggle' | 'enableAll' | 'invert' | 'clear' | 'swap',
		modeOverride?: PickPackagesMode,
	) {
		setSelection((prev) => {
			const activeMode = modeOverride ?? mode
			const nextEnabled = new Set(prev.enabled)
			const nextBuiltin = new Set(prev.builtin)
			const isActive = (n: string) =>
				activeMode === 'enabled' ? prev.enabled.has(n) : prev.builtin.has(n)
			const clear = (n: string) => {
				nextEnabled.delete(n)
				nextBuiltin.delete(n)
			}
			const setToMode = (n: string) => {
				if (activeMode === 'enabled') {
					nextEnabled.add(n)
					nextBuiltin.delete(n)
				} else {
					nextBuiltin.add(n)
					nextEnabled.delete(n)
				}
			}
			const swap = (n: string) => {
				if (prev.enabled.has(n)) {
					nextEnabled.delete(n)
					nextBuiltin.add(n)
					return
				}
				if (prev.builtin.has(n)) {
					nextBuiltin.delete(n)
					nextEnabled.add(n)
				}
			}

			if (op === 'clear') {
				for (const n of names) clear(n)
				return { enabled: nextEnabled, builtin: nextBuiltin }
			}

			if (op === 'enableAll') {
				for (const n of names) setToMode(n)
				return { enabled: nextEnabled, builtin: nextBuiltin }
			}

			if (op === 'swap') {
				for (const n of names) swap(n)
				return { enabled: nextEnabled, builtin: nextBuiltin }
			}

			if (op === 'invert') {
				for (const n of names) isActive(n) ? clear(n) : setToMode(n)
				return { enabled: nextEnabled, builtin: nextBuiltin }
			}

			let any = false
			for (const n of names) {
				if (isActive(n)) {
					any = true
					break
				}
			}
			for (const n of names) any ? clear(n) : setToMode(n)
			return { enabled: nextEnabled, builtin: nextBuiltin }
		})
	}

	useInput((input, key) => {
		if (doneRef.current) return

		// Cancel / Confirm
		if (key.escape || (key.ctrl && input === 'c')) {
			finish(null)
			return
		}
		if (key.ctrl && input.toLowerCase() === 's') {
			finish({
				enabled: [...enabled].sort((a, b) => a.localeCompare(b)),
				builtin: [...builtin].sort((a, b) => a.localeCompare(b)),
			})
			return
		}

		// Mode
		if (!key.ctrl && !key.meta && input === 'e') {
			setMode('enabled')
			return
		}
		if (!key.ctrl && !key.meta && input === 'b') {
			setMode('builtin')
			return
		}

		// Focus shortcuts
		if (input === '\t') {
			setFocus((f) => (f === 'filter' ? 'groups' : f === 'groups' ? 'packages' : 'filter'))
			return
		}
		if (input === '/' && !key.ctrl && !key.meta) {
			setFocus('filter')
			return
		}
		if (!key.ctrl && !key.meta && focus !== 'filter' && key.leftArrow) {
			setFocus('groups')
			return
		}
		if (!key.ctrl && !key.meta && focus !== 'filter' && key.rightArrow) {
			setFocus('packages')
			return
		}

		// Filter editing
		if (focus === 'filter') {
			if (key.return) {
				setFocus('packages')
				return
			}
			if (key.backspace || key.delete) {
				setFilter((s) => s.slice(0, -1))
				return
			}
			if (key.ctrl && input.toLowerCase() === 'u') {
				setFilter('')
				return
			}
			// Ignore control sequences.
			if (key.ctrl || key.meta) return
			if (input && input.length === 1) {
				setFilter((s) => s + input)
			}
			return
		}

		// Helpers (apply to visible group list)
		const visibleNames = packagesInGroup.map((p) => p.name)
		if (!key.ctrl && !key.meta && input === 'x') {
			applyMany(visibleNames, 'swap')
			return
		}
		if (input === 'c' && !key.ctrl && !key.meta) {
			applyMany(visibleNames, 'clear')
			return
		}
		if (input === 'a' && !key.ctrl && !key.meta) {
			applyMany(visibleNames, 'enableAll')
			return
		}
		if (input === 'i' && !key.ctrl && !key.meta) {
			applyMany(visibleNames, 'invert')
			return
		}
		if (input === 'g' && !key.ctrl && !key.meta) {
			applyMany(visibleNames, 'toggle')
			return
		}

		// Group navigation
		if (focus === 'groups') {
			if (key.upArrow) {
				setGroupIndex((i) => clamp(i - 1, 0, Math.max(groups.length - 1, 0)))
				return
			}
			if (key.downArrow) {
				setGroupIndex((i) => clamp(i + 1, 0, Math.max(groups.length - 1, 0)))
				return
			}
			if (!key.ctrl && !key.meta && input === ' ') {
				applyMany(visibleNames, 'enableAll')
				return
			}
			if (!key.ctrl && !key.meta && input === 'E') {
				setMode('enabled')
				applyMany(visibleNames, 'enableAll')
				return
			}
			if (!key.ctrl && !key.meta && input === 'B') {
				setMode('builtin')
				applyMany(visibleNames, 'enableAll')
				return
			}
			if (key.return) {
				const g = groups[groupIndex]
				if (g) setActiveGroupKey(g.key)
				setFocus('packages')
				return
			}
			return
		}

		// Package navigation / selection
		if (focus === 'packages') {
			if (key.upArrow) {
				setPkgIndex((i) => clamp(i - 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.downArrow) {
				setPkgIndex((i) => clamp(i + 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.return || input === ' ') {
				const p = packagesInGroup[pkgIndex]
				if (!p) return
				toggleName(p.name)
				return
			}
		}
	})

	// Apply selected group index → active group key (when focus is groups and user moves).
	useEffect(() => {
		const g = groups[groupIndex]
		if (!g) return
		setActiveGroupKey(g.key)
	}, [groupIndex, groups])

	const groupCount = useMemo(
		() => new Set(filtered.map((p) => groupKeyForPkgDir(p.pkgDir))).size,
		[filtered],
	)
	const groupLabel = activeGroupKey === '__ALL__' ? '(all)' : activeGroupKey || '(none)'
	const filterLabel = filter ? `filter="${filter}"` : 'filter=(none)'

	const groupWindow = groups.slice(groupOffset, groupOffset + listRows)
	const pkgWindow = packagesInGroup.slice(pkgOffset, pkgOffset + listRows)
	const previewMax = groups.length <= listRows ? 8 : 2

	const currentPkg = packagesInGroup[pkgIndex]
	const currentPkgDesc = currentPkg ? currentPkg.entry : ''

	const focusTag = (tag: Focus) => (focus === tag ? '*' : ' ')
	const modeTag = mode === 'enabled' ? 'MODE=enabled (e)' : 'MODE=builtin (b)'
	const focusTagLabel =
		focus === 'filter' ? 'FOCUS=filter' : focus === 'groups' ? 'FOCUS=folders' : 'FOCUS=packages'

	return (
		<Box flexDirection="column" width="100%">
			<Text>
				{props.params.title}
				{'\n'}
				{props.params.message}
			</Text>
			<Text color="gray">
				enabled={enabled.size} • builtin={builtin.size} • visible={filtered.length} • groups=
				{groupCount} • group={groupLabel} • {filterLabel} • {modeTag} • {focusTagLabel}
			</Text>
			<Text>
				{focusTag('filter')} Filter: {filter}
				{focus === 'filter' ? '▊' : filter ? '' : ' (type to filter; use !token to exclude)'}
			</Text>

			<Box flexDirection="row" width="100%" height={bodyRows}>
				<Box
					flexDirection="column"
					width="35%"
					borderStyle="round"
					borderColor={focus === 'groups' ? 'cyan' : 'gray'}
				>
					<Text>{focusTag('groups')} Folders</Text>
					{groupWindow.map((g, i) => {
						const idx = groupOffset + i
						const active = idx === groupIndex
						const line = `${active ? '›' : ' '} ${g.label}`
						return (
							<Text
								key={g.key}
								color={
									focus === 'groups' ? (active ? 'cyan' : undefined) : active ? undefined : 'gray'
								}
								wrap="truncate"
							>
								{line}
								{'  '}
								<Text color="gray">{formatPreviewNames(g.previewNames, previewMax)}</Text>
							</Text>
						)
					})}
				</Box>

				<Box
					flexDirection="column"
					flexGrow={1}
					marginLeft={1}
					borderStyle="round"
					borderColor={focus === 'packages' ? 'cyan' : 'gray'}
				>
					<Text>{focusTag('packages')} Packages</Text>
					{pkgWindow.map((p, i) => {
						const idx = pkgOffset + i
						const active = idx === pkgIndex
						const tag = enabled.has(p.name) ? '[E]' : builtin.has(p.name) ? '[B]' : '[ ]'
						const line = `${active ? '›' : ' '} ${tag} ${p.name}`
						return (
							<Text
								key={p.name}
								color={
									focus === 'packages' ? (active ? 'cyan' : undefined) : active ? undefined : 'gray'
								}
								wrap="truncate"
							>
								{line}
							</Text>
						)
					})}
				</Box>
			</Box>

			<Text color="gray" wrap="truncate">
				{currentPkgDesc}
			</Text>
			<Text color="gray" wrap="truncate">
				e/b mode • x swap E↔B • Tab focus • / filter • ←/→ pane • ↑/↓ move • Enter/Space toggle • g
				group • a all • i invert • c clear • Ctrl+S confirm • Esc/Ctrl+C cancel • Ctrl+U clear
				filter
			</Text>
		</Box>
	)
}

export async function pickPackagesDualTui(
	params: PickPackagesDualParams,
): Promise<{ enabled: string[]; builtin: string[] } | null> {
	if (!process.stdout.isTTY || !process.stdin.isTTY) {
		throw new Error('TUI requires a TTY (interactive terminal).')
	}

	return new Promise<{ enabled: string[]; builtin: string[] } | null>((resolve, reject) => {
		let resolved = false
		const { waitUntilExit, unmount } = render(
			<PickPackagesDualPicker
				params={params}
				onDone={(result) => {
					if (resolved) return
					resolved = true
					resolve(result)
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

export type PickPackagesDualBrowserValue = { enabled: string[]; builtin: string[] }

export function PickPackagesDualBrowser(props: {
	discovered: PickPackagesDiscoveredPlugin[]
	enabled: string[]
	builtin: string[]
	initialMode?: PickPackagesMode
	height?: number
	onTypingChange?: (typing: boolean) => void
	onChange: (next: PickPackagesDualBrowserValue) => void
}) {
	const { stdout } = useStdout()

	const discoveredSorted = useMemo(
		() =>
			props.discovered
				.slice()
				.sort((a, b) => a.pkgDir.localeCompare(b.pkgDir) || a.name.localeCompare(b.name)),
		[props.discovered],
	)
	const discoveredSet = useMemo(
		() => new Set(discoveredSorted.map((p) => p.name)),
		[discoveredSorted],
	)

	type Selection = { enabled: Set<string>; builtin: Set<string> }
	const [selection, setSelection] = useState<Selection>(() => {
		const initialBuiltin = props.builtin.filter((n) => discoveredSet.has(n))
		const builtinSet = new Set(initialBuiltin)
		const initialEnabled = props.enabled
			.filter((n) => discoveredSet.has(n))
			.filter((n) => !builtinSet.has(n))
		return { enabled: new Set(initialEnabled), builtin: new Set(initialBuiltin) }
	})

	const suppressEmitRef = useRef(false)
	useEffect(() => {
		suppressEmitRef.current = true
		const initialBuiltin = props.builtin.filter((n) => discoveredSet.has(n))
		const builtinSet = new Set(initialBuiltin)
		const initialEnabled = props.enabled
			.filter((n) => discoveredSet.has(n))
			.filter((n) => !builtinSet.has(n))
		setSelection({ enabled: new Set(initialEnabled), builtin: new Set(initialBuiltin) })
		const t = setTimeout(() => {
			suppressEmitRef.current = false
		}, 0)
		return () => clearTimeout(t)
	}, [props.enabled.join('\n'), props.builtin.join('\n'), discoveredSet])

	const enabled = selection.enabled
	const builtin = selection.builtin

	const [mode, setMode] = useState<PickPackagesMode>(props.initialMode ?? 'enabled')
	const [filter, setFilter] = useState('')
	const filtered = useMemo(
		() => filterDiscovered(discoveredSorted, filter),
		[discoveredSorted, filter],
	)

	const [activeGroupKey, setActiveGroupKey] = useState<string>('__ALL__')
	const [focus, setFocus] = useState<Focus>('packages')

	const groups = useMemo(
		() => buildGroupsDual(filtered, enabled, builtin),
		[filtered, enabled, builtin],
	)
	const [groupIndex, setGroupIndex] = useState(0)
	const [groupOffset, setGroupOffset] = useState(0)
	const [pkgIndex, setPkgIndex] = useState(0)
	const [pkgOffset, setPkgOffset] = useState(0)

	useEffect(() => {
		const foundIdx = groups.findIndex((g) => g.key === activeGroupKey)
		const nextIdx = foundIdx >= 0 ? foundIdx : 0
		setGroupIndex(nextIdx)
		setActiveGroupKey(groups[nextIdx]?.key ?? '__ALL__')
	}, [groups, activeGroupKey])

	const packagesInGroup = useMemo(() => {
		const list =
			activeGroupKey === '__ALL__'
				? filtered
				: filtered.filter((p) => groupKeyForPkgDir(p.pkgDir) === activeGroupKey)
		return list.slice().sort((a, b) => a.name.localeCompare(b.name))
	}, [filtered, activeGroupKey])

	useEffect(() => {
		setPkgIndex((idx) => clamp(idx, 0, Math.max(packagesInGroup.length - 1, 0)))
	}, [packagesInGroup.length])

	const rows = props.height ?? stdout?.rows ?? 24
	const headerRows = 1
	const filterRows = 1
	const footerRows = 2
	const bodyRows = Math.max(rows - headerRows - filterRows - footerRows, 5)
	const listRows = Math.max(bodyRows - 2, 3)

	useEffect(() => {
		setGroupOffset((o) =>
			ensureVisibleWindow({ count: groups.length, index: groupIndex, window: listRows, offset: o }),
		)
	}, [groups.length, groupIndex, listRows])

	useEffect(() => {
		setPkgOffset((o) =>
			ensureVisibleWindow({
				count: packagesInGroup.length,
				index: pkgIndex,
				window: listRows,
				offset: o,
			}),
		)
	}, [packagesInGroup.length, pkgIndex, listRows])

	function emit(next: Selection) {
		if (suppressEmitRef.current) return
		props.onChange({
			enabled: [...next.enabled].sort((a, b) => a.localeCompare(b)),
			builtin: [...next.builtin].sort((a, b) => a.localeCompare(b)),
		})
	}

	function toggleName(name: string) {
		setSelection((prev) => {
			const nextEnabled = new Set(prev.enabled)
			const nextBuiltin = new Set(prev.builtin)
			const active = mode === 'enabled' ? prev.enabled.has(name) : prev.builtin.has(name)
			if (active) {
				nextEnabled.delete(name)
				nextBuiltin.delete(name)
				const next = { enabled: nextEnabled, builtin: nextBuiltin }
				emit(next)
				return next
			}
			if (mode === 'enabled') {
				nextEnabled.add(name)
				nextBuiltin.delete(name)
			} else {
				nextBuiltin.add(name)
				nextEnabled.delete(name)
			}
			const next = { enabled: nextEnabled, builtin: nextBuiltin }
			emit(next)
			return next
		})
	}

	function applyMany(
		names: string[],
		op: 'toggle' | 'enableAll' | 'invert' | 'clear' | 'swap',
		modeOverride?: PickPackagesMode,
	) {
		setSelection((prev) => {
			const activeMode = modeOverride ?? mode
			const nextEnabled = new Set(prev.enabled)
			const nextBuiltin = new Set(prev.builtin)
			const isActive = (n: string) =>
				activeMode === 'enabled' ? prev.enabled.has(n) : prev.builtin.has(n)
			const clear = (n: string) => {
				nextEnabled.delete(n)
				nextBuiltin.delete(n)
			}
			const setToMode = (n: string) => {
				if (activeMode === 'enabled') {
					nextEnabled.add(n)
					nextBuiltin.delete(n)
				} else {
					nextBuiltin.add(n)
					nextEnabled.delete(n)
				}
			}
			const swap = (n: string) => {
				if (prev.enabled.has(n)) {
					nextEnabled.delete(n)
					nextBuiltin.add(n)
					return
				}
				if (prev.builtin.has(n)) {
					nextBuiltin.delete(n)
					nextEnabled.add(n)
				}
			}

			if (op === 'clear') {
				for (const n of names) clear(n)
				const next = { enabled: nextEnabled, builtin: nextBuiltin }
				emit(next)
				return next
			}
			if (op === 'enableAll') {
				for (const n of names) setToMode(n)
				const next = { enabled: nextEnabled, builtin: nextBuiltin }
				emit(next)
				return next
			}
			if (op === 'swap') {
				for (const n of names) swap(n)
				const next = { enabled: nextEnabled, builtin: nextBuiltin }
				emit(next)
				return next
			}
			if (op === 'invert') {
				for (const n of names) isActive(n) ? clear(n) : setToMode(n)
				const next = { enabled: nextEnabled, builtin: nextBuiltin }
				emit(next)
				return next
			}

			let any = false
			for (const n of names) {
				if (isActive(n)) {
					any = true
					break
				}
			}
			for (const n of names) any ? clear(n) : setToMode(n)
			const next = { enabled: nextEnabled, builtin: nextBuiltin }
			emit(next)
			return next
		})
	}

	useInput((input, key) => {
		if (key.escape && focus === 'filter') {
			setFocus('packages')
			return
		}

		// Mode
		if (!key.ctrl && !key.meta && input === 'e') {
			setMode('enabled')
			return
		}
		if (!key.ctrl && !key.meta && input === 'b') {
			setMode('builtin')
			return
		}

		// Focus shortcuts
		if (input === '\t') {
			setFocus((f) => (f === 'filter' ? 'groups' : f === 'groups' ? 'packages' : 'filter'))
			return
		}
		if (input === '/' && !key.ctrl && !key.meta) {
			setFocus('filter')
			return
		}
		if (!key.ctrl && !key.meta && focus !== 'filter' && key.leftArrow) {
			setFocus('groups')
			return
		}
		if (!key.ctrl && !key.meta && focus !== 'filter' && key.rightArrow) {
			setFocus('packages')
			return
		}

		if (focus === 'filter') {
			if (key.return) {
				setFocus('packages')
				return
			}
			if (key.backspace || key.delete) {
				setFilter((s) => s.slice(0, -1))
				return
			}
			if (key.ctrl && input.toLowerCase() === 'u') {
				setFilter('')
				return
			}
			if (key.ctrl || key.meta) return
			if (input && input.length === 1) setFilter((s) => s + input)
			return
		}

		const visibleNames = packagesInGroup.map((p) => p.name)
		if (!key.ctrl && !key.meta && input === 'x') {
			applyMany(visibleNames, 'swap')
			return
		}
		if (input === 'c' && !key.ctrl && !key.meta) {
			applyMany(visibleNames, 'clear')
			return
		}
		if (input === 'a' && !key.ctrl && !key.meta) {
			applyMany(visibleNames, 'enableAll')
			return
		}
		if (input === 'i' && !key.ctrl && !key.meta) {
			applyMany(visibleNames, 'invert')
			return
		}
		if (input === 'g' && !key.ctrl && !key.meta) {
			applyMany(visibleNames, 'toggle')
			return
		}

		if (focus === 'groups') {
			if (key.upArrow) {
				setGroupIndex((i) => clamp(i - 1, 0, Math.max(groups.length - 1, 0)))
				return
			}
			if (key.downArrow) {
				setGroupIndex((i) => clamp(i + 1, 0, Math.max(groups.length - 1, 0)))
				return
			}
			if (key.return) {
				setFocus('packages')
				return
			}
			if (!key.ctrl && !key.meta && input === ' ') {
				applyMany(visibleNames, 'enableAll')
				return
			}
			if (!key.ctrl && !key.meta && input === 'E') {
				setMode('enabled')
				applyMany(visibleNames, 'enableAll', 'enabled')
				return
			}
			if (!key.ctrl && !key.meta && input === 'B') {
				setMode('builtin')
				applyMany(visibleNames, 'enableAll', 'builtin')
				return
			}
			return
		}

		if (focus === 'packages') {
			if (key.upArrow) {
				setPkgIndex((i) => clamp(i - 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.downArrow) {
				setPkgIndex((i) => clamp(i + 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.return || input === ' ') {
				const p = packagesInGroup[pkgIndex]
				if (!p) return
				toggleName(p.name)
			}
		}
	})

	useEffect(() => {
		props.onTypingChange?.(focus === 'filter')
		return () => props.onTypingChange?.(false)
	}, [focus])

	useEffect(() => {
		const g = groups[groupIndex]
		if (!g) return
		setActiveGroupKey(g.key)
	}, [groupIndex, groups])

	const groupCount = useMemo(
		() => new Set(filtered.map((p) => groupKeyForPkgDir(p.pkgDir))).size,
		[filtered],
	)

	const groupWindow = groups.slice(groupOffset, groupOffset + listRows)
	const pkgWindow = packagesInGroup.slice(pkgOffset, pkgOffset + listRows)
	const currentPkg = packagesInGroup[pkgIndex]
	const currentPkgDesc = currentPkg ? currentPkg.entry : ''

	const focusTag = (tag: Focus) => (focus === tag ? '*' : ' ')
	const modeTag = mode === 'enabled' ? 'MODE=enabled (e)' : 'MODE=builtin (b)'
	const focusLabel =
		focus === 'filter' ? 'focus=filter' : focus === 'groups' ? 'focus=folders' : 'focus=packages'
	const groupLabel = activeGroupKey === '__ALL__' ? '(all)' : activeGroupKey || '(none)'
	const filterLabel = filter ? `filter="${filter}"` : 'filter=(none)'
	const previewMax = groups.length <= listRows ? 8 : 2

	return (
		<Box flexDirection="column" width="100%">
			<Text color="gray">
				enabled={enabled.size} • builtin={builtin.size} • visible={filtered.length} • groups=
				{groupCount} • group={groupLabel} • {filterLabel} • {modeTag} • {focusLabel}
			</Text>
			<Text>
				{focusTag('filter')} Filter: {filter}
				{focus === 'filter' ? '▊' : filter ? '' : ' (type to filter; use !token to exclude)'}
			</Text>

			<Box flexDirection="row" width="100%" height={bodyRows}>
				<Box
					flexDirection="column"
					width="35%"
					borderStyle="round"
					borderColor={focus === 'groups' ? 'cyan' : 'gray'}
				>
					<Text>{focusTag('groups')} Folders</Text>
					{groupWindow.map((g, i) => {
						const idx = groupOffset + i
						const active = idx === groupIndex
						const line = `${active ? '›' : ' '} ${g.label}`
						return (
							<Text
								key={g.key}
								color={
									focus === 'groups' ? (active ? 'cyan' : undefined) : active ? undefined : 'gray'
								}
								wrap="truncate"
							>
								{line}
								{'  '}
								<Text color="gray">{formatPreviewNames(g.previewNames, previewMax)}</Text>
							</Text>
						)
					})}
				</Box>

				<Box
					flexDirection="column"
					flexGrow={1}
					marginLeft={1}
					borderStyle="round"
					borderColor={focus === 'packages' ? 'cyan' : 'gray'}
				>
					<Text>{focusTag('packages')} Packages</Text>
					{pkgWindow.map((p, i) => {
						const idx = pkgOffset + i
						const active = idx === pkgIndex
						const tag = enabled.has(p.name) ? '[E]' : builtin.has(p.name) ? '[B]' : '[ ]'
						const line = `${active ? '›' : ' '} ${tag} ${p.name}`
						return (
							<Text
								key={p.name}
								color={
									focus === 'packages' ? (active ? 'cyan' : undefined) : active ? undefined : 'gray'
								}
								wrap="truncate"
							>
								{line}
							</Text>
						)
					})}
				</Box>
			</Box>

			<Text color="gray" wrap="truncate">
				{currentPkgDesc}
			</Text>
			<Text color="gray" wrap="truncate">
				e/b mode • x swap E↔B • Tab focus • / filter • ←/→ pane • ↑/↓ move • Enter/Space toggle • g
				group • a all • i invert • c clear • Space(on folder) apply mode • E/B(on folder) apply •
				Ctrl+U clear filter
			</Text>
		</Box>
	)
}
