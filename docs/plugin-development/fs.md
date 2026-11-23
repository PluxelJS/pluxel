---
title: 文件系统存储（FS）
description: 通过 ctx.fs() 访问专属文件目录，使用标准的 Promise 文件操作与原子化写入。
---

需要保存二进制媒体、导出文档等文件时，插件通过 `ctx.fs()` 借用所属节点的目录。支持文件的 Host 返回绑定到该目录的 ZenFS `fs.promises` 句柄。Node 和浏览器入口默认挂载内存，应用可按部署环境挂载本地磁盘或 IndexedDB。文件操作的支持范围由所选后端决定。 [选择文件后端](../host/configuration.md#选择文件后端)

需要跨 Host 重开保留文件时，调用 `ctx.fs({ durable: true, writable: true })`。Host 检查覆盖插件目录的挂载及其子挂载。缺少持久性声明时收到 `ENOTSUP`，挂载只读且要求可写时收到 `EROFS`。Cloudflare Worker Host 没有插件文件后端，普通 `ctx.fs()` 也会以 `ENOTSUP` 拒绝。能接受单个根寿命的结构化数据可保存到 TinyBase。 [跨平台宿主契约](../host/runtime-portability.md)

## 访问目录与写入文件

在插件中调用 `this.ctx.fs()` 获取当前插件专用的目录句柄：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { writeFileAtomic } from '@pluxel/core/fs'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	async saveLatestReport(bytes: Uint8Array): Promise<void> {
		const files = await this.ctx.fs({ durable: true, writable: true })

		await writeFileAtomic(files, 'reports/latest.bin', bytes)
	}
}
```

`writeFileAtomic` 写完并关闭同目录的临时文件，再用后端的 `rename` 替换目标文件。替换的原子性取决于该后端，断电后的落盘保证取决于存储介质及其同步策略。

## 常用文件操作

常用操作可直接通过句柄调用。

```ts
// 读取文件
try {
	const content = await files.readFile('settings.json', 'utf8')
	return JSON.parse(content)
} catch (error: any) {
	if (error?.code === 'ENOENT') {
		return undefined // 文件尚未创建
	}
	throw error
}

// 遍历目录子项
const entries = await files.readdir('reports', { withFileTypes: true })
for (const entry of entries) {
	if (entry.isFile()) {
		this.ctx.logger.info('Found report', { name: entry.name })
	}
}
```

## 目录与资源所有权

- **专属数据隔离**：每个插件节点拥有独立的文件存储前缀，不同插件之间的业务文件默认相互隔离；
- **Part 共享目录**：挂载在主插件内的 `PluginPart` 默认与所属主插件共用同一文件系统目录；
- **资源清理**：如果业务代码中打开了底层文件句柄（如 `files.open()`）或注册了文件监听器，应在插件退出时通过 `this.ctx.effects.defer()` 主动关闭，避免句柄泄漏。
