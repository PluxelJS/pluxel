import { resolveAssets } from './assets'
import type { RenderHandler } from './types'

const assets = resolveAssets(true)
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
    ${assets.css.map((href) => `<link rel="stylesheet" href="${href}" />`).join('\n    ')}
    ${assets.preload.map((href) => `<link rel="modulepreload" href="${href}" />`).join('\n    ')}
    <script type="module" src="${assets.js}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`

export function createStaticRenderer(): RenderHandler {
	return (ctx) => ctx.html(staticHtml)
}
