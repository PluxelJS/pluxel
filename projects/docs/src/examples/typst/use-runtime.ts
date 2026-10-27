'use client'

import { useEffect, useRef, useState } from 'react'
import type {
	ExampleCompilation,
	ExampleDraft,
	ExampleRequest,
	ExampleResponse,
	ExampleUpdate,
	ThemeVersion,
} from './protocol'

type State = 'stopped' | 'starting' | 'compiling' | 'updating' | 'ready' | 'stopping'
type Controls = {
	edit(draft: ExampleDraft): void
	replace(theme: ThemeVersion): void
	stop(): void
}

/** One Worker per mount/run; one operation in flight, followed by the latest draft. */
export function useTypstRuntime(draft: ExampleDraft) {
	const [run, setRun] = useState(0)
	const [state, setState] = useState<State>('starting')
	const [compilation, setCompilation] = useState<ExampleCompilation>()
	const [error, setError] = useState('')
	const [plugins, setPlugins] = useState<string[]>([])
	const [events, setEvents] = useState<string[]>([])
	const [theme, setTheme] = useState<ThemeVersion>('classic')
	const [update, setUpdate] = useState<ExampleUpdate>()
	const latest = useRef(draft)
	latest.current = draft
	const controls = useRef<Controls | undefined>(undefined)

	useEffect(() => {
		let alive = true
		let ready = false
		let closing = false
		let active: 'compile' | 'replace' | undefined
		let installedTheme: ThemeVersion = 'classic'
		let wantedTheme: ThemeVersion = 'classic'
		let pending: ExampleDraft | undefined
		let debounce: ReturnType<typeof setTimeout> | undefined
		let watchdog: ReturnType<typeof setTimeout> | undefined
		const worker = new Worker(new URL('./runtime.worker.ts', import.meta.url), { type: 'module' })
		setState('starting')
		setCompilation(undefined)
		setError('')
		setEvents([])
		setPlugins([])
		setTheme('classic')
		setUpdate(undefined)

		function log(message: string) {
			if (alive) setEvents((previous) => [...previous.slice(-11), message])
		}
		function finish() {
			closing = true
			clearTimeout(debounce)
			clearTimeout(watchdog)
			worker.terminate()
			if (controls.current === current) controls.current = undefined
			if (alive) {
				setPlugins([])
				setState('stopped')
			}
		}
		function deadline(milliseconds: number) {
			clearTimeout(watchdog)
			watchdog = setTimeout(() => {
				if (alive)
					setError(
						closing ? '资源释放超时，已终止 Worker。' : '运行超时，已终止 Worker。可重新启动。',
					)
				finish()
			}, milliseconds)
		}
		function send(message: ExampleRequest) {
			worker.postMessage(message, [])
		}
		function flush() {
			if (!ready || closing || active) return
			if (wantedTheme !== installedTheme) {
				active = 'replace'
				setState('updating')
				deadline(10_000)
				send({ type: 'replace', theme: wantedTheme })
			} else if (pending) {
				const snapshot = pending
				pending = undefined
				active = 'compile'
				setState('compiling')
				deadline(10_000)
				send({ type: 'compile', ...snapshot })
			} else setState('ready')
		}
		const current: Controls = {
			edit(snapshot) {
				if (closing) return
				clearTimeout(debounce)
				pending = undefined
				setError('')
				debounce = setTimeout(() => {
					debounce = undefined
					pending = snapshot
					flush()
				}, 300)
			},
			replace(next) {
				if (closing) return
				wantedTheme = next
				setTheme(next)
				setError('')
				flush()
			},
			stop() {
				if (closing) return
				closing = true
				clearTimeout(debounce)
				pending = undefined
				if (!ready || active === 'compile') {
					log('运行已取消，Worker 已终止。')
					finish()
				} else {
					setState('stopping')
					deadline(5_000)
					send({ type: 'stop' })
				}
			},
		}
		controls.current = current
		worker.onerror = (event) => {
			if (!alive || controls.current !== current) return
			setError(event.message || 'Worker 加载失败，请重新启动。')
			finish()
		}
		worker.onmessage = ({ data }: MessageEvent<ExampleResponse>) => {
			if (!alive || controls.current !== current) return
			if (data.type === 'lifecycle') {
				log(data.message)
				return
			}
			if (data.type === 'stopped') {
				log('Host 已关闭，Typst 资源已释放。')
				finish()
				return
			}
			if (data.type === 'error' && data.fatal) {
				setError(data.message)
				finish()
				return
			}
			if (closing) return
			clearTimeout(watchdog)
			switch (data.type) {
				case 'ready':
					ready = true
					setPlugins(data.plugins)
					clearTimeout(debounce)
					debounce = undefined
					pending = latest.current
					break
				case 'compiled':
					active = undefined
					if (data.revision === latest.current.revision && data.theme === wantedTheme) {
						setCompilation(data)
						setError('')
						log(`ReportPlugin #${data.generation} · 编译完成 · ${data.durationMs} ms`)
					}
					break
				case 'replaced':
					active = undefined
					installedTheme = data.theme
					setUpdate(data)
					log(
						`目录 #${data.catalogRevision} · 替换 ${data.replaced.join('、')} · 重启 ${data.restarted.join('、')}`,
					)
					// A new implementation renders the latest draft, even without a document edit.
					if (!debounce) pending = latest.current
					break
				case 'error':
					active = undefined
					if (data.revision === latest.current.revision) setError(data.message)
					break
			}
			flush()
		}
		deadline(60_000)
		send({ type: 'start' })
		return () => {
			alive = false
			clearTimeout(debounce)
			clearTimeout(watchdog)
			if (controls.current !== current) return
			controls.current = undefined
			const shutdown = setTimeout(() => worker.terminate(), 1_000)
			worker.onmessage = ({ data }: MessageEvent<ExampleResponse>) => {
				if (data.type === 'stopped' || (data.type === 'error' && data.fatal)) {
					clearTimeout(shutdown)
					worker.terminate()
				}
			}
			worker.onerror = () => {
				clearTimeout(shutdown)
				worker.terminate()
			}
			send({ type: 'stop' })
		}
	}, [run])

	useEffect(() => {
		controls.current?.edit(draft)
	}, [draft])

	return {
		state,
		compilation,
		error,
		plugins,
		events,
		theme,
		update,
		restart: () => setRun((previous) => previous + 1),
		stop: () => controls.current?.stop(),
		replaceTheme: (next: ThemeVersion) => controls.current?.replace(next),
	}
}
