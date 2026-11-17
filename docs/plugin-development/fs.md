---
title: 文件系统存储（FS）
description: 通过 ctx.fs() 访问专属文件目录，使用标准的 Promise 文件操作与原子化写入。
---

对于需要读写大文件、二进制媒体或导出文档的插件，Pluxel 提供了开箱即用的虚拟文件系统能力。通过 `this.ctx.fs()`，插件能够获取一个与自身强绑定的文件系统句柄，底层由 [ZenFS](https://zenfs.dev/) 驱动并兼容标准的 Node.js `fs.promises` API。

宿主可根据部署环境将底层存储挂载为纯内存（InMemory）、本地磁盘（Passthrough）或浏览器存储（IndexedDB）。

## 访问目录与写入文件

在插件中调用 `this.ctx.fs()` 获取当前插件专用的目录句柄：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { writeFileAtomic } from '@pluxel/core/fs'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	async saveReport(reportName: string, bytes: Uint8Array): Promise<void> {
		// 1. 获取专属文件系统句柄
		const files = await this.ctx.fs({ durable: true, writable: true })

		// 2. 使用安全原子写入，防止意外写入中断导致文件损坏
		await writeFileAtomic(files, `reports/${reportName}.bin`, bytes)
	}
}
```

`writeFileAtomic` 会先写入临时文件，再通过原子重命名（rename）完成目标替换，能够有效防止写入中途崩溃导致残缺文件。

## 常用文件操作

获取到的 `files` 句柄提供了与 Node.js `fs.promises` 一致的标准方法：

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
		console.log('Found report:', entry.name)
	}
}
```

## 目录与资源所有权

- **专属数据隔离**：每个插件节点拥有独立的文件存储前缀，不同插件之间的业务文件默认相互隔离；
- **Part 共享目录**：挂载在主插件内的 `PluginPart` 默认与所属主插件共用同一文件系统目录；
- **资源清理**：如果业务代码中打开了底层文件句柄（如 `files.open()`）或注册了文件监听器，应在插件退出时通过 `this.ctx.effects.defer()` 主动关闭，避免句柄泄漏。
