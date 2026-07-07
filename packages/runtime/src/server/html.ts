import type { Assets } from './assets'

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8'
const DEFAULT_TITLE = 'Pluxel HMR'

export type RuntimeUiHtmlTarget = 'static-built' | 'vite-dev'

export const colorSchemeScript = `<script>
;(() => {
  try {
    const key = 'pluxel-color-scheme';
    const stored = localStorage.getItem(key);
    const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const next = stored === 'dark' || stored === 'light' ? stored : system;
    document.documentElement.setAttribute('data-mantine-color-scheme', next);
  } catch {
    document.documentElement.setAttribute('data-mantine-color-scheme', 'light');
  }
})();
</script>`

const reactRefreshPreambleScript = `<script type="module">
import { injectIntoGlobalHook } from "/@react-refresh";
injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
</script>`

export function renderRuntimeUiHtml(
	assets: Assets,
	options: { title?: string; target: RuntimeUiHtmlTarget },
) {
	return renderUiHtmlDocument(assets, {
		title: options?.title,
		headScripts: runtimeUiHeadScripts(options.target),
	})
}

function runtimeUiHeadScripts(target: RuntimeUiHtmlTarget): string[] {
	switch (target) {
		case 'static-built':
			return []
		case 'vite-dev':
			// Vite's React plugin transforms TSX modules with a preamble check, but this
			// runtime UI HTML is generated outside Vite's index.html transform pipeline.
			return [reactRefreshPreambleScript]
	}
	return assertNever(target)
}

function assertNever(value: never): never {
	throw new Error(`Unhandled runtime UI HTML target: ${String(value)}`)
}

function renderUiHtmlDocument(
	assets: Assets,
	options?: { title?: string; headScripts?: string[] },
) {
	const title = options?.title ?? DEFAULT_TITLE
	const headScripts = options?.headScripts ?? []
	return `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    ${colorSchemeScript}
    ${headScripts.join('\n    ')}
    ${assets.css.map((href) => `<link rel="stylesheet" href="${href}" />`).join('\n    ')}
    ${assets.preload.map((href) => `<link rel="modulepreload" href="${href}" />`).join('\n    ')}
    <script type="module" src="${assets.js}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
}

export function createHtmlResponse(html: string) {
	return new Response(html, {
		headers: {
			'content-type': HTML_CONTENT_TYPE,
		},
	})
}
