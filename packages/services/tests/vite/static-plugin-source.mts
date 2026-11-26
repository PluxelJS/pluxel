export function staticPluginSource(
	version: string,
	{ includeViteStatic = true, providerFails = false } = {},
): string {
	const revision = JSON.stringify(version)
	return `import { BasePlugin, Plugin, PluginPart } from '@pluxel/core'
import * as v from 'valibot'
import { ElysiaApp } from '@pluxel/services/elysia'
import { websocket } from 'elysia/websocket'
import { writeFileAtomic } from '@pluxel/core/fs'
import { BuiltStatic } from '@fixture/vite-built'

export const ViteStaticConfig = v.object({ label: v.optional(v.string(), 'default') })

@Plugin({ displayName: 'Vite static', forkable: true })
export class ViteStatic extends BasePlugin {
  private readonly settings = this.configs.use(ViteStaticConfig)
  readonly version = ${revision}
  configuredLabel = ''
  storedFsValue = ''

  protected override async init() {
    const files = await this.ctx.fs()
    const address = this.ctx.pluginInfo.nodeAddress
    try {
      this.storedFsValue = await files.readFile('marker', 'utf8')
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
      this.storedFsValue = ${revision} + ':' + (address.variant === 'fork' ? address.forkId : 'default')
      await writeFileAtomic(files, 'marker', this.storedFsValue)
    }
    this.configuredLabel = this.settings.label
    if (address.variant === 'default') {
      this.ctx.service(ElysiaApp)
        .use(websocket())
        .get('/vite-static/version', () => ${revision})
        .ws('/vite-static/socket', { open(socket) { socket.send(${revision}) } })
    }
  }
}

export const ConfiguredPluginConfig = v.object({ label: v.optional(v.string(), 'default') })

@Plugin()
export class ConfiguredPlugin extends BasePlugin {
  private readonly settings = this.configs.use(ConfiguredPluginConfig)
  configuredLabel = ''

  protected override init() {
    this.configuredLabel = this.settings.label
    this.ctx.service(ElysiaApp)
      .use(websocket())
      .get('/configured/version', () => ${revision})
      .ws('/configured/socket', { open(socket) { socket.send(${revision}) } })
  }
}

@Plugin()
export class PartProvider extends BasePlugin {
  readonly marker = ${JSON.stringify(`part-provider-${version}`)}
  ${providerFails ? "protected override init() { throw new Error('provider init failed') }" : ''}
}

class RequiredPart extends PluginPart<PartOwner> {
  constructor(private readonly provider: PartProvider) { super() }
  marker() { return this.provider.marker }
}

@Plugin()
export class PartOwner extends BasePlugin {
  private readonly required = this.parts.use(RequiredPart)
  injected = ''
  protected override init() { this.injected = this.required.marker() }
}

export const runtimePlugins = [${includeViteStatic ? 'ViteStatic, ' : ''}ConfiguredPlugin, PartProvider, PartOwner, BuiltStatic]
`
}
