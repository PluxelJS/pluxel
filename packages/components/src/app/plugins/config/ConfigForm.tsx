import {
	ActionIcon,
	Affix,
	Anchor,
	Badge,
	Box,
	Button,
	Group,
	Paper,
	ScrollArea,
	ScrollAreaAutosize,
	Stack,
	Tabs,
	Text,
	Title,
	Tooltip,
} from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { formOptions } from '@tanstack/react-form'
import {
	IconChevronLeft,
	IconChevronRight,
	IconCircleFilled,
	IconListDetails,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { getDefaults } from 'valibot'
import { AutoForm, useAutoFormCtx } from 'valibot-form/web'
import { useNotify } from '../../hooks'
import { createRpcClient } from '../../rpc'
import { EmptyState } from '../../../components'

export interface ConfigFormProps {
	pluginName: string
	schemas: Record<string, ObjectSchema<any, any>>
	/** 已保存的配置 */
	savedConfig: Record<string, any>
	/** schema 默认值 */
	defaults: Record<string, any>
}

/** 状态徽标 */
function SavedStatus({ dirty, savedAt }: { dirty: boolean; savedAt?: number }) {
	const [now, setNow] = useState(Date.now)
	useEffect(() => {
		if (!savedAt || dirty) return undefined
		const id = setInterval(() => setNow(Date.now), 1000)
		return () => clearInterval(id)
	}, [savedAt, dirty])

	if (dirty)
		return (
			<Badge variant="light" color="yellow">
				已修改
			</Badge>
		)
	if (!savedAt)
		return (
			<Badge variant="light" color="gray">
				未修改
			</Badge>
		)

	const sec = Math.max(0, Math.floor((now - savedAt) / 1000))
	return (
		<Tooltip label={new Date(savedAt).toLocaleString()}>
			<Badge variant="light" color="green">
				已保存 {sec}s 前
			</Badge>
		</Tooltip>
	)
}

/** 悬浮操作条 - 三个按钮 */
function FloatingBar(props: {
	title: string
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
	onSubmit(): void
	onCancel(): void
	onResetToDefaults(): void
	savedAt?: number
}) {
	const { title, dirty, canSubmit, submitting, onSubmit, onCancel, onResetToDefaults, savedAt } =
		props

	return (
		<Affix position={{ bottom: 16, right: 16 }} withinPortal zIndex={1000}>
			<Paper
				withBorder
				radius="xl"
				p="xs"
				shadow="md"
				style={{
					opacity: dirty || submitting ? 1 : 0.7,
					transition: 'opacity 120ms ease',
				}}
				styles={{ root: { '&:hover': { opacity: 1 } } }}
			>
				<Group gap="sm" wrap="nowrap" align="center">
					<Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
						<Text
							fw={600}
							size="sm"
							style={{
								maxWidth: 220,
								overflow: 'hidden',
								whiteSpace: 'nowrap',
								textOverflow: 'ellipsis',
							}}
							title={title}
						>
							{title}
						</Text>
						<SavedStatus dirty={dirty} savedAt={savedAt} />
					</Group>
					<Group gap="xs" wrap="nowrap">
						<Button
							id={`cancel-fab-${title}`}
							variant="default"
							onClick={onCancel}
							disabled={!dirty || submitting}
						>
							取消
						</Button>
						<Button
							id={`reset-fab-${title}`}
							variant="subtle"
							onClick={onResetToDefaults}
							disabled={submitting}
						>
							重置
						</Button>
						<Button
							id={`submit-fab-${title}`}
							onClick={onSubmit}
							disabled={!canSubmit}
							loading={submitting}
						>
							{submitting ? '提交中…' : '提交'}
						</Button>
					</Group>
				</Group>
			</Paper>
		</Affix>
	)
}

function toDomSlug(value: string) {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/gi, '-')
			.replace(/^-+|-+$/g, '') || 'section'
	)
}

function findScrollableParent(node: HTMLElement | null): HTMLElement | null {
	let current: HTMLElement | null = node
	while (current && current !== document.body) {
		const style = getComputedStyle(current)
		const overflowY = style.overflowY
		if (overflowY === 'auto' || overflowY === 'scroll') {
			return current
		}
		current = current.parentElement
	}
	return document.scrollingElement as HTMLElement | null
}

