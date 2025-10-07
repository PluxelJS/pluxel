import { Button } from '@mantine/core'
import { showNotification } from '@mantine/notifications'
import { useMutation as useGqtyMutation } from './gqty'

export function Header({ onMenu }: { onMenu: () => void }) {
	const [buildSnapshot, buildState] = useGqtyMutation((mutation) => {
		const result = mutation.buildSnapshot
		result.ok
		result.error
		result.path
		return result
	})

	const handleBuild = async () => {
		try {
			const result = await buildSnapshot()
			if (!result.ok) {
				showNotification({
					title: '生成快照失败',
					message: result.error || '未知错误',
					color: 'red',
				})
				return
			}
			showNotification({
				title: '已生成快照',
				message: result.path ? `保存于：${result.path}` : '在运行目录查看文件.',
			})
		} catch (error: any) {
			showNotification({
				title: '生成快照失败',
				message: error?.message || '操作失败，请稍后再试',
				color: 'red',
			})
		}
	}

	return (
		<div
			style={{
				height: '100%',
				display: 'flex',
				alignItems: 'center',
				padding: 16,
			}}
		>
			<Button onClick={onMenu}>☰</Button>
			<b style={{ marginLeft: 8 }}>自定义头部</b>
			<span style={{ marginLeft: 'auto' }}>
				<Button onClick={handleBuild} loading={buildState.isLoading}>
					构建 SNAPSHOT 至运行目录
				</Button>
			</span>
		</div>
	)
}
