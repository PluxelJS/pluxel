import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DOMParser } from '@tiptap/pm/model'
import {
	createTypstSourceProject,
	type TypstSourceProject,
} from '@pluxel/plugin-typst/source/browser'
import { TypstSourceEditor } from '@pluxel/plugin-typst/tiptap/react'
import parserWasm from '@pluxel/plugin-typst/source/parser.wasm?url'
import '@pluxel/plugin-typst/tiptap/style.css'

declare global {
	interface Window {
		acceptance: { project: TypstSourceProject; clipboardParser: typeof DOMParser }
	}
}
const saved = localStorage.getItem('acceptance-files')
const initial = (
	saved ? JSON.parse(saved) : await fetch('/files.json').then((response) => response.json())
) as Record<string, string>
const project = await createTypstSourceProject({
	files: initial,
	parserWasm,
	components: [
		{
			module: 'template/cards.typ',
			name: 'metrics',
			label: '验收指标卡',
			parameters: { title: { type: 'string', label: '指标标题' } },
			data: 'data',
		},
	],
})
window.acceptance = { project, clipboardParser: DOMParser }
function App() {
	const [path, setPath] = useState('sections/analysis.typ')
	const [message, setMessage] = useState('')
	return (
		<main style={{ maxWidth: 900, margin: '24px auto', padding: 16 }}>
			<h1>普通源码制品验收</h1>
			<nav>
				<button type="button" onClick={() => setPath('sections/analysis.typ')}>
					分析
				</button>
				<button type="button" onClick={() => setPath('sections/actions.typ')}>
					行动
				</button>
				<button
					type="button"
					onClick={() => {
						localStorage.setItem('acceptance-files', JSON.stringify(project.snapshot().files))
						setMessage('已保存源码')
					}}
				>
					保存源码
				</button>
				<button
					type="button"
					onClick={() => {
						const files = JSON.parse(localStorage.getItem('acceptance-files')!)
						const result = project.replace({ baseRevision: project.revision, files })
						setMessage(
							result.ok ? '已从源码重开' : result.issues.map((issue) => issue.message).join('\n'),
						)
					}}
				>
					重开源码
				</button>
			</nav>
			<p role="status">{message}</p>
			<TypstSourceEditor
				project={project}
				path={path}
				onIssues={(issues) => setMessage(issues.map((issue) => issue.message).join('\n'))}
			/>
		</main>
	)
}
createRoot(document.getElementById('app')!).render(<App />)
