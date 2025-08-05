import React from 'react'

interface AppHeaderProps {
	title?: string
}

export default function AppHeader({
	title = '这里是 AppHeader',
}: AppHeaderProps) {
	return (
		<header
			style={{
				display: 'flex',
				alignItems: 'center',
				padding: '0 16px',
				height: '100%',
			}}
		>
			<h1 style={{ fontSize: 18, margin: 0 }}>{title}</h1>
			<div style={{ marginLeft: 'auto' }}>右侧操作区</div>
		</header>
	)
}
