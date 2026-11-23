import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import type { HighlighterCore, LanguageRegistration, ThemedTokenWithVariants } from 'shiki/core'

type LoadGrammar = () => Promise<{ default: LanguageRegistration[] }>

const languages = new Map<string, LoadGrammar>()
for (const [names, load] of [
	[['javascript', 'js', 'mjs', 'cjs'], () => import('shiki/langs/javascript.mjs')],
	[['typescript', 'ts', 'mts', 'cts'], () => import('shiki/langs/typescript.mjs')],
	[['jsx'], () => import('shiki/langs/jsx.mjs')],
	[['tsx'], () => import('shiki/langs/tsx.mjs')],
	[['shellscript', 'shell', 'sh', 'bash', 'zsh'], () => import('shiki/langs/shellscript.mjs')],
	[['json'], () => import('shiki/langs/json.mjs')],
	[['jsonc'], () => import('shiki/langs/jsonc.mjs')],
	[['yaml', 'yml'], () => import('shiki/langs/yaml.mjs')],
	[['toml'], () => import('shiki/langs/toml.mjs')],
	[['html'], () => import('shiki/langs/html.mjs')],
	[['css'], () => import('shiki/langs/css.mjs')],
	[['markdown', 'md'], () => import('shiki/langs/markdown.mjs')],
	[['python', 'py'], () => import('shiki/langs/python.mjs')],
	[['sql'], () => import('shiki/langs/sql.mjs')],
	[['diff', 'patch'], () => import('shiki/langs/diff.mjs')],
] as const) {
	for (const name of names) languages.set(name, load)
}

const themes = { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' }
let engine: Promise<HighlighterCore> | undefined

// The catalog and plain code do not load the tokenizer, either theme or any grammar.
function getHighlighter() {
	engine ??= Promise.all([
		import('shiki/core'),
		import('shiki/engine/javascript'),
		import('shiki/themes/github-light-high-contrast.mjs'),
		import('shiki/themes/github-dark-high-contrast.mjs'),
	])
		.then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
			createHighlighterCore({
				engine: createJavaScriptRegexEngine(),
				themes: [light.default, dark.default],
				langs: [],
			}),
		)
		.catch((error: unknown) => {
			engine = undefined
			throw error
		})
	return engine
}

function renderTokens(code: string, lines: ThemedTokenWithVariants[][]): ReactNode[] {
	const nodes: ReactNode[] = []
	let cursor = 0
	for (const line of lines) {
		for (const token of line) {
			if (!token.content) continue
			// Preserve the source's line endings, including blank lines and CRLF.
			if (token.offset > cursor) nodes.push(code.slice(cursor, token.offset))
			const style: CSSProperties & { '--pm-code-light'?: string; '--pm-code-dark'?: string } = {
				'--pm-code-light': token.variants.light?.color,
				'--pm-code-dark': token.variants.dark?.color,
			}
			nodes.push(
				<span className="pm-code-token" key={token.offset} style={style}>
					{token.content}
				</span>,
			)
			cursor = token.offset + token.content.length
		}
	}
	if (cursor < code.length) nodes.push(code.slice(cursor))
	return nodes
}

export function ReadmeCode({
	code,
	language,
}: Readonly<{ code: string; language?: string | null }>) {
	const load = languages.get(language?.toLowerCase() ?? '')
	const [highlight, setHighlight] = useState<{
		code: string
		grammar: LoadGrammar
		nodes: ReactNode[]
	}>()
	useEffect(() => {
		if (!load || !code) return undefined
		let active = true
		async function highlightCode(grammar: LoadGrammar) {
			const [highlighter, registration] = await Promise.all([getHighlighter(), grammar()])
			const lang = registration.default.at(-1)!.name
			if (!active) return
			if (!highlighter.getLoadedLanguages().includes(lang))
				await highlighter.loadLanguage(registration.default)
			if (!active) return
			const lines = highlighter.codeToTokensWithThemes(code, {
				lang,
				themes,
				tokenizeMaxLineLength: 4000,
				tokenizeTimeLimit: 35,
			})
			setHighlight({ code, grammar, nodes: renderTokens(code, lines) })
		}
		// The code is already readable if a browser cannot load or use a grammar.
		void highlightCode(load).catch((): void => {})
		return () => {
			active = false
		}
	}, [code, load])

	return (
		<figure className="pm-readme-code">
			{language ? <figcaption className="pm-code-language">{language}</figcaption> : null}
			<pre>
				<code>
					{highlight?.code === code && highlight.grammar === load ? highlight.nodes : code}
				</code>
			</pre>
		</figure>
	)
}
