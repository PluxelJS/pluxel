import { ActionIcon, Group, Tooltip } from '@mantine/core'
import {
	createPluginUiHelpers,
	ExtensionPoints,
	definePluginUIModule,
	rpcErrorMessage,
} from '@pluxel/runtime/web/ui'
import { IconBolt, IconPackage } from '@tabler/icons-react'
import { useCallback, useState } from 'react'

const snapshotUi = createPluginUiHelpers('Snapshot')

function SnapshotHeaderActions() {
	const { notify, rpc } = snapshotUi.useGlobalRuntime()
	const [snapshotLoading, setSnapshotLoading] = useState(false)
	const [distLoading, setDistLoading] = useState(false)

	const handleSnapshot = useCallback(async () => {
		setSnapshotLoading(true)
		try {
			const res = await rpc.generateSnapshotFiles()
			if (!res.ok) {
				notify?.({ tone: 'error', title: '生成 Snapshot 失败', message: res.error })
				return
			}
			notify?.({
				tone: 'success',
				title: '已生成 Snapshot',
				message: `输出目录：${res.dir}`,
			})
		} catch (error) {
			notify?.({
				tone: 'error',
				title: '生成 Snapshot 失败',
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
				notify?.({ tone: 'error', title: '构建 Dist 失败', message: res.error })
				return
			}
			notify?.({
				tone: 'success',
				title: 'Dist 构建完成',
				message: `入口：${res.entry}`,
			})
		} catch (error) {
			notify?.({
				tone: 'error',
				title: '构建 Dist 失败',
				message: rpcErrorMessage(error, 'Unknown error'),
			})
		} finally {
			setDistLoading(false)
		}
	}, [notify, rpc])

	return (
		<Group gap="xs" wrap="nowrap">
			<Tooltip label="生成 Snapshot" withArrow>
				<ActionIcon
					variant="default"
					size="lg"
					radius="xl"
					aria-label="生成 Snapshot"
					loading={snapshotLoading}
					onClick={handleSnapshot}
				>
					<IconBolt size={18} />
				</ActionIcon>
			</Tooltip>

			<Tooltip label="构建 Dist" withArrow>
				<ActionIcon
					variant="default"
					size="lg"
					radius="xl"
					aria-label="构建 Dist"
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
