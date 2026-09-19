import type { Assets } from './assets'

const HTML_CONTENT_TYPE = 'text/html; charset=utf-8'
const DEFAULT_TITLE = 'Pluxel Workbench'

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

export function renderRuntimeUiHtml(
	assets: Assets,
	options: { title?: string; uiBasePath?: string; prebuiltAssets?: boolean } = {},
) {
	return renderUiHtmlDocument(assets, {
		title: options.title,
		uiBasePath: options.uiBasePath ?? '/',
		prebuiltAssets: options.prebuiltAssets,
	})
}

function renderUiHtmlDocument(
	assets: Assets,
	options?: { title?: string; uiBasePath?: string; prebuiltAssets?: boolean },
) {
	// Prebuilt shell assets belong to the static handler, not Vite's source module graph.
	const viteIgnore = options?.prebuiltAssets ? ' vite-ignore' : ''
	const title = options?.title ?? DEFAULT_TITLE
	const uiBasePath = escapeHtmlAttribute(options?.uiBasePath ?? '/')
	return `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
	<meta name="pluxel-workbench-ui-base-path" content="${uiBasePath}" />
    <title>${title}</title>
    ${colorSchemeScript}
    ${assets.css.map((href) => `<link${viteIgnore} rel="stylesheet" href="${href}" />`).join('\n    ')}
    ${assets.preload.map((href) => `<link${viteIgnore} rel="modulepreload" href="${href}" />`).join('\n    ')}
    <script${viteIgnore} type="module" src="${assets.js}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

export function createHtmlResponse(html: string) {
	return new Response(html, {
		headers: {
			'content-type': HTML_CONTENT_TYPE,
		},
	})
}
