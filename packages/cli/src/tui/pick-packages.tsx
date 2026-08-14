import { Box, render, Text, useInput, useStdout } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'

export type PickPackagesDiscoveredPlugin = { name: string; entry: string; pkgDir: string }

type IndexedDiscoveredPlugin = PickPackagesDiscoveredPlugin & {
	groupKey: string
	search: string
}

function normalizePath(p: string) {
	return p.replaceAll('\\', '/')
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
	if (include.length === 0 && exclude.length === 0) return discovered

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
	previewNames: string[]
}

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
				[...props.params.discovered].sort(
					(a, b) => a.pkgDir.localeCompare(b.pkgDir) || a.name.localeCompare(b.name),
				),
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
				if (visibleNames.length === 0) return
				const any = setHasAnyInList(visibleNames, selected)
				toggleMany(visibleNames, !any)
				return
			}
			if (input === 'a' && !key.ctrl && !key.meta) {
				if (visibleNames.length > 0) toggleMany(visibleNames, true)
				return
			}
			if (input === 'c' && !key.ctrl && !key.meta) {
				setSelected(new Set())
				return
			}
			if (input === 'i' && !key.ctrl && !key.meta) {
				if (visibleNames.length > 0) invertMany(visibleNames)
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

export function PickPackagesBrowser(props: {
	discovered: PickPackagesDiscoveredPlugin[]
	enabled: string[]
	height: number
	disabled?: boolean
	onTypingChange?: (typing: boolean) => void
	onChange: (enabled: string[]) => void
}) {
	const ordered = useMemo(
		() =>
			[...props.discovered].sort(
				(left, right) =>
					left.pkgDir.localeCompare(right.pkgDir) || left.name.localeCompare(right.name),
			),
		[props.discovered],
	)
	const [selected, setSelected] = useState(() => new Set(props.enabled))
	const [query, setQuery] = useState('')
	const [typing, setTyping] = useState(false)
	const [cursor, setCursor] = useState(0)

	useEffect(() => {
		setSelected(new Set(props.enabled))
	}, [props.enabled.join('\n')])

	useEffect(() => {
		props.onTypingChange?.(typing)
	}, [typing, props.onTypingChange])

	const filtered = useMemo(() => {
		const needle = query.trim().toLowerCase()
		if (!needle) return ordered
		return ordered.filter((plugin) =>
			`${plugin.name}\n${plugin.pkgDir}\n${plugin.entry}`.toLowerCase().includes(needle),
		)
	}, [ordered, query])

	useEffect(() => {
		setCursor((current) => clamp(current, 0, Math.max(filtered.length - 1, 0)))
	}, [filtered.length])

	useInput((input, key) => {
		if (props.disabled) return
		if (typing) {
			if (key.escape || key.return) {
				setTyping(false)
				return
			}
			if (key.backspace || key.delete) {
				setQuery((value) => value.slice(0, -1))
				return
			}
			if (input && !key.ctrl && !key.meta) setQuery((value) => value + input)
			return
		}
		if (input === '/') {
			setTyping(true)
			return
		}
		if (key.upArrow) {
			setCursor((current) => clamp(current - 1, 0, Math.max(filtered.length - 1, 0)))
			return
		}
		if (key.downArrow) {
			setCursor((current) => clamp(current + 1, 0, Math.max(filtered.length - 1, 0)))
			return
		}
		if (!key.return && input !== ' ') return
		const plugin = filtered[cursor]
		if (!plugin) return
		setSelected((current) => {
			const next = new Set(current)
			if (next.has(plugin.name)) next.delete(plugin.name)
			else next.add(plugin.name)
			props.onChange([...next].sort((left, right) => left.localeCompare(right)))
			return next
		})
	})

	const listHeight = Math.max(props.height - 2, 1)
	const offset = clamp(
		cursor - Math.floor(listHeight / 2),
		0,
		Math.max(filtered.length - listHeight, 0),
	)
	const visible = filtered.slice(offset, offset + listHeight)

	return (
		<Box flexDirection="column" height={props.height}>
			<Text color="gray">
				{typing ? `filter: ${query}█` : `selected ${selected.size} • visible ${filtered.length}`}
			</Text>
			{visible.map((plugin, index) => {
				const position = offset + index
				const active = position === cursor
				return (
					<Text
						key={plugin.name}
						color={active ? 'black' : selected.has(plugin.name) ? 'green' : 'gray'}
						backgroundColor={active ? 'cyan' : undefined}
					>
						{`${selected.has(plugin.name) ? '[x]' : '[ ]'} ${plugin.name} — ${plugin.pkgDir}`}
					</Text>
				)
			})}
			{filtered.length === 0 ? <Text color="gray">(no matching packages)</Text> : null}
		</Box>
	)
}
