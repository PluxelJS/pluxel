// packages/hmr/tests/plugins/ui/StatusBadge.tsx
// 简单的状态徽章组件

import { Badge, Tooltip } from '@mantine/core'
import { IconActivity } from '@tabler/icons-react'
import type { PluginUIModule, ExtensionContext } from '@pluxel/components/extension'

function StatusBadge({ ctx }: { ctx: ExtensionContext }) {
	return (
		<Tooltip label="PluginStatusBadge 运行中">
			<Badge
				variant="dot"
				color="teal"
				size="sm"
				leftSection={<IconActivity size={12} />}
			>
				Active
			</Badge>
		</Tooltip>
	)
}

export const extensions: PluginUIModule['extensions'] = [
	{
		point: 'header:actions',
		meta: { priority: 50 },
		Component: StatusBadge,
	},
]

export function setup() {
	console.log('[PluginStatusBadge] UI loaded')
}
