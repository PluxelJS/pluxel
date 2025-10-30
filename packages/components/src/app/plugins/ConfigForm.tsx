import {
	Affix,
	Anchor,
	Badge,
	Box,
	Button,
	Group,
	Paper,
	ScrollAreaAutosize,
	Tabs,
	Text,
	Title,
	Tooltip,
} from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { notifications } from '@mantine/notifications'
import { formOptions } from '@tanstack/react-form'
import type { InferRequestType, InferResponseType } from 'hono/client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InferOutput, ObjectSchema } from 'valibot'
import { getDefaults } from 'valibot'
import { AutoForm } from 'valibot-form/web'
import { client } from '../rpc'
export interface ConfigFormProps {
	pluginName: string
	configs: Record<string, ObjectSchema<any, any>>
	existConfigs?: any
}

/** 徽标：已修改 / 未修改 / 已保存几秒前（带 1s 自刷） */
function SavedStatus({ dirty, savedAt }: { dirty: boolean; savedAt?: number }) {
	const [, force] = useState(0)
	useEffect(() => {
		if (!savedAt || dirty) return
		const id = setInterval(() => force((n) => n + 1), 1000)
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

	const sec = Math.max(0, Math.floor((Date.now() - savedAt) / 1000))
	return (
		<Tooltip label={new Date(savedAt).toLocaleString()}>
			<Badge variant="light" color="green">
				已保存 {sec}s 前
			</Badge>
		</Tooltip>
	)
}

/** 底部悬浮操作条：集成标题 + 状态 + 操作 */
function FloatingBar(props: {
	title: string
	dirty: boolean
	canSubmit: boolean
	submitting: boolean
	onSubmit(): void
	onReset(): void
	savedAt?: number
}) {
	const { title, dirty, canSubmit, submitting, onSubmit, onReset, savedAt } = props

	// 干净时半透明，脏/提交中满不透明；鼠标移上去也满不透明
	const [hovered, setHovered] = useState(false)
	const opacity = dirty || submitting || hovered ? 1 : 0.7

	return (
		<Affix position={{ bottom: 16, right: 16 }} withinPortal zIndex={1000}>
			<Paper
				withBorder
				radius="xl"
				p="xs"
				shadow="md"
				onMouseEnter={() => setHovered(true)}
				onMouseLeave={() => setHovered(false)}
				style={{ opacity, transition: 'opacity 120ms ease' }}
			>
				<Group gap="sm" wrap="nowrap" align="center">
					{/* 左侧：标题 + 状态 */}
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
					{/* 右侧：操作 */}
					<Group gap="xs" wrap="nowrap">
						<Button
							id={`reset-fab-${title}`}
							variant="default"
							onClick={onReset}
							disabled={!dirty || submitting}
							type="button"
						>
							取消
						</Button>
						<Button
							id={`submit-fab-${title}`}
							onClick={onSubmit}
							disabled={!canSubmit}
							loading={submitting}
							type="button"
						>
							{submitting ? '提交中…' : '提交'}
						</Button>
					</Group>
				</Group>
			</Paper>
		</Affix>
	)
}

/** 单个 Tab 面板（Hook 不在 .map 内定义） */
function ConfigTabPanel({
	pluginName,
	tabKey,
	schema,
	defaults,
	onSaved,
	savedAt,
}: {
	tabKey: string
	pluginName: string
	schema: ObjectSchema<any, any>
	defaults: InferOutput<typeof schema>
	onSaved: (k: string) => void
	savedAt?: number
}) {
	const $post = client.plugins[':name'].config.$post
	type BasePayload = InferRequestType<typeof $post>['json']
	type Payload = BasePayload & { signal?: AbortSignal }
	type Response = InferResponseType<typeof $post>

	const mutate = useCallback(
		async (body: Payload): Promise<Response> => {
			const { signal, ...payload } = body
			try {
				const res = await $post(
					{ param: { name: pluginName }, json: payload as BasePayload },
					{ init: { signal } },
				)
				return (await res.json()) as Response
			} catch (error: any) {
				if (signal?.aborted) throw error
				notifications.show({
					title: '网络或服务器错误',
					message: String(error?.message ?? error),
					color: 'red',
				})
				throw error instanceof Error ? error : new Error(String(error))
			}
		},
		[$post, pluginName],
	)

	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: defaults,
				asyncAlways: true,
				asyncDebounceMs: 200,
				validators: {
					onChangeAsync: async ({ value, signal }) => {
						const result = await mutate({
							isSubmitAction: false,
							formData: { [tabKey]: value },
							signal,
						})
						if (result.code === 'validation_error') {
							return { fields: result.errors[tabKey] }
						}
					},
				},
				onSubmit: async ({ value }) => {
					const result = await mutate({
						isSubmitAction: true,
						formData: { [tabKey]: value },
					})
					if (result.code !== 'success') {
						notifications.show({
							title: '提交失败',
							message: result.code,
							color: 'red',
						})
					} else {
						onSaved(tabKey)
						notifications.show({
							title: '提交成功',
							message: `配置 ${tabKey} 已提交到服务器。`,
						})
					}
				},
			}),
		[mutate, tabKey, defaults, onSaved],
	)

	useHotkeys([
		[
			'mod+S',
			(e) => {
				e.preventDefault()
				;(document.getElementById(`submit-fab-${tabKey}`) as HTMLButtonElement)?.click()
			},
		],
		[
			'Escape',
			() => (document.getElementById(`reset-fab-${tabKey}`) as HTMLButtonElement)?.click(),
		],
	])

	return (
		<Tabs.Panel
			value={tabKey}
			pt="md"
			style={{
				flex: 1,
				minHeight: 0,
				display: 'flex',
				flexDirection: 'column',
				overflow: 'hidden',
			}}
		>
			<AutoForm schema={schema as any} formOpts={opts}>
				<Box px="sm" pb={96}>
					<AutoForm.Fields />
				</Box>

				<AutoForm.Actions>
					{({ submit, reset, dirty, canSubmit, submitting }) => (
						<FloatingBar
							title={tabKey}
							dirty={dirty}
							canSubmit={canSubmit}
							submitting={submitting}
							onSubmit={submit}
							onReset={reset}
							savedAt={savedAt}
						/>
					)}
				</AutoForm.Actions>
			</AutoForm>
		</Tabs.Panel>
	)
}

