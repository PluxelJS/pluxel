import { Loader, Paper, Select, Stack, Text } from '@mantine/core'
import { useMemo } from 'react'
import type { WorkbenchResourceSelectBlock as BuiltinResourceSelectBlock } from '@pluxel/runtime/workbench'
import { useWorkbenchView } from '@pluxel/runtime/workbench/ui/internal'
import {
	useBoundSignalDbCollectionsState,
	useGlobalExtensionContext,
	type SignalDbCollectionView,
	type SignalDbItem,
} from '@pluxel/runtime/web'
import { readNested, readString, useConfigFieldBridge } from '../internal/config-field-bridge'

type ResourceSelectOption = {
	value: string
	label: string
	description?: string
	rawValue: unknown
	rawLabel: string
}

function optionKey(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
		return String(value)
	}
	return JSON.stringify(value)
}

export function BuiltinResourceSelect({
	targetPluginName,
	block,
}: {
	targetPluginName: string
	block: BuiltinResourceSelectBlock
}) {
	const ctx = useGlobalExtensionContext()
	const transport = ctx.services.transport
	const item = useWorkbenchView()
	const targetPlugin = readString(block.target.pluginName) ?? targetPluginName
	const schemaKey = readString(block.target.schemaKey) ?? ''
	const fieldPath = readString(block.target.field) ?? ''
	const valueField = readString(block.valueField) ?? 'id'
	const labelField = readString(block.labelField) ?? ''
	const descriptionField = readString(block.descriptionField ?? '') ?? ''
	const mode = block.target.mode ?? 'value'
	const collections = useBoundSignalDbCollectionsState(
		transport,
		useMemo(() => {
			const resource = item.model[block.collection]
			return resource?.kind === 'collection' ? { [block.collection]: resource.grantId } : {}
		}, [block.collection, item]),
	)
	const collection = collections[block.collection] as
		| SignalDbCollectionView<Record<string, unknown> & SignalDbItem>
		| undefined
	const bridge = useConfigFieldBridge({
		targetPlugin,
		schemaKey,
		fieldPath,
	})

	const options = useMemo(() => {
		if (!collection) return []
		const docs = collection.find()
		return docs
			.map((doc) => {
				const rawValue = readNested(doc, valueField)
				const rawLabel = readNested(doc, labelField)
				if (rawValue === undefined) return null
				const value = optionKey(rawValue)
				const label = rawLabel === undefined || rawLabel === null ? value : String(rawLabel)
				const description =
					descriptionField && readNested(doc, descriptionField) != null
						? String(readNested(doc, descriptionField))
						: undefined
				return {
					value,
					label,
					description,
					rawValue,
					rawLabel: label,
				} satisfies ResourceSelectOption
			})
			.filter(Boolean) as ResourceSelectOption[]
	}, [collection, descriptionField, labelField, valueField])

	const selectedValue = useMemo(() => {
		const current = bridge.fieldValue
		if (mode === 'ref' && current && typeof current === 'object') {
			const currentId = (current as Record<string, unknown>).id
			return currentId === undefined ? null : optionKey(currentId)
		}
		return current === undefined || current === null ? null : optionKey(current)
	}, [bridge.fieldValue, mode])

	const selectedOption = useMemo(
		() => options.find((option) => option.value === selectedValue) ?? null,
		[options, selectedValue],
	)

	if (!collection) {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Text size="xs" c="red">
					Workbench collection resource is unavailable: {block.collection}
				</Text>
			</Paper>
		)
	}

	if (bridge.loading && !bridge.config.data) {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Stack gap="xs">
					<Text size="xs" c="dimmed">
						正在加载配置…
					</Text>
					<Loader size="sm" />
				</Stack>
			</Paper>
		)
	}

	if (bridge.error) {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Text size="sm" c="red">
					Failed to load target config: {bridge.error.message}
				</Text>
			</Paper>
		)
	}

	if (!schemaKey || !fieldPath) {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Text size="sm" c="red">
					resourceSelect requires target.schemaKey and target.field
				</Text>
			</Paper>
		)
	}

	if (!bridge.schemaExists) {
		return (
			<Paper withBorder radius="md" p="sm" shadow="xs">
				<Text size="sm" c="red">
					Unknown target schema key: {schemaKey}
				</Text>
			</Paper>
		)
	}

	const handleChange = async (nextValue: string | null) => {
		if (bridge.saving) return
		const nextOption =
			nextValue == null ? null : (options.find((option) => option.value === nextValue) ?? null)
		const nextFieldValue =
			nextOption == null
				? null
				: mode === 'ref'
					? {
							provider: item.ownerPluginId,
							kind: readString(block.target.refKind) ?? block.collection,
							id: nextOption.rawValue,
							...(block.target.includeLabel === false ? {} : { label: nextOption.rawLabel }),
						}
					: nextOption.rawValue
		try {
			await bridge.saveFieldValue(nextFieldValue)
			ctx.services.ui.notify({
				tone: block.feedback?.success?.tone ?? 'success',
				title: block.feedback?.success?.title ?? '已更新',
				message: block.feedback?.success?.message ?? `${block.label} 已保存到 ${targetPlugin}`,
			})
		} catch (error) {
			ctx.services.ui.notify({
				tone: block.feedback?.error?.tone ?? 'error',
				title: block.feedback?.error?.title ?? '保存失败',
				message:
					block.feedback?.error?.message ??
					(error instanceof Error ? error.message : String(error ?? 'unknown error')),
			})
		}
	}

	return (
		<Paper withBorder radius="md" p="sm" shadow="xs">
			<Stack gap="xs">
				<Select
					size="sm"
					label={block.label}
					description={block.description}
					placeholder={block.placeholder ?? '请选择'}
					data={options.map((option) => ({
						value: option.value,
						label: option.label,
					}))}
					value={selectedValue}
					onChange={(value) => void handleChange(value)}
					disabled={bridge.saving || !collection.ready}
					clearable={block.clearable ?? true}
					searchable
					nothingFoundMessage={block.nothingFoundMessage ?? '暂无可选项'}
				/>
				{selectedOption?.description ? (
					<Text size="xs" c="dimmed">
						{selectedOption.description}
					</Text>
				) : null}
				{!collection.ready ? (
					<Text size="xs" c="dimmed">
						正在同步资源列表…
					</Text>
				) : null}
			</Stack>
		</Paper>
	)
}
