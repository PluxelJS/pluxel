import { getPluginInfo } from './packages/core/src/plugin/PluginDecorator.ts'
import { PluginA } from './packages/hmr/tests/plugins/PluginA.ts'

const info = getPluginInfo(PluginA)
console.log(info)
console.log('config keys', info.configMap && Object.keys(info.configMap))
