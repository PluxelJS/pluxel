import lxgwWenKai from '../assets/fonts/LXGWWenKai-Regular.ttf?inline'

// Embed the font in the server bundle so static OG generation also works offline.
export function generateOgImage({
	title,
	description,
	site,
}: {
	title: string
	description?: string
	site?: string
}) {
	return {
		options: {
			fonts: [lxgwWenKai],
		},
		node: (
			<div
				lang="zh-CN"
				style={{
					display: 'flex',
					flexDirection: 'column',
					width: '100%',
					height: '100%',
					padding: 64,
					fontFamily: 'LXGW WenKai',
					color: '#f5f5f5',
					backgroundColor: '#0c0c0c',
					borderBottom: '12px solid #34d399',
				}}
			>
				<div style={{ fontSize: 64, fontWeight: 700, lineHeight: 1.25 }}>{title}</div>
				<div style={{ marginTop: 24, fontSize: 32, lineHeight: 1.5, color: '#bfc8c5' }}>
					{description}
				</div>
				<div style={{ marginTop: 'auto', paddingTop: 24, fontSize: 32, color: '#6ee7b7' }}>
					{site}
				</div>
			</div>
		),
	}
}
