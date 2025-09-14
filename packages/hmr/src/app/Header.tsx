import { describe } from 'bun:test'
import { Button } from '@mantine/core'
import { showNotification } from '@mantine/notifications'
import { client } from './rpc'
export function Header({ onMenu }: { onMenu: () => void }) {
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
				<Button
					onClick={async () => {
						await client.build.$post()
						showNotification({
							title: '已生成快照',
							message: '在运行目录查看文件.',
						})
					}}
				>
					构建 SNAPSHOT 至运行目录
				</Button>
			</span>
		</div>
	)
}
