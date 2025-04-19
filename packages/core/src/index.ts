// index.ts
import 'reflect-metadata'
import { PluginManager } from './core/PluginManager'

import type { GlobalContext, Logger } from './core/GlobalContext'
import { PluginA } from './plugins/PluginA'
import { PluginB } from './plugins/PluginB'
import { PluginC } from './plugins/PluginC'

// 构造简单的 Logger、Config、EventBus（占位实现）
const logger: Logger = {
	info: console.log,
	error: console.error,
}

const globalContext: GlobalContext = {
	logger,
}

const pluginManager = new PluginManager(globalContext)
const pluginRegistry = pluginManager.pluginRegistry

// 注册插件，假设 PluginA 必需依赖 PluginB
// 如果缺少必需依赖（例如未注册 PluginB），PluginA 将因解析失败而不加载
pluginRegistry.registerPlugin(PluginB)
pluginRegistry.registerPlugin(PluginC) // PluginC 为可选依赖，可注册也可不注册
pluginRegistry.registerPlugin(PluginA)

const { container } = await pluginManager.commitWithStatus()
// 提交本周期，构建 diod 容器后依次初始化插件

container.get(PluginB).doSomething()
container.get(PluginA).doSomething()
