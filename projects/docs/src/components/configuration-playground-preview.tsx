'use client'

import { useEffect, useState } from 'react'

type PlaygroundComponent = typeof import('./configuration-playground').ConfigurationPlayground

export function ConfigurationPlaygroundPreview() {
	const [Playground, setPlayground] = useState<PlaygroundComponent | null>(null)
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		let active = true

		void import('./configuration-playground')
			.then((module) => {
				if (active) setPlayground(() => module.ConfigurationPlayground)
				return module
			})
			.catch(() => {
				if (active) setFailed(true)
			})

		return () => {
			active = false
		}
	}, [])

	return (
		<>
			{Playground ? <Playground /> : null}
			{!Playground && !failed ? (
				<div role="status" aria-live="polite" className="rounded-lg border p-6">
					正在加载配置 Playground…
				</div>
			) : null}
			{failed ? (
				<div role="alert" className="rounded-lg border p-6 text-red-600">
					配置 Playground 加载失败。请刷新页面后重试。
				</div>
			) : null}
		</>
	)
}
