import { ScrollArea, Tabs } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { useRef } from 'react'
import type { ObjectSchema } from 'valibot'
import { ConfigTabContent } from './ConfigTab'
import type { PluginConfigSection } from './usePluginConfig'

const EMPTY_CONFIG_SECTIONS: readonly PluginConfigSection[] = []

export function ConfigForm({
	owner,
	displayName,
	schema,
	savedConfig,
	defaults,
	active = true,
	onDirtyChange,
	sections = EMPTY_CONFIG_SECTIONS,
}: {
	owner: PluginNodeAddress
	displayName: string
	schema: ObjectSchema<any, any>
	savedConfig: Record<string, unknown>
	defaults: Record<string, unknown>
	active?: boolean
	onDirtyChange?: (dirty: boolean) => void
	sections?: readonly PluginConfigSection[]
}) {
	const visibleSections =
		sections.length > 0 ? sections : [{ path: [], schema, defaults, fieldName: '' }]
	const formIdentity = `${JSON.stringify(owner)}\0${visibleSections
		.map((section) => section.path.join('.'))
		.join('\0')}`
	const dirtySections = useRef({ identity: formIdentity, values: new Map<string, boolean>() })
	if (dirtySections.current.identity !== formIdentity) {
		dirtySections.current = { identity: formIdentity, values: new Map() }
	}
	const sectionValue = (record: Record<string, unknown>, path: readonly string[]) => {
		let value: unknown = record
		for (const segment of path) {
			value =
				value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
		const blocked = new Set(
			sections
				.filter(
					(section) =>
						section.path.length > path.length &&
						path.every((segment, index) => section.path[index] === segment),
				)
				.map((section) => section.path[path.length]!),
		)
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).filter(([key]) => !blocked.has(key)),
		)
	}
	const label = (path: readonly string[]) => (path.length === 0 ? 'General' : path.join(' / '))
	const content = (section: (typeof visibleSections)[number]) => {
		const key = section.path.join('.') || 'general'
		return (
			<ConfigTabContent
				owner={owner}
				displayName={displayName}
				schema={section.schema}
				savedValue={sectionValue(savedConfig, section.path)}
				defaultValue={section.defaults}
				path={section.path}
				active={active}
				onDirtyChange={
					onDirtyChange
						? (dirty) => {
								if (dirtySections.current.identity !== formIdentity) return
								dirtySections.current.values.set(key, dirty)
								onDirtyChange([...dirtySections.current.values.values()].some(Boolean))
							}
						: undefined
				}
			/>
		)
	}
	return (
		<ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
			{visibleSections.length === 1 ? (
				content(visibleSections[0]!)
			) : (
				<Tabs defaultValue={visibleSections[0]!.path.join('.') || 'general'}>
					<Tabs.List px="xs">
						{visibleSections.map((section) => {
							const key = section.path.join('.') || 'general'
							return (
								<Tabs.Tab value={key} key={key}>
									{label(section.path)}
								</Tabs.Tab>
							)
						})}
					</Tabs.List>
					{visibleSections.map((section) => {
						const key = section.path.join('.') || 'general'
						return (
							<Tabs.Panel value={key} key={key}>
								{content(section)}
							</Tabs.Panel>
						)
					})}
				</Tabs>
			)}
		</ScrollArea>
	)
}
