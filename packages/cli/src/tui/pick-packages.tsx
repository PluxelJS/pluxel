import { Box, render, Text, useInput, useStdout } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'

export type PickPackagesDiscoveredPlugin = { name: string; entry: string; pkgDir: string }

type IndexedDiscoveredPlugin = PickPackagesDiscoveredPlugin & {
	groupKey: string
	search: string
}

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

function indexDiscovered(discovered: PickPackagesDiscoveredPlugin[]) {
	return discovered.map((p): IndexedDiscoveredPlugin => {
		const pkgDir = normalizePath(p.pkgDir)
		const entry = normalizePath(p.entry)
		return {
			...p,
			pkgDir,
			entry,
			groupKey: groupKeyForPkgDir(pkgDir),
			search: `${p.name}\n${pkgDir}\n${entry}`.toLowerCase(),
		}
	})
}

function filterDiscovered(discovered: IndexedDiscoveredPlugin[], query: string) {
	const { include, exclude } = parseFilterQuery(query)
	if (!include.length && !exclude.length) return discovered

	return discovered.filter((p) => {
		for (const ex of exclude) if (p.search.includes(ex)) return false
		for (const inc of include) if (!p.search.includes(inc)) return false
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

type PickPackagesMode = 'enabled' | 'builtin'

type GroupedDiscoveredIndex<T extends { name: string }> = {
	keys: string[]
	itemsByKey: Map<string, T[]>
	namesByKey: Map<string, string[]>
	allItems: T[]
	allNames: string[]
}

function buildGroupedIndex<T extends { name: string; groupKey: string }>(
	items: readonly T[],
): GroupedDiscoveredIndex<T> {
	const itemsByKey = new Map<string, T[]>()
	for (const it of items) {
		const list = itemsByKey.get(it.groupKey)
		if (list) list.push(it)
		else itemsByKey.set(it.groupKey, [it])
	}

	const keys = [...itemsByKey.keys()].sort((a, b) => a.localeCompare(b))
	const namesByKey = new Map<string, string[]>()
	for (const key of keys) {
		const list = itemsByKey.get(key) ?? []
		list.sort((a, b) => a.name.localeCompare(b.name))
		namesByKey.set(
			key,
			list.map((p) => p.name),
		)
	}

	const allItems = [...items].sort((a, b) => a.name.localeCompare(b.name))
	const allNames = allItems.map((p) => p.name)

	return { keys, itemsByKey, namesByKey, allItems, allNames }
}

function countSelectedIn(items: readonly { name: string }[], selected: Set<string>) {
	let n = 0
	for (const it of items) if (selected.has(it.name)) n++
	return n
}

const ALL_GROUP_KEY = '__ALL__' as const

function buildGroupKeyIndex(groups: readonly { key: string }[]) {
	const map = new Map<string, number>()
	for (let i = 0; i < groups.length; i++) map.set(groups[i]!.key, i)
	return map
}

function buildGroupInfosSingle<T extends { name: string }>(
	grouped: GroupedDiscoveredIndex<T>,
	selected: Set<string>,
): GroupInfo[] {
	const allTotal = grouped.allItems.length
	const allSelected = countSelectedIn(grouped.allItems, selected)
	const list: GroupInfo[] = [
		{
			key: ALL_GROUP_KEY,
			label: `(all) (${allSelected}/${allTotal})`,
			total: allTotal,
			selectedCount: allSelected,
			previewNames: grouped.allNames,
		},
	]

	for (const key of grouped.keys) {
		const items = grouped.itemsByKey.get(key) ?? []
		const total = items.length
		const selectedCount = countSelectedIn(items, selected)
		const labelBase = key === '.' ? '(root)' : key
		list.push({
			key,
			label: `${labelBase} (${selectedCount}/${total})`,
			total,
			selectedCount,
			previewNames: grouped.namesByKey.get(key) ?? [],
		})
	}

	return list
}

function buildGroupInfosDual<T extends { name: string }>(
	grouped: GroupedDiscoveredIndex<T>,
	enabled: Set<string>,
	builtin: Set<string>,
): GroupInfo[] {
	const allTotal = grouped.allItems.length
	const allEnabled = countSelectedIn(grouped.allItems, enabled)
	const allBuiltin = countSelectedIn(grouped.allItems, builtin)
	const list: GroupInfo[] = [
		{
			key: ALL_GROUP_KEY,
			label: `(all) (E${allEnabled} B${allBuiltin} / ${allTotal})`,
			total: allTotal,
			selectedCount: allEnabled + allBuiltin,
			enabledCount: allEnabled,
			builtinCount: allBuiltin,
			previewNames: grouped.allNames,
		},
	]

	for (const key of grouped.keys) {
		const items = grouped.itemsByKey.get(key) ?? []
		const total = items.length
		const enabledCount = countSelectedIn(items, enabled)
		const builtinCount = countSelectedIn(items, builtin)
		const labelBase = key === '.' ? '(root)' : key
		list.push({
			key,
			label: `${labelBase} (E${enabledCount} B${builtinCount} / ${total})`,
			total,
			selectedCount: enabledCount + builtinCount,
			enabledCount,
			builtinCount,
			previewNames: grouped.namesByKey.get(key) ?? [],
		})
	}

	return list
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

	const discoveredIndexed = useMemo(
		() =>
			indexDiscovered(
				props.params.discovered
					.slice()
					.sort((a, b) => a.pkgDir.localeCompare(b.pkgDir) || a.name.localeCompare(b.name)),
			),
		[props.params.discovered],
	)

	const discoveredSet = useMemo(
		() => new Set(discoveredIndexed.map((p) => p.name)),
		[discoveredIndexed],
	)
	const [selected, setSelected] = useState<Set<string>>(
		() => new Set(props.params.initialSelected.filter((n) => discoveredSet.has(n))),
	)

	const [filter, setFilter] = useState('')
	const filtered = useMemo(
		() => filterDiscovered(discoveredIndexed, filter),
		[discoveredIndexed, filter],
	)

	const [activeGroupKey, setActiveGroupKey] = useState<string>(ALL_GROUP_KEY)
	const [focus, setFocus] = useState<Focus>('packages')

	const grouped = useMemo(() => buildGroupedIndex(filtered), [filtered])

	const groups = useMemo(() => buildGroupInfosSingle(grouped, selected), [grouped, selected])

	const groupKeyToIndex = useMemo(() => buildGroupKeyIndex(groups), [groups])

	const groupIndex = groupKeyToIndex.get(activeGroupKey) ?? 0

	useEffect(() => {
		if (!groupKeyToIndex.has(activeGroupKey)) setActiveGroupKey(ALL_GROUP_KEY)
	}, [groupKeyToIndex, activeGroupKey])

	const activeKey = groups[groupIndex]?.key ?? ALL_GROUP_KEY

	const [groupOffset, setGroupOffset] = useState(0)
	const [pkgIndex, setPkgIndex] = useState(0)
	const [pkgOffset, setPkgOffset] = useState(0)

	const packagesInGroup =
		activeKey === ALL_GROUP_KEY ? grouped.allItems : (grouped.itemsByKey.get(activeKey) ?? [])
	const visibleNames =
		activeKey === ALL_GROUP_KEY ? grouped.allNames : (grouped.namesByKey.get(activeKey) ?? [])

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
		if (key.escape && focus === 'filter') {
			setFocus('packages')
			return
		}
		// Cancel / Confirm
		if (key.escape || (key.ctrl && input === 'c')) {
			finish(null)
			return
		}
		if (key.ctrl && input.toLowerCase() === 's') {
			finish([...selected].sort((a, b) => a.localeCompare(b)))
			return
		}
		if (key.ctrl && input.toLowerCase() === 'u') {
			setFilter('')
			return
		}

		// Focus shortcuts
		if (key.ctrl && input.toLowerCase() === 'f') {
			setFocus('filter')
			return
		}
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

		// Group navigation
		if (focus === 'groups') {
			if (key.upArrow) {
				const next = clamp(groupIndex - 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.downArrow) {
				const next = clamp(groupIndex + 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (!key.ctrl && !key.meta && input === 'k') {
				const next = clamp(groupIndex - 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (!key.ctrl && !key.meta && input === 'j') {
				const next = clamp(groupIndex + 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.home) {
				setActiveGroupKey(groups[0]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.end) {
				setActiveGroupKey(groups[Math.max(groups.length - 1, 0)]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.pageUp) {
				const page = Math.max(listRows - 1, 1)
				const next = clamp(groupIndex - page, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.pageDown) {
				const page = Math.max(listRows - 1, 1)
				const next = clamp(groupIndex + page, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (!key.ctrl && !key.meta && input === ' ') {
				if (!visibleNames.length) return
				const any = setHasAnyInList(visibleNames, selected)
				toggleMany(visibleNames, !any)
				return
			}
			if (input === 'a' && !key.ctrl && !key.meta) {
				if (visibleNames.length) toggleMany(visibleNames, true)
				return
			}
			if (input === 'c' && !key.ctrl && !key.meta) {
				setSelected(new Set())
				return
			}
			if (input === 'i' && !key.ctrl && !key.meta) {
				if (visibleNames.length) invertMany(visibleNames)
				return
			}
			if (key.return) {
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
			if (!key.ctrl && !key.meta && input === 'k') {
				setPkgIndex((i) => clamp(i - 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (!key.ctrl && !key.meta && input === 'j') {
				setPkgIndex((i) => clamp(i + 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.home) {
				setPkgIndex(0)
				return
			}
			if (key.end) {
				setPkgIndex(Math.max(packagesInGroup.length - 1, 0))
				return
			}
			if (key.pageUp) {
				const page = Math.max(listRows - 1, 1)
				setPkgIndex((i) => clamp(i - page, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.pageDown) {
				const page = Math.max(listRows - 1, 1)
				setPkgIndex((i) => clamp(i + page, 0, Math.max(packagesInGroup.length - 1, 0)))
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

	const groupCount = grouped.keys.length
	const groupLabel = activeKey === ALL_GROUP_KEY ? '(all)' : activeKey || '(none)'
	const filterLabel = filter ? `filter="${filter}"` : 'filter=(none)'

	const groupWindow = groups.slice(groupOffset, groupOffset + listRows)
	const pkgWindow = packagesInGroup.slice(pkgOffset, pkgOffset + listRows)
	const previewMax = groups.length <= listRows ? 8 : 2

	const currentPkg = packagesInGroup[pkgIndex]
	const currentPkgDesc = currentPkg ? currentPkg.entry : ''

	const focusTag = (tag: Focus) => (focus === tag ? '*' : ' ')
	const rowPrefix = (active: boolean, pane: Focus) => {
		if (!active) return ' '
		return focus === pane ? '›' : '·'
	}
	const focusHint =
		focus === 'filter'
			? 'filter: type • Enter apply • Esc back'
			: focus === 'groups'
				? 'folders: ↑/↓ or j/k • → packages • Space toggle • a all • c clear • i invert'
				: 'packages: ↑/↓ or j/k • ← folders • Enter/Space toggle'

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
						const line = `${rowPrefix(active, 'groups')} ${g.label}`
						return (
							<Text
								key={g.key}
								color={focus === 'groups' ? (active ? 'cyan' : undefined) : 'gray'}
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
						const checked = selected.has(p.name)
						const line = `${rowPrefix(active, 'packages')} ${checked ? '[x]' : '[ ]'} ${p.name}`
						return (
							<Text
								key={p.name}
								color={focus === 'packages' ? (active ? 'cyan' : undefined) : 'gray'}
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
				/ filter • ←/→ pane • {focusHint} • Ctrl+S confirm • Esc/Ctrl+C cancel
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

	const discoveredIndexed = useMemo(
		() =>
			indexDiscovered(
				props.params.discovered
					.slice()
					.sort((a, b) => a.pkgDir.localeCompare(b.pkgDir) || a.name.localeCompare(b.name)),
			),
		[props.params.discovered],
	)

	const discoveredSet = useMemo(
		() => new Set(discoveredIndexed.map((p) => p.name)),
		[discoveredIndexed],
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
		() => filterDiscovered(discoveredIndexed, filter),
		[discoveredIndexed, filter],
	)

	const [activeGroupKey, setActiveGroupKey] = useState<string>(ALL_GROUP_KEY)
	const [focus, setFocus] = useState<Focus>('packages')

	const grouped = useMemo(() => buildGroupedIndex(filtered), [filtered])

	const groups = useMemo(() => buildGroupInfosDual(grouped, enabled, builtin), [grouped, enabled, builtin])

	const groupKeyToIndex = useMemo(() => buildGroupKeyIndex(groups), [groups])

	const groupIndex = groupKeyToIndex.get(activeGroupKey) ?? 0

	useEffect(() => {
		if (!groupKeyToIndex.has(activeGroupKey)) setActiveGroupKey(ALL_GROUP_KEY)
	}, [groupKeyToIndex, activeGroupKey])

	const activeKey = groups[groupIndex]?.key ?? ALL_GROUP_KEY

	const [groupOffset, setGroupOffset] = useState(0)
	const [pkgIndex, setPkgIndex] = useState(0)
	const [pkgOffset, setPkgOffset] = useState(0)

	const packagesInGroup =
		activeKey === ALL_GROUP_KEY ? grouped.allItems : (grouped.itemsByKey.get(activeKey) ?? [])
	const visibleNames =
		activeKey === ALL_GROUP_KEY ? grouped.allNames : (grouped.namesByKey.get(activeKey) ?? [])

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

	function applyMany(names: string[], op: 'toggle' | 'enableAll' | 'invert' | 'clear') {
		setSelection((prev) => {
			const nextEnabled = new Set(prev.enabled)
			const nextBuiltin = new Set(prev.builtin)
			const isActive = (n: string) => (mode === 'enabled' ? prev.enabled.has(n) : prev.builtin.has(n))
			const clear = (n: string) => {
				nextEnabled.delete(n)
				nextBuiltin.delete(n)
			}
			const setToMode = (n: string) => {
				if (mode === 'enabled') {
					nextEnabled.add(n)
					nextBuiltin.delete(n)
				} else {
					nextBuiltin.add(n)
					nextEnabled.delete(n)
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
		if (key.escape && focus === 'filter') {
			setFocus('packages')
			return
		}

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

		// While typing in filter, ignore other single-key actions.
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

		// Mode
		if (!key.ctrl && !key.meta && input === 'e') {
			setMode((m) => (m === 'enabled' ? 'builtin' : 'enabled'))
			return
		}

		// Focus shortcuts
		if (key.ctrl && input.toLowerCase() === 'f') {
			setFocus('filter')
			return
		}
		if (key.ctrl && input.toLowerCase() === 'u') {
			setFilter('')
			return
		}
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

		// Group navigation
		if (focus === 'groups') {
			if (key.upArrow) {
				const next = clamp(groupIndex - 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.downArrow) {
				const next = clamp(groupIndex + 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (!key.ctrl && !key.meta && input === 'k') {
				const next = clamp(groupIndex - 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (!key.ctrl && !key.meta && input === 'j') {
				const next = clamp(groupIndex + 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.home) {
				setActiveGroupKey(groups[0]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.end) {
				setActiveGroupKey(groups[Math.max(groups.length - 1, 0)]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.pageUp) {
				const page = Math.max(listRows - 1, 1)
				const next = clamp(groupIndex - page, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.pageDown) {
				const page = Math.max(listRows - 1, 1)
				const next = clamp(groupIndex + page, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (!key.ctrl && !key.meta && input === ' ') {
				applyMany(visibleNames, 'toggle')
				return
			}
			if (!key.ctrl && !key.meta && input === 'a') {
				applyMany(visibleNames, 'enableAll')
				return
			}
			if (!key.ctrl && !key.meta && input === 'c') {
				applyMany(visibleNames, 'clear')
				return
			}
			if (!key.ctrl && !key.meta && input === 'i') {
				applyMany(visibleNames, 'invert')
				return
			}
			if (key.return) {
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
			if (!key.ctrl && !key.meta && input === 'k') {
				setPkgIndex((i) => clamp(i - 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (!key.ctrl && !key.meta && input === 'j') {
				setPkgIndex((i) => clamp(i + 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.home) {
				setPkgIndex(0)
				return
			}
			if (key.end) {
				setPkgIndex(Math.max(packagesInGroup.length - 1, 0))
				return
			}
			if (key.pageUp) {
				const page = Math.max(listRows - 1, 1)
				setPkgIndex((i) => clamp(i - page, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.pageDown) {
				const page = Math.max(listRows - 1, 1)
				setPkgIndex((i) => clamp(i + page, 0, Math.max(packagesInGroup.length - 1, 0)))
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

	const groupCount = grouped.keys.length
	const groupLabel = activeKey === ALL_GROUP_KEY ? '(all)' : activeKey || '(none)'
	const filterLabel = filter ? `filter="${filter}"` : 'filter=(none)'

	const groupWindow = groups.slice(groupOffset, groupOffset + listRows)
	const pkgWindow = packagesInGroup.slice(pkgOffset, pkgOffset + listRows)
	const previewMax = groups.length <= listRows ? 8 : 2

	const currentPkg = packagesInGroup[pkgIndex]
	const currentPkgDesc = currentPkg ? currentPkg.entry : ''

	const focusTag = (tag: Focus) => (focus === tag ? '*' : ' ')
	const modeTag = mode === 'enabled' ? 'MODE=enabled (e)' : 'MODE=builtin (e)'
	const focusTagLabel =
		focus === 'filter' ? 'FOCUS=filter' : focus === 'groups' ? 'FOCUS=folders' : 'FOCUS=packages'
	const focusHint =
		focus === 'filter'
			? 'filter: type • Enter apply • Esc back'
			: focus === 'groups'
				? 'folders: ↑/↓ or j/k • → packages • Space toggle • a all • c clear • i invert'
				: 'packages: ↑/↓ or j/k • ← folders • Enter/Space toggle'

	const rowPrefix = (active: boolean, pane: Focus) => {
		if (!active) return ' '
		return focus === pane ? '›' : '·'
	}

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
						const line = `${rowPrefix(active, 'groups')} ${g.label}`
						return (
							<Text
								key={g.key}
								color={focus === 'groups' ? (active ? 'cyan' : undefined) : 'gray'}
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
						const line = `${rowPrefix(active, 'packages')} ${tag} ${p.name}`
						return (
							<Text
								key={p.name}
								color={focus === 'packages' ? (active ? 'cyan' : undefined) : 'gray'}
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
				/ filter • ←/→ pane • e mode • {focusHint} • Ctrl+S confirm • Esc/Ctrl+C cancel
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
	disabled?: boolean
	height?: number
	onTypingChange?: (typing: boolean) => void
	onChange: (next: PickPackagesDualBrowserValue) => void
}) {
	const { stdout } = useStdout()

	const discoveredIndexed = useMemo(
		() =>
			indexDiscovered(
				props.discovered
					.slice()
					.sort((a, b) => a.pkgDir.localeCompare(b.pkgDir) || a.name.localeCompare(b.name)),
			),
		[props.discovered],
	)
	const discoveredSet = useMemo(
		() => new Set(discoveredIndexed.map((p) => p.name)),
		[discoveredIndexed],
	)

	type Selection = { enabled: Set<string>; builtin: Set<string> }
	const normalizeSelection = (enabledRaw: string[], builtinRaw: string[]) => {
		const initialBuiltin = builtinRaw.filter((n) => discoveredSet.has(n))
		const builtinSet = new Set(initialBuiltin)
		const initialEnabled = enabledRaw.filter((n) => discoveredSet.has(n)).filter((n) => !builtinSet.has(n))
		return { enabled: new Set(initialEnabled), builtin: new Set(initialBuiltin) }
	}
	const [selection, setSelection] = useState<Selection>(() => {
		return normalizeSelection(props.enabled, props.builtin)
	})

	const suppressEmitRef = useRef(false)
	useEffect(() => {
		suppressEmitRef.current = true
		setSelection(normalizeSelection(props.enabled, props.builtin))
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
		() => filterDiscovered(discoveredIndexed, filter),
		[discoveredIndexed, filter],
	)

	const [activeGroupKey, setActiveGroupKey] = useState<string>(ALL_GROUP_KEY)
	const [focus, setFocus] = useState<Focus>('packages')

	const grouped = useMemo(() => buildGroupedIndex(filtered), [filtered])

		const groups = useMemo(
			() => buildGroupInfosDual(grouped, enabled, builtin),
			[grouped, enabled, builtin],
		)

		const groupKeyToIndex = useMemo(() => buildGroupKeyIndex(groups), [groups])

	const groupIndex = groupKeyToIndex.get(activeGroupKey) ?? 0

		useEffect(() => {
			if (!groupKeyToIndex.has(activeGroupKey)) setActiveGroupKey(ALL_GROUP_KEY)
		}, [groupKeyToIndex, activeGroupKey])

		const activeKey = groups[groupIndex]?.key ?? ALL_GROUP_KEY

	const [groupOffset, setGroupOffset] = useState(0)
	const [pkgIndex, setPkgIndex] = useState(0)
	const [pkgOffset, setPkgOffset] = useState(0)

		const packagesInGroup =
			activeKey === ALL_GROUP_KEY ? grouped.allItems : (grouped.itemsByKey.get(activeKey) ?? [])
		const visibleNames =
			activeKey === ALL_GROUP_KEY ? grouped.allNames : (grouped.namesByKey.get(activeKey) ?? [])

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

	function applyMany(names: string[], op: 'toggle' | 'enableAll' | 'invert' | 'clear') {
		setSelection((prev) => {
			const nextEnabled = new Set(prev.enabled)
			const nextBuiltin = new Set(prev.builtin)
			const isActive = (n: string) => (mode === 'enabled' ? prev.enabled.has(n) : prev.builtin.has(n))
			const clear = (n: string) => {
				nextEnabled.delete(n)
				nextBuiltin.delete(n)
			}
			const setToMode = (n: string) => {
				if (mode === 'enabled') {
					nextEnabled.add(n)
					nextBuiltin.delete(n)
				} else {
					nextBuiltin.add(n)
					nextEnabled.delete(n)
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
		if (props.disabled) return
		if (key.escape && focus === 'filter') {
			setFocus('packages')
			return
		}

		// While typing in filter, ignore other single-key actions.
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

		// Mode
		if (!key.ctrl && !key.meta && input === 'e') {
			setMode((m) => (m === 'enabled' ? 'builtin' : 'enabled'))
			return
		}

		// Fast focus: filter
		if (key.ctrl && input.toLowerCase() === 'f') {
			setFocus('filter')
			return
		}
		if (key.ctrl && input.toLowerCase() === 'u') {
			setFilter('')
			return
		}

		// Focus shortcuts
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

		if (focus === 'groups') {
			if (key.upArrow) {
				const next = clamp(groupIndex - 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.downArrow) {
				const next = clamp(groupIndex + 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (!key.ctrl && !key.meta && input === 'k') {
				const next = clamp(groupIndex - 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (!key.ctrl && !key.meta && input === 'j') {
				const next = clamp(groupIndex + 1, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.home) {
				setActiveGroupKey(groups[0]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.end) {
				setActiveGroupKey(groups[Math.max(groups.length - 1, 0)]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.pageUp) {
				const page = Math.max(listRows - 1, 1)
				const next = clamp(groupIndex - page, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.pageDown) {
				const page = Math.max(listRows - 1, 1)
				const next = clamp(groupIndex + page, 0, Math.max(groups.length - 1, 0))
				setActiveGroupKey(groups[next]?.key ?? ALL_GROUP_KEY)
				return
			}
			if (key.return) {
				setFocus('packages')
				return
			}
			if (!key.ctrl && !key.meta && input === ' ') {
				applyMany(visibleNames, 'toggle')
				return
			}
			if (!key.ctrl && !key.meta && input === 'a') {
				applyMany(visibleNames, 'enableAll')
				return
			}
			if (!key.ctrl && !key.meta && input === 'c') {
				applyMany(visibleNames, 'clear')
				return
			}
			if (!key.ctrl && !key.meta && input === 'i') {
				applyMany(visibleNames, 'invert')
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
			if (!key.ctrl && !key.meta && input === 'k') {
				setPkgIndex((i) => clamp(i - 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (!key.ctrl && !key.meta && input === 'j') {
				setPkgIndex((i) => clamp(i + 1, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.home) {
				setPkgIndex(0)
				return
			}
			if (key.end) {
				setPkgIndex(Math.max(packagesInGroup.length - 1, 0))
				return
			}
			if (key.pageUp) {
				const page = Math.max(listRows - 1, 1)
				setPkgIndex((i) => clamp(i - page, 0, Math.max(packagesInGroup.length - 1, 0)))
				return
			}
			if (key.pageDown) {
				const page = Math.max(listRows - 1, 1)
				setPkgIndex((i) => clamp(i + page, 0, Math.max(packagesInGroup.length - 1, 0)))
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
		props.onTypingChange?.(!props.disabled && focus === 'filter')
		return () => props.onTypingChange?.(false)
	}, [focus, props.disabled])

	const groupWindow = groups.slice(groupOffset, groupOffset + listRows)
	const pkgWindow = packagesInGroup.slice(pkgOffset, pkgOffset + listRows)
	const currentPkg = packagesInGroup[pkgIndex]
	const currentPkgDesc = currentPkg ? currentPkg.entry : ''

	const focusTag = (tag: Focus) => (focus === tag ? '*' : ' ')
	const previewMax = groups.length <= listRows ? 8 : 2
	const matchLabel = filter ? `matches ${filtered.length}` : `total ${filtered.length}`
	const focusHint =
		focus === 'filter'
			? 'filter: type • Enter apply • Esc back'
			: focus === 'groups'
				? 'folders: ↑/↓ or j/k • → packages • Space toggle • a all • c clear • i invert'
				: 'packages: ↑/↓ or j/k • ← folders • Enter/Space toggle'

	const rowPrefix = (active: boolean, pane: Focus) => {
		if (!active) return ' '
		return focus === pane ? '›' : '·'
	}

	return (
		<Box flexDirection="column" width="100%">
			<Text>
				<Text color="gray">Mode </Text>
				<Text color={mode === 'enabled' ? 'green' : 'gray'}>{' enabled '}</Text>
				<Text color="gray"> </Text>
				<Text color={mode === 'builtin' ? 'yellow' : 'gray'}>{' builtin '}</Text>
				<Text color="gray">
					{` • selected enabled ${enabled.size} • builtin ${builtin.size} • ${matchLabel}`}
				</Text>
			</Text>
			<Text color="gray">
				<Text
					color={focus === 'filter' ? 'black' : 'gray'}
					backgroundColor={focus === 'filter' ? 'cyan' : undefined}
				>
					{' Filter '}
				</Text>
				<Text color="gray">{`: ${filter}`}</Text>
				{focus === 'filter'
					? '▊'
					: filter
						? ''
						: ' (type to filter; use !token to exclude)'}
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
						const line = `${rowPrefix(active, 'groups')} ${g.label}`
						return (
							<Text
								key={g.key}
								color={focus === 'groups' ? (active ? 'cyan' : undefined) : 'gray'}
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
						const tagColor = enabled.has(p.name) ? 'green' : builtin.has(p.name) ? 'yellow' : 'gray'
						const prefix = `${rowPrefix(active, 'packages')} `
						return (
							<Text
								key={p.name}
								color={focus === 'packages' ? (active ? 'cyan' : undefined) : 'gray'}
								wrap="truncate"
							>
								{prefix}
								<Text color={tagColor}>{tag}</Text>
								{' '}
								{p.name}
							</Text>
						)
					})}
				</Box>
			</Box>

			<Text color="gray" wrap="truncate">
				{currentPkgDesc}
			</Text>
			<Text color="gray" wrap="truncate">
				/ filter • ←/→ pane • e mode • {focusHint}
			</Text>
		</Box>
	)
}