function makeSectionAnchorPrefix(pluginName: string, tabKey: string) {
	return `config-${toDomSlug(pluginName)}-${toDomSlug(tabKey)}-section-`
}

function makeFieldAnchorPrefix(pluginName: string, tabKey: string) {
	return `config-${toDomSlug(pluginName)}-${toDomSlug(tabKey)}-field-`
}

function FormToc({
	sectionIdPrefix,
	fieldIdPrefix,
	scrollHost,
	scrollHostVersion = 0,
}: {
	sectionIdPrefix: string
	fieldIdPrefix: string
	scrollHost?: HTMLElement | null
	scrollHostVersion: number
}) {
	const { sections } = useAutoFormCtx<any>()
	const [anchors, setAnchors] = useState<{ id: string; label: string; depth: number }[]>([])
	const anchorsRef = useRef<typeof anchors>([])
	const [activeId, setActiveId] = useState<string | null>(null)
	const [expanded, setExpanded] = useState(false)
	const peekWidth = 72

	// 计算节点的层级结构
	const buildTree = useCallback((list: { id: string; label: string; depth: number }[]) => {
		const roots: { id: string; label: string; depth: number; children: any[] }[] = []
		const stack: { id: string; label: string; depth: number; children: any[] }[] = []
		for (const anchor of list) {
			const node = {
				id: anchor.id,
				label: anchor.label,
				depth: anchor.depth,
				children: [] as any[],
			}
			while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop()
			if (stack.length) {
				stack[stack.length - 1].children.push(node)
			} else {
				roots.push(node)
			}
			stack.push(node)
		}
		return roots
	}, [])

	useEffect(() => {
		const host = scrollHost ?? document
		let frame = 0
		let observer: MutationObserver | null = null

		const scan = () => {
			frame = 0
			const nodes = Array.from(host.querySelectorAll('[data-config-anchor]')) as HTMLElement[]
			const parsed = nodes.map((el) => ({
				id: el.id,
				label: el.getAttribute('data-config-anchor-label') ?? el.id,
				depth: Number(el.getAttribute('data-config-anchor-depth') ?? 1),
			}))
			anchorsRef.current = parsed
			setAnchors(parsed)
			setActiveId((prev) => prev ?? parsed[0]?.id ?? null)
		}

		scan()
		if (scrollHost && typeof MutationObserver !== 'undefined') {
			observer = new MutationObserver(() => {
				if (frame) cancelAnimationFrame(frame)
				frame = requestAnimationFrame(scan)
			})
			observer.observe(scrollHost, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['id', 'data-config-anchor-label'],
			})
		}

		const root = scrollHost ?? window
		const onScroll = () => {
			if (frame) cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				const scrollTop = scrollHost ? scrollHost.scrollTop : window.scrollY
				const viewport = scrollHost ? scrollHost.clientHeight : window.innerHeight
				const anchorOffset = 72
				let current: { id: string; score: number } | null = null

				for (const anchor of anchorsRef.current) {
					const el = document.getElementById(anchor.id)
					if (!el) continue
					const container =
						(scrollHost && scrollHost.contains(el) ? scrollHost : null) ??
						el.closest<HTMLElement>('[data-config-scroll-root]') ??
						findScrollableParent(el)
					const pos =
						container &&
						container !== document.scrollingElement &&
						container !== document.documentElement
							? el.getBoundingClientRect().top -
								container.getBoundingClientRect().top +
								container.scrollTop
							: el.getBoundingClientRect().top + window.scrollY
					const delta = Math.abs(pos - scrollTop - anchorOffset)
					const inView = pos >= scrollTop - 20 && pos < scrollTop + viewport - 120
					const score = inView ? delta * 0.5 : delta
					if (!current || score < current.score) {
						current = { id: anchor.id, score }
					}
				}
				if (current?.id) setActiveId(current.id)
			})
		}
		root.addEventListener('scroll', onScroll, { passive: true })
		onScroll()

		return () => {
			root.removeEventListener('scroll', onScroll)
			if (observer) observer.disconnect()
			if (frame) cancelAnimationFrame(frame)
		}
	}, [scrollHost, sections.length, sectionIdPrefix, fieldIdPrefix, scrollHostVersion])

	const items = useMemo(() => buildTree(anchors), [anchors, buildTree])

	const scrollToSection = useCallback(
		(id: string) => {
			if (!id) return
			const target = document.getElementById(id)
			if (!target) return
			const scrollMarginTop =
				Number.parseFloat(getComputedStyle(target).scrollMarginTop || '0') || 0
			const container =
				(scrollHost && scrollHost.contains(target) ? scrollHost : null) ??
				target.closest<HTMLElement>('[data-config-scroll-root]') ??
				findScrollableParent(target)

			if (
				container &&
				container !== document.scrollingElement &&
				container !== document.documentElement
			) {
				const targetBox = target.getBoundingClientRect()
				const hostBox = container.getBoundingClientRect()
				const top = targetBox.top - hostBox.top + container.scrollTop - scrollMarginTop
				container.scrollTo({ top, behavior: 'smooth' })
			} else {
				const top = target.getBoundingClientRect().top + window.scrollY - scrollMarginTop
				window.scrollTo({ top, behavior: 'smooth' })
			}
		},
		[scrollHost],
	)

	if (!items.length) return null

	const renderNode = (node: { id: string; label: string; children: any[] }, depth = 0) => {
		const isActive = node.id === activeId
		return (
			<Box
				key={node.id}
				onClick={(e) => {
					e.stopPropagation()
					scrollToSection(node.id)
				}}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault()
						e.stopPropagation()
						scrollToSection(node.id)
					}
				}}
				style={{
					borderRadius: 12,
					padding: '10px 12px',
					cursor: 'pointer',
					border: `1px solid ${isActive ? 'var(--mantine-color-blue-outline)' : 'var(--mantine-color-default-border)'}`,
					backgroundColor: isActive
						? 'var(--mantine-color-blue-light)'
						: 'var(--mantine-color-body)',
					boxShadow: isActive ? 'var(--mantine-shadow-sm)' : 'none',
					marginLeft: depth ? 10 : 0,
					position: 'relative',
				}}
			>
				<Group justify="space-between" align="center" gap={6} style={{ minWidth: 0 }}>
					<Group gap={6} align="center" style={{ minWidth: 0 }}>
						<IconCircleFilled size={12} color="var(--mantine-color-blue-filled)" />
						<Text
							size="sm"
							fw={isActive ? 700 : 600}
							style={{ flex: 1, minWidth: 0 }}
							lineClamp={1}
						>
							{node.label}
						</Text>
					</Group>
					{node.children.length ? (
						<Badge variant="light" size="xs" color="gray">
							{node.children.length}
						</Badge>
					) : null}
				</Group>
				{node.children.length ? (
					<Stack gap={6} mt={8}>
						{node.children.map((child) => renderNode(child, depth + 1))}
					</Stack>
				) : null}
			</Box>
		)
	}

	return (
		<Box
			onMouseEnter={() => setExpanded(true)}
			onMouseLeave={() => setExpanded(false)}
			onFocus={() => setExpanded(true)}
			onBlur={() => setExpanded(false)}
			style={{ width: 320, maxWidth: '80vw' }}
		>
			<Paper
				withBorder
				shadow="md"
				p="sm"
				radius="lg"
				style={{
					transition: 'transform 160ms ease, box-shadow 160ms ease',
					transform: expanded ? 'translateX(0)' : `translateX(calc(100% - ${peekWidth}px))`,
					maxHeight: '72vh',
					overflow: 'hidden',
					backgroundColor: 'var(--mantine-color-body)',
					border: '1px solid var(--mantine-color-default-border)',
					boxShadow: expanded ? 'var(--mantine-shadow-lg)' : 'var(--mantine-shadow-sm)',
				}}
			>
				<Stack gap="xs" style={{ height: '100%' }}>
					<Group justify="space-between" align="center" gap="xs">
						<Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
							<IconListDetails size={18} color="var(--mantine-color-blue-filled)" />
							<Text
								size="sm"
								fw={700}
								style={{
									whiteSpace: 'nowrap',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									maxWidth: peekWidth - 12,
								}}
							>
								配置导航
							</Text>
							<Badge size="xs" variant="light" color="blue">
								TOC
							</Badge>
						</Group>
						<ActionIcon
							variant="subtle"
							aria-label={expanded ? '收起目录' : '展开目录'}
							onClick={() => setExpanded((v) => !v)}
						>
							{expanded ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
						</ActionIcon>
					</Group>
					<Text size="xs" c="dimmed">
						悬停展开，点击跳转到对应 section/字段。
					</Text>
					<ScrollArea style={{ maxHeight: '62vh' }} type="auto" scrollbarSize={8}>
						<Stack gap="xs" pr={4}>
							{items.map((item) => renderNode(item))}
						</Stack>
					</ScrollArea>
				</Stack>
			</Paper>
		</Box>
	)
}

