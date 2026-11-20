import { ActionIcon, Tooltip } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { IconAdjustmentsHorizontal } from '@tabler/icons-react'
import { buildPluginDetailHref } from '../../workbench/paths'
import { useWorkspaceSession } from './workspaceContext'

export function PluginConfigurationButton({
	owner,
	label,
}: {
	owner: PluginNodeAddress
	label: string
}) {
	const session = useWorkspaceSession()
	return (
		<Tooltip label={`插件配置 · ${label}`} events={{ hover: true, focus: true, touch: false }}>
			<ActionIcon
				variant="subtle"
				color="gray"
				size="sm"
				aria-label={`打开插件配置 ${label}`}
				onClick={() =>
					void session.workbench
						.open({ to: buildPluginDetailHref(owner) })
						.then((result) => session.check(result))
						.catch((error: unknown) => session.report(error))
				}
			>
				<IconAdjustmentsHorizontal size={15} aria-hidden />
			</ActionIcon>
		</Tooltip>
	)
}
