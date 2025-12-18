import {
	Anchor,
	Box,
	Group,
	Paper,
	ScrollAreaAutosize,
	Tabs,
	Title,
} from '@mantine/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { getDefaults } from 'valibot'
import { EmptyState } from '../../../components'
import { ConfigTabPanel } from './ConfigTab'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './utils'

export interface ConfigFormProps {
	pluginName: string
	schemas: Record<string, ObjectSchema<any, any>>
	/** 已保存的配置 */
	savedConfig: Record<string, any>
	/** schema 默认值 */
	defaults: Record<string, any>
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
			<Anchor href={`/plugins/${encodeURIComponent(pluginName)}/docs`} target="_blank" rel="noreferrer">
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
