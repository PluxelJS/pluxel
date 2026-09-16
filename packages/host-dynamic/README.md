# @pluxel/host-dynamic

为同一个 Plugin Host 增加可变文件来源，开发与生产共用。包不依赖 Runtime、Vite 或开发驱动。

```ts
import { dynamicSource } from '@pluxel/host-dynamic'

export default {
	plugins: [/* 固定插件 */],
	sources: [
		dynamicSource({
			kind: 'directory',
			path: '.pluxel/managed-plugins/entries',
			include: ['*.mjs'],
		}),
	],
}
```

`dynamicSource()` 只校验并复制声明，不扫描或监听。宿主打开来源会话后，首次扫描和后续新增、修改、删除通过同一 watcher 处理；尚不存在的目录可在启动后创建。路径相对于应用 root。目录只接受正向、不能越出目录的 include glob。

来源只交付文件路径，不自行执行模块或提交图。开发启动器通过共同 ModuleRunner 加载；生产启动器负责加载构建产物。`close()` 同步停止通知，异步等待 watcher 释放，可重复调用。Abort 同样停止通知，不会取消已经交付给启动器的模块求值。

Package Manager 等 producer 使用 `@pluxel/host-dynamic/source-producer` 的 `requireDynamicPluginSource(ctx, declaration)`，在创建目录或启动安装前确认宿主已声明目标来源。校验不会授予修改 catalog 的权限。安装成功、entry 发布、catalog 接受、插件运行是不同事实。

Runtime 的原生生产加载器支持初始加载、新 entry 与撤回。对已经加载过的路径进行修改或删除后重新发布，返回 `PLUGIN_SOURCE_RESTART_REQUIRED` 并要求重启进程：Node ESM 缓存传递依赖，给 wrapper 增加 query 并不能可靠刷新安装包。开发时的完整更新由共享开发驱动承担。