export function ConfigForm({ pluginName, configs, existConfigs }: ConfigFormProps) {
	const keys = useMemo(() => Object.keys(configs), [configs])
	const [tab, setTab] = useState(keys[0] || '')

	// 预计算每个 Tab 的 schema + 默认值
	const items = useMemo(() => {
		return keys.map((key) => {
			const schema = configs[key]!
			const exist = (existConfigs?.[key] ?? {}) as Record<string, any>
			const defaults = Object.assign(getDefaults(schema) as any, exist) as InferOutput<
				typeof schema
			>
			return { key, schema, defaults }
		})
	}, [configs, existConfigs, keys])

	// 保存时间（给状态用）
	const [savedAtMap, setSavedAtMap] = useState<Record<string, number | undefined>>({})
	const onSaved = (k: string) => setSavedAtMap((m) => ({ ...m, [k]: Date.now() }))

	return (
		<Box
			style={{
				display: 'flex',
				flexDirection: 'column',
				flex: 1,
				minHeight: 0,
				minWidth: 0,
			}}
		>
			{/* 页头（静态信息，不再塞操作） */}
			<Group justify="space-between" mb="md" wrap="nowrap">
				<Title
					order={3}
					style={{
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
					title={`${pluginName} 配置`}
				>
					{pluginName} 配置
				</Title>
				<Anchor href={`/plugins/${pluginName}/docs`} target="_blank" rel="noreferrer">
					查看文档
				</Anchor>
			</Group>

			<Tabs
				value={tab}
				onChange={(v) => setTab(String(v))}
				variant="outline"
				keepMounted={false} // 只渲染当前面板，避免多份 Affix
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

				{items.map(({ key, schema, defaults }) => (
					<ScrollAreaAutosize key={key}>
						<ConfigTabPanel
							pluginName={pluginName}
							key={key}
							tabKey={key}
							schema={schema}
							defaults={defaults}
							onSaved={onSaved}
							savedAt={savedAtMap[key]}
						/>
					</ScrollAreaAutosize>
				))}
			</Tabs>
		</Box>
	)
}
