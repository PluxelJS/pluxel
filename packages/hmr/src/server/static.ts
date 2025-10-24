import { ColorSchemeScript } from '@mantine/core'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { resolveAssets } from './assets'
import type { RenderHandler } from './types'

const assets = resolveAssets(true)
const colorSchemeScript = renderToStaticMarkup(createElement(ColorSchemeScript))

const staticHtml = `<!DOCTYPE html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>My App</title>
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