/** 单个配置 Tab */
function ConfigTabContent({
	pluginName,
	tabKey,
	schema,
	savedValue,
	defaultValue,
	onSaved,
	savedAt,
	showToc,
	sectionIdPrefix,
	fieldIdPrefix,
	scrollHost,
	scrollHostVersion,
}: {
	tabKey: string
	pluginName: string
	schema: ObjectSchema<any, any>
	savedValue: Record<string, any>
	defaultValue: Record<string, any>
	onSaved: (k: string) => void
	savedAt?: number
	showToc?: boolean
	sectionIdPrefix?: string
	fieldIdPrefix?: string
	scrollHost?: HTMLElement | null
	scrollHostVersion?: number
}) {
	const notify = useNotify()
	const sectionAnchorPrefix = useMemo(
		() => sectionIdPrefix ?? makeSectionAnchorPrefix(pluginName, tabKey),
		[pluginName, sectionIdPrefix, tabKey],
	)
	const fieldAnchorPrefix = useMemo(
		() => fieldIdPrefix ?? makeFieldAnchorPrefix(pluginName, tabKey),
		[fieldIdPrefix, pluginName, tabKey],
	)

	// 初始值 = defaults 合并 savedConfig
	const initialValue = useMemo(
		() => ({ ...defaultValue, ...savedValue }),
		[defaultValue, savedValue],
	)

	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: initialValue,
				onSubmit: async ({ value, formApi }) => {
					using rpc = createRpcClient()
					const result = await rpc.plugin(pluginName).saveConfig({ [tabKey]: value })
					if (result.ok === false) {
						// 应用服务端验证错误到表单字段
						if (result.code === 'validation_failed' && result.errors) {
							const fieldErrors = result.errors[tabKey]
							if (fieldErrors) {
								for (const [fieldName, issues] of Object.entries(fieldErrors)) {
									if (fieldName === '_root' || fieldName === '_unknown') continue
									// valibot-form 期望 errors 格式为 { message, dotPath }
									// tanstack form 会把 errorMap 的每个值作为 errors 数组的一个元素
									formApi.setFieldMeta(fieldName as any, (meta) => ({
										...meta,
										errorMap: {
											...meta.errorMap,
											onSubmit: {
												message: issues.map((i) => i.message).join('; '),
												dotPath: issues[0]?.path ?? [],
											},
										},
									}))
								}
							}
						}
						notify({
							title: '提交失败',
							message: result.message ?? result.code ?? '未知错误',
							color: 'red',
						})
						return
					}
					onSaved(tabKey)
					notify({ title: '提交成功', message: `配置 ${tabKey} 已保存`, color: 'green' })
				},
			}),
		[tabKey, initialValue, onSaved, notify, pluginName],
	)

	// memoize hotkeys 配置
	const hotkeys = useMemo(
		(): [string, (e: KeyboardEvent) => void][] => [
			[
				'mod+S',
				(e) => {
					e.preventDefault()
					document.getElementById(`submit-fab-${tabKey}`)?.click()
				},
			],
			['Escape', () => document.getElementById(`cancel-fab-${tabKey}`)?.click()],
		],
		[tabKey],
	)
	useHotkeys(hotkeys)

	return (
		<AutoForm key={`${pluginName}-${tabKey}`} schema={schema as any} formOpts={opts}>
			{showToc ? (
				<Affix position={{ top: 86, right: 16 }} zIndex={950} withinPortal>
					<FormToc
						sectionIdPrefix={sectionAnchorPrefix}
						fieldIdPrefix={fieldAnchorPrefix}
						scrollHost={scrollHost}
						scrollHostVersion={scrollHostVersion}
					/>
				</Affix>
			) : null}
			<Box px="sm" pb={96} style={{ position: 'relative' }}>
				<AutoForm.Fields sectionIdPrefix={sectionAnchorPrefix} fieldIdPrefix={fieldAnchorPrefix} />
			</Box>
			<AutoForm.Actions>
				{({ submit, reset, dirty, canSubmit, submitting }) => (
					<FloatingBar
						title={tabKey}
						dirty={dirty}
						canSubmit={canSubmit}
						submitting={submitting}
						onSubmit={submit}
						onCancel={() => reset(initialValue)}
						onResetToDefaults={() => reset(defaultValue)}
						savedAt={savedAt}
					/>
				)}
			</AutoForm.Actions>
		</AutoForm>
	)
}

