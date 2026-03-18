import { DEFAULT_PUBLIC_BASE, resolveBuiltAssets } from './assets'
import type { RenderHandler } from './types'

const colorSchemeScript = `<script>
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

const htmlCache = new Map<string, Promise<string>>()

async function buildStaticHtml() {
	const cached = htmlCache.get(DEFAULT_PUBLIC_BASE)
	if (cached) return cached

	const pending = resolveBuiltAssets().then(
		(assets) => `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Pluxel HMR</title>
    ${colorSchemeScript}
    ${assets.css.map((href) => `<link rel="stylesheet" href="${href}" />`).join('\n    ')}
    ${assets.preload.map((href) => `<link rel="modulepreload" href="${href}" />`).join('\n    ')}
    <script type="module" src="${assets.js}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`,
	)
	htmlCache.set(DEFAULT_PUBLIC_BASE, pending)
	return pending
}

export async function createStaticRenderer(): Promise<RenderHandler> {
	const staticHtml = await buildStaticHtml()
	return () =>
		new Response(staticHtml, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
			},
		})
}
