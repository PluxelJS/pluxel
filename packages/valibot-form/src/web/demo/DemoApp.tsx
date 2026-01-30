import { AppShell, Badge, Burger, Group, Stack, Text, Title } from '@mantine/core'
import { useDebouncedValue, useDisclosure, useMediaQuery } from '@mantine/hooks'
import { useEffect, useMemo, useState } from 'react'
import * as v from 'valibot'
import * as f from '../../index'
import { AutoForm } from '../index'
import {
	CASE_GROUPS,
	DEMO_CASES,
	type CaseGroupId,
} from './data/cases'
import { CaseHeader } from './components/CaseHeader'
import { CaseNav } from './components/CaseNav'
import { FormPanel } from './components/FormPanel'
import { UtilityPanel } from './components/UtilityPanel'
import { buildCaseStats } from './utils/stats'
import {
	buildCaseIndex,
	filterCases,
	groupCases,
	orderCases,
	resolveActiveCase,
	resolveNavigation,
} from './utils/catalog'
import { PLAYGROUND_TEMPLATE } from './data/playground'
import type { PlaygroundState } from './components/PlaygroundPanel'

export function DemoApp() {
	const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false)
	const [query, setQuery] = useState('')
	const [debouncedQuery] = useDebouncedValue(query, 150)
	const [groupFilter, setGroupFilter] = useState<CaseGroupId | 'all'>('all')
	const [activeTags, setActiveTags] = useState<string[]>([])
	const [activeId, setActiveId] = useState(DEMO_CASES[0]?.id ?? '')
	const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable')
	const isWide = useMediaQuery('(min-width: 1200px)')
	const [utilityTab, setUtilityTab] = useState<string | null>('debug')
	const [playground, setPlayground] = useState<PlaygroundState & { formOpts?: unknown }>({
		code: PLAYGROUND_TEMPLATE,
		enabled: false,
		schema: null,
		error: undefined,
		lastRunAt: undefined,
		formOpts: undefined,
	})

	const caseIndex = useMemo(() => buildCaseIndex(DEMO_CASES, CASE_GROUPS), [])

	const filteredCases = useMemo(() => {
		return filterCases(
			DEMO_CASES,
			{ query: debouncedQuery, groupFilter, activeTags },
			caseIndex.searchMap,
		)
	}, [debouncedQuery, groupFilter, activeTags, caseIndex])

	const orderedCases = useMemo(
		() => orderCases(filteredCases, caseIndex.groupOrder),
		[filteredCases, caseIndex],
	)

	useEffect(() => {
		if (!orderedCases.length) return
		if (!orderedCases.some((item) => item.id === activeId)) {
			setActiveId(orderedCases[0].id)
		}
	}, [orderedCases, activeId])

	const activeCase = useMemo(
		() => resolveActiveCase(orderedCases, activeId),
		[orderedCases, activeId],
	)

	const groupedCases = useMemo(
		() => groupCases(orderedCases, CASE_GROUPS),
		[orderedCases],
	)

	const navigation = useMemo(
		() => resolveNavigation(orderedCases, activeCase?.id ?? ''),
		[orderedCases, activeCase],
	)
	const activeGroup = activeCase
		? CASE_GROUPS.find((group) => group.id === activeCase.group)
		: undefined

	const resolvedSchema = playground.enabled && playground.schema ? playground.schema : activeCase?.schema
	const resolvedFormOpts =
		playground.enabled && playground.schema ? playground.formOpts : activeCase?.formOpts
	const schemaSource =
		playground.enabled && playground.schema
			? playground.code
			: activeCase?.source
	const resetKey =
		playground.enabled && playground.schema
			? `playground-${playground.lastRunAt ?? 0}`
			: `case-${activeCase?.id ?? 'unknown'}`

	const stats = useMemo(() => {
		if (!resolvedSchema) return null
		return buildCaseStats(resolvedSchema as any)
	}, [resolvedSchema])

	const handleTagToggle = (tag: string) => {
		setActiveTags((prev) =>
			prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag],
		)
	}

	const runPlayground = () => {
		try {
			const executor = new Function('v', 'f', playground.code) as (vv: typeof v, ff: typeof f) => any
			const result = executor(v, f)
			const outputSchema = result?.schema ?? result
			if (!outputSchema || typeof outputSchema !== 'object') {
				throw new Error('请返回 schema 或 { schema, formOpts }')
			}
			const schemaType = (outputSchema as any).type
			if (schemaType !== 'object' && schemaType !== 'intersect') {
				throw new Error('当前仅支持 object / intersect schema')
			}
			setPlayground((prev) => ({
				...prev,
				schema: outputSchema,
				formOpts: result?.formOpts,
				error: undefined,
				lastRunAt: Date.now(),
			}))
			return true
		} catch (err) {
			setPlayground((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : '执行失败',
			}))
			return false
		}
	}

	const handleTogglePlayground = (next: boolean) => {
		if (next && !playground.schema) {
			const ok = runPlayground()
			if (!ok) return
		}
		setPlayground((prev) => ({ ...prev, enabled: next }))
	}

	const utilityPanel = (
		<UtilityPanel
			schemaSource={schemaSource}
			playground={playground}
			activeTab={utilityTab}
			onTabChange={(value) => setUtilityTab(value ?? 'debug')}
			onPlaygroundCodeChange={(value) => setPlayground((prev) => ({ ...prev, code: value }))}
			onPlaygroundRun={runPlayground}
			onPlaygroundReset={() =>
				setPlayground((prev) => ({
					...prev,
					code: PLAYGROUND_TEMPLATE,
					error: undefined,
				}))
			}
			onPlaygroundToggleEnabled={handleTogglePlayground}
		/>
	)

	const mainStyle = isWide
		? { height: 'calc(100vh - 60px)', overflow: 'hidden' }
		: undefined

	return (
		<AppShell
			padding="md"
			header={{ height: 60 }}
			navbar={{
				width: 320,
				breakpoint: 'sm',
				collapsed: { mobile: !navOpened, desktop: false },
			}}
		>
			<AppShell.Header>
				<Group h="100%" px="md" justify="space-between" align="center">
					<Group gap="sm" align="center">
						<Burger opened={navOpened} onClick={toggleNav} hiddenFrom="sm" size="sm" />
						<Title order={3}>valibot-form Demo</Title>
						<Badge variant="light">Playground</Badge>
					</Group>
					<Text size="sm" c="dimmed">
						实用优先 · 布局自动化 · 元数据驱动
					</Text>
				</Group>
			</AppShell.Header>

			<AppShell.Navbar p="md">
				<CaseNav
					groups={CASE_GROUPS}
					groupedCases={groupedCases}
					activeId={activeId}
					onSelect={(id) => {
						setActiveId(id)
						closeNav()
					}}
					query={query}
					onQueryChange={setQuery}
					groupFilter={groupFilter}
					onGroupFilterChange={setGroupFilter}
					tags={caseIndex.tags}
					activeTags={activeTags}
					onToggleTag={handleTagToggle}
					onClearFilters={() => {
						setQuery('')
						setGroupFilter('all')
						setActiveTags([])
					}}
					totalCount={DEMO_CASES.length}
					resultCount={filteredCases.length}
				/>
			</AppShell.Navbar>

			<AppShell.Main style={mainStyle}>
				{activeCase ? (
					<Stack gap="md" style={isWide ? { height: '100%', overflow: 'hidden' } : undefined}>
						<CaseHeader
							caseItem={activeCase}
							stats={stats}
							density={density}
							setDensity={setDensity}
							groupLabel={activeGroup?.label}
							playgroundActive={Boolean(playground.enabled && playground.schema)}
							hasPrev={Boolean(navigation.prevId)}
							hasNext={Boolean(navigation.nextId)}
							onPrev={() => navigation.prevId && setActiveId(navigation.prevId)}
							onNext={() => navigation.nextId && setActiveId(navigation.nextId)}
						/>
						<div style={isWide ? { flex: 1, minHeight: 0 } : undefined}>
							<AutoForm
								schema={resolvedSchema as any}
								formOpts={resolvedFormOpts}
								resetKey={resetKey}
								formProps={
									isWide
										? {
												style: { height: '100%', display: 'flex', flexDirection: 'column' },
											}
										: undefined
								}
							>
								<div
									style={{
										display: 'grid',
										gridTemplateColumns: isWide
											? 'minmax(0, 1fr) minmax(320px, 380px)'
											: 'minmax(0, 1fr)',
										alignItems: 'stretch',
										gap: 'var(--mantine-spacing-md)',
										...(isWide ? { flex: 1, minHeight: 0 } : {}),
									}}
								>
									<FormPanel density={density} />
									{isWide ? utilityPanel : null}
								</div>
								{!isWide ? utilityPanel : null}
							</AutoForm>
						</div>
					</Stack>
				) : (
					<Text size="sm" c="dimmed">
						暂无可展示的表单案例。
					</Text>
				)}
			</AppShell.Main>
		</AppShell>
	)
}
