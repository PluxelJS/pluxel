// start.ts
import { configure } from '@logtape/logtape'
import { createPluxelLogtapeConfig } from '@pluxel/core/logger'
import { Context } from '@pluxel/test'
import { PluginA, PluginB, PluginC } from './plugins'

await configure(
	createPluxelLogtapeConfig({
		preset: 'core',
	}),
)

const ctx = new Context()

// 注册插件，假设 PluginA 必需依赖 PluginB
// 如果缺少必需依赖（例如未注册 PluginB），PluginA 将因解析失败而不加载
ctx.registry.register(PluginB)
ctx.registry.register(PluginC) // PluginC 只是运行期附加能力，可注册也可不注册
ctx.registry.register(PluginA)

await ctx.registry.commit()
// 提交本周期，构建 diod 容器后依次初始化插件

ctx.registry.restart(PluginA)
ctx.registry.unregister(PluginA)

await ctx.registry.commit()

ctx.registry.register(PluginA)

await ctx.registry.commit()

ctx.registry.unregister(PluginA)

await ctx.registry.commit()
