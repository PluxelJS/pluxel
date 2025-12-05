// packages/hmr/tests/plugins/ui-demos/PluginStatusBadge/ui/StatusBadge.tsx
// 简单的状态徽章组件

import { Badge, Tooltip } from '@mantine/core'
import { IconActivity } from '@tabler/icons-react'
import { definePluginUIModule, type ExtensionContext } from '@pluxel/hmr/web'

function StatusBadge({ ctx }: { ctx: ExtensionContext }) {
	return (
		<Tooltip label="PluginStatusBadge 运行中">
			<Badge variant="dot" color="teal" size="sm" leftSection={<IconActivity size={12} />}>
				Active
			</Badge>
		</Tooltip>
	)
}

const module = definePluginUIModule({
	extensions: [
		{
			point: 'header:actions',
			meta: { priority: 50 },
			Component: StatusBadge,
		},
	],
	setup() {
		console.log('[PluginStatusBadge] UI loaded')
	},
})

export const { extensions, setup } = module
export default module
