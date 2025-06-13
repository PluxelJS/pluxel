// index.ts
import 'reflect-metadata'
import { Context } from './index'
import { PluginA, PluginB, PluginC } from './plugins'

const ctx = new Context()

const pluginRegistry = ctx.registry.pluginRegistry

// 注册插件，假设 PluginA 必需依赖 PluginB
// 如果缺少必需依赖（例如未注册 PluginB），PluginA 将因解析失败而不加载
pluginRegistry.registerPlugin(PluginB)
pluginRegistry.registerPlugin(PluginC) // PluginC 为可选依赖，可注册也可不注册
pluginRegistry.registerPlugin(PluginA)

await ctx.registry.commit()
// 提交本周期，构建 diod 容器后依次初始化插件

pluginRegistry.reloadPlugin(PluginA)
pluginRegistry.unregisterPlugin(PluginC)

await ctx.registry.commit()
