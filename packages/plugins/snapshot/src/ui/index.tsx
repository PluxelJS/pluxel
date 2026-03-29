import { ActionIcon, Group, Tooltip } from '@mantine/core'
import {
	ExtensionPoints,
	definePluginUIModule,
	pluginUi,
	rpcErrorMessage,
} from '@pluxel/runtime/web/ui'
import { IconBolt, IconPackage } from '@tabler/icons-react'
import { useCallback, useState } from 'react'
import type { DistBuildResult, SnapshotFilesResult } from '../rpc'

const plugin = pluginUi('Snapshot')

function resultError(result: SnapshotFilesResult | DistBuildResult): string | null {
	return 'error' in result ? result.error : null
}

function SnapshotHeaderActions() {
	const app = plugin.useGlobal()
	const [snapshotLoading, setSnapshotLoading] = useState(false)
	const [distLoading, setDistLoading] = useState(false)

	const handleSnapshot = useCallback(async () => {
		setSnapshotLoading(true)
		try {
			const res = await app.rpc.generateSnapshotFiles()
			if (!res.ok) {
				app.notify({
					tone: 'error',
					title: 'Snapshot generation failed',
					message: resultError(res) ?? 'Snapshot generation failed',
				})
				return
			}
			app.notify({
				tone: 'success',
				title: 'Snapshot generated',
				message: `Output directory: ${res.dir}`,
			})
		} catch (error) {
			app.notify({
				tone: 'error',
				title: 'Snapshot generation failed',
				message: rpcErrorMessage(error, 'Unknown error'),
			})
		} finally {
			setSnapshotLoading(false)
		}
	}, [app])

	const handleBuild = useCallback(async () => {
		setDistLoading(true)
		try {
			const res = await app.rpc.buildDist()
			if (!res.ok) {
				app.notify({
					tone: 'error',
					title: 'Dist build failed',
					message: resultError(res) ?? 'Dist build failed',
				})
				return
			}
			app.notify({
				tone: 'success',
				title: 'Dist build completed',
				message: `Entry: ${res.entry}`,
			})
		} catch (error) {
			app.notify({
				tone: 'error',
				title: 'Dist build failed',
				message: rpcErrorMessage(error, 'Unknown error'),
			})
		} finally {
			setDistLoading(false)
		}
	}, [app])

	return (
		<Group gap="xs" wrap="nowrap">
			<Tooltip label="Generate Snapshot" withArrow>
				<ActionIcon
					variant="default"
					size="lg"
					radius="xl"
					aria-label="Generate Snapshot"
					loading={snapshotLoading}
					onClick={handleSnapshot}
				>
					<IconBolt size={18} />
				</ActionIcon>
			</Tooltip>

			<Tooltip label="Build Dist" withArrow>
				<ActionIcon
					variant="default"
					size="lg"
					radius="xl"
					aria-label="Build Dist"
					loading={distLoading}
					onClick={handleBuild}
				>
					<IconPackage size={18} />
				</ActionIcon>
			</Tooltip>
		</Group>
	)
}

export default definePluginUIModule({
	extensions: [
		{
			point: ExtensionPoints.HeaderActions,
			id: 'snapshot-actions',
			priority: 100,
			render: () => <SnapshotHeaderActions />,
		},
	],
})
