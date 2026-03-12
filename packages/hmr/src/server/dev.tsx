import { resolveAssets } from './assets'
import type { RenderHandler } from './types'

const assets = resolveAssets(false)

export function createDevRenderer(): RenderHandler {
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

	const staticHtml = `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Pluxel HMR</title>
    ${colorSchemeScript}
    <script type="module" src="${assets.js}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

	return () =>
		new Response(staticHtml, {
			headers: {
				'content-type': 'text/html; charset=utf-8',
			},
		})
}