function ConfigTabPanel(props: Parameters<typeof ConfigTabContent>[0]) {
	return (
		<Tabs.Panel
			value={props.tabKey}
			pt="md"
			style={{
				flex: 1,
				minHeight: 0,
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		>
			<ConfigTabContent {...props} />
		</Tabs.Panel>
	)
}

export function ConfigForm({ pluginName, schemas, savedConfig, defaults }: ConfigFormProps) {
	const safeSchemas = schemas ?? {}
	const keys = useMemo(() => Object.keys(safeSchemas), [safeSchemas])
	const [tab, setTab] = useState(keys[0] || '')
	const [savedAtMap, setSavedAtMap] = useState<Record<string, number | undefined>>({})
	const scrollHostsRef = useRef<Record<string, HTMLDivElement | null>>({})
	const [scrollHostVersion, setScrollHostVersion] = useState(0)
	const onSaved = useCallback((k: string) => setSavedAtMap((m) => ({ ...m, [k]: Date.now() })), [])

	useEffect(() => {
		setTab((prev) => {
			if (prev && keys.includes(prev)) return prev
			return keys[0] ?? ''
		})
	}, [keys])

	const items = useMemo(() => {
		return keys.map((key) => {
			const schema = safeSchemas[key]!
			const schemaDefaults = getDefaults(schema) as Record<string, any>
			return {
				key,
				schema,
				savedValue: savedConfig[key] ?? {},
				defaultValue: { ...schemaDefaults, ...(defaults[key] ?? {}) },
			}
		})
	}, [safeSchemas, savedConfig, defaults, keys])

	const hasConfig = items.length > 0

	return (
		<Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
			<Group justify="space-between" mb="md" wrap="nowrap">
				<Title
					order={3}
					style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
					title={`${pluginName} 配置`}
				>
					{pluginName} 配置
				</Title>
				<Anchor href={`/plugins/${pluginName}/docs`} target="_blank" rel="noreferrer">
					查看文档
				</Anchor>
			</Group>

			{!hasConfig ? (
				<Paper withBorder radius="lg" p="xl" style={{ flex: 1, minHeight: 0 }}>
					<EmptyState
						title="暂无可填写的配置"
						description="该插件当前未公开任何配置 schema。"
						icon={null}
						minHeight="auto"
					/>
				</Paper>
			) : (
				<Tabs
					value={tab}
					onChange={(v) => setTab(String(v))}
					variant="outline"
					keepMounted={false}
					style={{
						display: 'flex',
						flexDirection: 'column',
						flex: 1,
						minHeight: 0,
						overflow: 'hidden',
					}}
				>
					<Tabs.List>
						{keys.map((k) => (
							<Tabs.Tab key={k} value={k}>
								{k}
							</Tabs.Tab>
						))}
					</Tabs.List>

					{items.map(({ key, schema, savedValue, defaultValue }) => (
						<ScrollAreaAutosize
							key={`${pluginName}-${key}`}
							type="auto"
							scrollbarSize={10}
							offsetScrollbars
							viewportRef={(node) => {
								if (node && scrollHostsRef.current[key] !== node) {
									node.dataset.configScrollRoot = 'true'
									scrollHostsRef.current[key] = node
									setScrollHostVersion((v) => v + 1)
								}
							}}
						>
							<ConfigTabPanel
								pluginName={pluginName}
								tabKey={key}
								schema={schema}
								savedValue={savedValue}
								defaultValue={defaultValue}
								onSaved={onSaved}
								savedAt={savedAtMap[key]}
								showToc
								sectionIdPrefix={makeSectionAnchorPrefix(pluginName, key)}
								fieldIdPrefix={makeFieldAnchorPrefix(pluginName, key)}
								scrollHost={scrollHostsRef.current[key]}
								scrollHostVersion={scrollHostVersion}
							/>
						</ScrollAreaAutosize>
					))}
				</Tabs>
			)}
		</Box>
	)
}
