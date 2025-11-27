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
import { formOptions } from '@tanstack/react-form'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { getDefaults } from 'valibot'
import { AutoForm } from 'valibot-form/web'
import { useNotify } from '../notifications/useNotify'
import { client } from '../rpc'

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

	if (dirty) return <Badge variant="light" color="yellow">已修改</Badge>
	if (!savedAt) return <Badge variant="light" color="gray">未修改</Badge>

	const sec = Math.max(0, Math.floor((now - savedAt) / 1000))
	return (
		<Tooltip label={new Date(savedAt).toLocaleString()}>
			<Badge variant="light" color="green">已保存 {sec}s 前</Badge>
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
	const { title, dirty, canSubmit, submitting, onSubmit, onCancel, onResetToDefaults, savedAt } = props

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
						<Text fw={600} size="sm" style={{ maxWidth: 220, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }} title={title}>
							{title}
						</Text>
						<SavedStatus dirty={dirty} savedAt={savedAt} />
					</Group>
					<Group gap="xs" wrap="nowrap">
						<Button id={`cancel-fab-${title}`} variant="default" onClick={onCancel} disabled={!dirty || submitting}>
							取消
						</Button>
						<Button id={`reset-fab-${title}`} variant="subtle" onClick={onResetToDefaults} disabled={submitting}>
							重置
						</Button>
						<Button id={`submit-fab-${title}`} onClick={onSubmit} disabled={!canSubmit} loading={submitting}>
							{submitting ? '提交中…' : '提交'}
						</Button>
					</Group>
				</Group>
			</Paper>
		</Affix>
	)
}

/** 单个配置 Tab */
function ConfigTabPanel({
	pluginName,
	tabKey,
	schema,
	savedValue,
	defaultValue,
	onSaved,
	savedAt,
}: {
	tabKey: string
	pluginName: string
	schema: ObjectSchema<any, any>
	savedValue: Record<string, any>
	defaultValue: Record<string, any>
	onSaved: (k: string) => void
	savedAt?: number
}) {
	const notify = useNotify()

	// 初始值 = defaults 合并 savedConfig
	const initialValue = useMemo(
		() => ({ ...defaultValue, ...savedValue }),
		[defaultValue, savedValue],
	)

	const opts = useMemo(
		() =>
			formOptions({
				defaultValues: initialValue,
				onSubmit: async ({ value }) => {
					const res = await client.plugins[':name'].config.$post({
						param: { name: pluginName },
						json: { [tabKey]: value },
					})
					const result = (await res.json()) as any
					if (result.ok) {
						onSaved(tabKey)
						notify({ title: '提交成功', message: `配置 ${tabKey} 已保存`, color: 'green' })
					} else {
						notify({ title: '提交失败', message: result.message ?? result.code ?? '未知错误', color: 'red' })
					}
				},
			}),
		[tabKey, initialValue, onSaved, notify, pluginName],
	)

	// memoize hotkeys 配置
	const hotkeys = useMemo((): [string, (e: KeyboardEvent) => void][] => [
		['mod+S', (e) => { e.preventDefault(); document.getElementById(`submit-fab-${tabKey}`)?.click() }],
		['Escape', () => document.getElementById(`cancel-fab-${tabKey}`)?.click()],
	], [tabKey])
	useHotkeys(hotkeys)

	return (
		<Tabs.Panel value={tabKey} pt="md" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
			<AutoForm schema={schema as any} formOpts={opts}>
				<Box px="sm" pb={96}>
					<AutoForm.Fields />
				</Box>
				<AutoForm.Actions>
					{({ submit, setValues, dirty, canSubmit, submitting }) => (
						<FloatingBar
							title={tabKey}
							dirty={dirty}
							canSubmit={canSubmit}
							submitting={submitting}
							onSubmit={submit}
							onCancel={() => setValues(initialValue)}
							onResetToDefaults={() => setValues(defaultValue)}
							savedAt={savedAt}
						/>
					)}
				</AutoForm.Actions>
			</AutoForm>
		</Tabs.Panel>
	)
}

export function ConfigForm({ pluginName, schemas, savedConfig, defaults }: ConfigFormProps) {
	const keys = useMemo(() => Object.keys(schemas), [schemas])
	const [tab, setTab] = useState(keys[0] || '')
	const [savedAtMap, setSavedAtMap] = useState<Record<string, number | undefined>>({})
	const onSaved = useCallback((k: string) => setSavedAtMap((m) => ({ ...m, [k]: Date.now() })), [])

	const items = useMemo(() => {
		return keys.map((key) => {
			const schema = schemas[key]!
			const schemaDefaults = getDefaults(schema) as Record<string, any>
			return {
				key,
				schema,
				savedValue: savedConfig[key] ?? {},
				defaultValue: { ...schemaDefaults, ...(defaults[key] ?? {}) },
			}
		})
	}, [schemas, savedConfig, defaults, keys])

	return (
		<Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
			<Group justify="space-between" mb="md" wrap="nowrap">
				<Title order={3} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${pluginName} 配置`}>
					{pluginName} 配置
				</Title>
				<Anchor href={`/plugins/${pluginName}/docs`} target="_blank" rel="noreferrer">
					查看文档
				</Anchor>
			</Group>

			<Tabs value={tab} onChange={(v) => setTab(String(v))} variant="outline" keepMounted={false}
				style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
				<Tabs.List>
					{keys.map((k) => <Tabs.Tab key={k} value={k}>{k}</Tabs.Tab>)}
				</Tabs.List>

				{items.map(({ key, schema, savedValue, defaultValue }) => (
					<ScrollAreaAutosize key={key}>
						<ConfigTabPanel
							pluginName={pluginName}
							tabKey={key}
							schema={schema}
							savedValue={savedValue}
							defaultValue={defaultValue}
							onSaved={onSaved}
							savedAt={savedAtMap[key]}
						/>
					</ScrollAreaAutosize>
				))}
			</Tabs>
		</Box>
	)
}
