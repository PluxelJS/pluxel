import { StrictMode, useEffect, useState, type FormEvent } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type TodoItem = Readonly<{
	id: string
	title: string
	completed: boolean
}>

type TodoSnapshot = Readonly<{
	items: readonly TodoItem[]
	maxItems: number
	auditEnabled: boolean
}>

type ApiError = Readonly<{ error?: string }>

async function readSnapshot(response: Response): Promise<TodoSnapshot> {
	const body = (await response.json()) as TodoSnapshot | ApiError
	if (!response.ok) {
		throw new Error('error' in body && body.error ? body.error : `HTTP ${response.status}`)
	}
	return body as TodoSnapshot
}

function ExampleApp() {
	const [snapshot, setSnapshot] = useState<TodoSnapshot>()
	const [title, setTitle] = useState('')
	const [errorMessage, setErrorMessage] = useState<string>()
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		const controller = new AbortController()
		void fetch('/api/example/todos', { signal: controller.signal })
			.then(readSnapshot)
			.then(setSnapshot)
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) {
					setErrorMessage(cause instanceof Error ? cause.message : 'Request failed')
				}
			})
		return () => controller.abort()
	}, [])

	async function mutate(path: string, init: RequestInit): Promise<boolean> {
		setBusy(true)
		setErrorMessage(undefined)
		try {
			setSnapshot(await readSnapshot(await fetch(path, init)))
			return true
		} catch (cause: unknown) {
			setErrorMessage(cause instanceof Error ? cause.message : 'Request failed')
			return false
		} finally {
			setBusy(false)
		}
	}

	function addTodo(event: FormEvent<HTMLFormElement>): void {
		event.preventDefault()
		const normalized = title.trim()
		if (!normalized) return
		void (async () => {
			const created = await mutate('/api/example/todos', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: normalized }),
			})
			if (created) setTitle('')
		})()
	}

	const completed = snapshot?.items.filter((item) => item.completed).length ?? 0

	return (
		<main className="shell">
			<header>
				<div>
					<p className="eyebrow">One Vite · React + Plugin routes</p>
					<h1>Todo route lab</h1>
					<p className="lede">
						This page and the Plugin-owned API share one development server and one origin.
					</p>
				</div>
				<div className="counter" aria-label={`${completed} completed todos`}>
					<strong>{completed}</strong>
					<span>completed</span>
				</div>
			</header>

			<form className="composer" onSubmit={addTodo}>
				<label htmlFor="todo-title">Add a Todo through the HTTP Plugin</label>
				<div>
					<input
						id="todo-title"
						value={title}
						onChange={(event) => setTitle(event.currentTarget.value)}
						maxLength={80}
						placeholder="What should happen next?"
						disabled={busy}
					/>
					<button type="submit" disabled={busy || !title.trim()}>
						Add
					</button>
				</div>
			</form>

			{errorMessage ? <p className="error">{errorMessage}</p> : null}
			{snapshot ? (
				<ul className="todo-list">
					{snapshot.items.map((item) => (
						<li key={item.id}>
							<label>
								<input
									type="checkbox"
									checked={item.completed}
									disabled={busy}
									onChange={(event) => {
										void mutate(`/api/example/todos/${item.id}`, {
											method: 'PATCH',
											headers: { 'content-type': 'application/json' },
											body: JSON.stringify({ completed: event.currentTarget.checked }),
										})
									}}
								/>
								<span>{item.title}</span>
							</label>
							<button
								type="button"
								className="remove"
								disabled={busy}
								aria-label={`Remove ${item.title}`}
								onClick={() => {
									void mutate(`/api/example/todos/${item.id}`, { method: 'DELETE' })
								}}
							>
								Remove
							</button>
						</li>
					))}
				</ul>
			) : (
				<p className="loading">Loading the Plugin-owned route…</p>
			)}

			<footer>
				<span>
					{snapshot ? `${snapshot.items.length}/${snapshot.maxItems} items` : 'Connecting'}
				</span>
				<span>{snapshot?.auditEnabled ? 'Optional audit attached' : 'Audit unavailable'}</span>
				<code>/api/example/todos</code>
			</footer>
		</main>
	)
}

const root = document.querySelector('#root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(
	<StrictMode>
		<ExampleApp />
	</StrictMode>,
)
