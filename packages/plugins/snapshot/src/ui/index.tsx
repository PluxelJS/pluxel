import { ActionIcon, Group, Tooltip } from '@mantine/core'
import {
	createPluginUi,
	ExtensionPoints,
	definePluginUIModule,
	rpcErrorMessage,
} from '@pluxel/runtime/web/ui'
import { IconBolt, IconPackage } from '@tabler/icons-react'
import { useCallback, useState } from 'react'
import type { DistBuildResult, SnapshotFilesResult } from '../rpc'

const snapshotUi = createPluginUi('Snapshot')

function resultError(result: SnapshotFilesResult | DistBuildResult): string | null {
	return 'error' in result ? result.error : null
}

function SnapshotHeaderActions() {
	const { notify, rpc } = snapshotUi.use('global')
	const [snapshotLoading, setSnapshotLoading] = useState(false)
	const [distLoading, setDistLoading] = useState(false)

	const handleSnapshot = useCallback(async () => {
		setSnapshotLoading(true)
		try {
			const res = await rpc.generateSnapshotFiles()
			if (!res.ok) {
				notify({
					tone: 'error',
					title: 'Snapshot generation failed',
					message: resultError(res) ?? 'Snapshot generation failed',
				})
				return
			}
			notify({
				tone: 'success',
				title: 'Snapshot generated',
				message: `Output directory: ${res.dir}`,
			})
		} catch (error) {
			notify({
				tone: 'error',
				title: 'Snapshot generation failed',
				message: rpcErrorMessage(error, 'Unknown error'),
			})
		} finally {
			setSnapshotLoading(false)
		}
	}, [notify, rpc])

	const handleBuild = useCallback(async () => {
		setDistLoading(true)
		try {
			const res = await rpc.buildDist()
			if (!res.ok) {
				notify({
					tone: 'error',
					title: 'Dist build failed',
					message: resultError(res) ?? 'Dist build failed',
				})
				return
			}
			notify({
				tone: 'success',
				title: 'Dist build completed',
				message: `Entry: ${res.entry}`,
			})
		} catch (error) {
			notify({
				tone: 'error',
				title: 'Dist build failed',
				message: rpcErrorMessage(error, 'Unknown error'),
			})
		} finally {
			setDistLoading(false)
		}
	}, [notify, rpc])

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
