import { render } from '@pluxel/takumi/worker'
import type { WorkerTaskHandler } from '@pluxel/services/workers'
import type { ReportRenderInput } from './report-render.contracts'
import { ReportCard } from './report-card'
import { REPORT_CARD_CSS } from './report-card-css'

/** Components, React hooks and native layout all execute in this declared task's Worker. */
const run: WorkerTaskHandler<ReportRenderInput, Uint8Array> = ({ title, engine, fonts }) =>
	render(
		engine === 'heroui' ? (
			<ReportCard title={title} />
		) : (
			<div
				style={{
					width: '100%',
					height: '100%',
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
					padding: 48,
					backgroundColor: '#10172a',
					color: '#f8fafc',
				}}
			>
				<p style={{ fontSize: 16, color: '#5eead4' }}>PLUXEL REPORT STUDIO</p>
				<h1 style={{ fontSize: 38, marginTop: 20 }}>{title}</h1>
				<p style={{ fontSize: 18, color: '#94a3b8', marginTop: 24 }}>
					React JSX · shared Worker · Takumi
				</p>
			</div>
		),
		{
			width: 720,
			height: 405,
			format: 'png',
			fonts,
			images: { allowUrl: () => false },
			...(engine === 'heroui' ? { css: REPORT_CARD_CSS } : {}),
		},
	)

export default run
