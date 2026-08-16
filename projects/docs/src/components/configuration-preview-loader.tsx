'use client'

import { useState } from 'react'

type PreviewComponent = typeof import('./configuration-preview').ConfigurationPreview

export function ConfigurationPreviewLoader() {
	const [Preview, setPreview] = useState<PreviewComponent | null>(null)
	const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

	function loadPreview() {
		if (Preview || status === 'loading') return
		setStatus('loading')
		void import('./configuration-preview')
			.then((module) => {
				setPreview(() => module.ConfigurationPreview)
				setStatus('idle')
				return module
			})
			.catch(() => setStatus('error'))
	}

	return (
		<details
			className="configuration-preview-disclosure"
			onToggle={(event) => {
				if (event.currentTarget.open) loadPreview()
			}}
		>
			<summary>配置渲染预览 · 表单、Input 与 Output</summary>
			<div className="configuration-preview-disclosure-body">
				{Preview ? <Preview /> : null}
				{status === 'loading' ? (
					<div role="status" aria-live="polite" className="rounded-lg p-4">
						正在加载配置预览…
					</div>
				) : null}
				{status === 'error' ? (
					<div role="alert" className="rounded-lg p-4 text-red-600">
						配置预览加载失败。请刷新页面后重试。
					</div>
				) : null}
			</div>
		</details>
	)
}
