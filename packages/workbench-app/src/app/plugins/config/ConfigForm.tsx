import { ScrollArea } from '@mantine/core'
import type { PluginNodeAddressSnapshot } from '@pluxel/core'
import type { ObjectSchema } from 'valibot'
import { ConfigTabContent } from './ConfigTab'

export function ConfigForm({
	owner,
	displayName,
	schema,
	savedConfig,
	defaults,
	active = true,
	onDirtyChange,
}: {
	owner: PluginNodeAddressSnapshot
	displayName: string
	schema: ObjectSchema<any, any>
	savedConfig: Record<string, unknown>
	defaults: Record<string, unknown>
	active?: boolean
	onDirtyChange?: (dirty: boolean) => void
}) {
	return (
		<ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
			<ConfigTabContent
				owner={owner}
				displayName={displayName}
				schema={schema}
				savedValue={savedConfig}
				defaultValue={defaults}
				active={active}
				onDirtyChange={onDirtyChange}
			/>
		</ScrollArea>
	)
}
