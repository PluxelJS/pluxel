import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { maxSatisfying, valid, validRange } from 'semver'
import { publicRegistry } from '../market-contracts.ts'
import {
	isPackageName,
	record,
	packageDocument,
	type PackageDocument,
} from '../package-document.ts'
import {
	PackageDocumentExplorer,
	type DocumentReader,
	type DocumentRead,
} from './package-document-explorer.tsx'

/** This lookup is an explicit anonymous read of public npm. Its metadata never enters an install plan. */
async function readNpmPackage(
	name: string,
	range: string | undefined,
	signal: AbortSignal,
): Promise<PackageDocument | null> {
	if (!isPackageName(name)) throw new Error('Enter an exact npm package name.')
	const response = await fetch(publicRegistry + '/' + encodeURIComponent(name), {
		signal,
		credentials: 'omit',
		redirect: 'error',
		referrerPolicy: 'no-referrer',
		headers: { accept: 'application/json' },
	})
	if (!response.ok) {
		await response.body?.cancel()
		if (response.status === 404) return null
		throw new Error('Public npm returned HTTP ' + response.status)
	}
	const reader = response.body?.getReader()
	if (!reader) throw new Error('Public npm returned an empty response')
	const decoder = new TextDecoder()
	let size = 0
	let text = ''
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.length
			if (size > 16 * 1024 * 1024) {
				await reader.cancel()
				throw new Error('Package metadata exceeds the 16 MiB browsing limit.')
			}
			text += decoder.decode(value, { stream: true })
		}
	} finally {
		reader.releaseLock()
	}
	const pack: unknown = JSON.parse(text + decoder.decode())
	if (!record(pack) || pack.name !== name || !record(pack.versions) || !record(pack['dist-tags']))
		throw new Error('Public npm returned invalid package metadata.')
	const tag = pack['dist-tags'][range ?? 'latest']
	const version =
		typeof tag === 'string'
			? tag
			: range && validRange(range)
				? maxSatisfying(
						Object.keys(pack.versions).filter((v) => valid(v)),
						range,
					)
				: null
	if (!version) return null
	const manifest = pack.versions[version]
	if (!record(manifest) || manifest.name !== name || manifest.version !== version)
		throw new Error('Public npm returned an inconsistent release.')
	const readme = typeof pack.readme === 'string' ? pack.readme : null
	return packageDocument(
		name,
		manifest,
		readme ? { text: readme.slice(0, 262144), truncated: readme.length > 262144 } : null,
	)
}

export function NpmDocumentReader({ path, children }: ComponentProps<DocumentReader>) {
	const { name, range } = path[path.length - 1]!
	const [revision, retry] = useState(0)
	const [result, setResult] = useState<
		Omit<DocumentRead, 'refetch'> & { name: string; range?: string; revision: number }
	>()
	useEffect(() => {
		const controller = new AbortController()
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])
		async function load() {
			try {
				const data = await readNpmPackage(name, range, signal)
				if (!controller.signal.aborted) setResult({ name, range, revision, data })
			} catch (error) {
				if (!controller.signal.aborted) setResult({ name, range, revision, error })
			}
		}
		void load()
		return () => controller.abort()
	}, [name, range, revision])
	return children({
		...(result?.name === name && result.range === range && result.revision === revision
			? result
			: {}),
		refetch: () => retry((n) => n + 1),
	})
}

/** Public package browsing stays usable when the application has no market connection. */
export function PublicPackageLookup() {
	const [input, setInput] = useState('')
	const [opened, setOpened] = useState('')
	const field = useRef<HTMLInputElement>(null)
	return opened ? (
		<PackageDocumentExplorer
			key={opened}
			name={opened}
			source="Public npm"
			reader={NpmDocumentReader}
			backLabel="Back to package lookup"
			onClose={() => {
				setOpened('')
				requestAnimationFrame(() => field.current?.focus())
			}}
		/>
	) : (
		<form
			className="pm-field"
			onSubmit={(event) => {
				event.preventDefault()
				if (isPackageName(input.trim())) setOpened(input.trim())
			}}
		>
			<label>
				Public npm package
				<input
					ref={field}
					value={input}
					maxLength={214}
					onChange={(event) => setInput(event.currentTarget.value)}
					placeholder="@scope/package"
				/>
			</label>
			<button type="submit" className="pm-button" disabled={!isPackageName(input.trim())}>
				Look up on public npm
			</button>
		</form>
	)
}
