---
title: 文件存储
description: 通过 PluginFs 访问插件目录，使用原生 promise 操作和完整原子保存。
---

Host 显式安装 [FS 服务](../host/configuration.md#选择文件后端)后，Plugin 和 Part 可以取得所属插件的文件目录。返回值是 ZenFS 的 Node 兼容 `fs.promises`；Pluxel 只负责目录归属、准备和关闭，不另建文件操作接口。

## 取得目录并保存

必需文件能力用 `PluginFs`。以下业务方法要求数据跨 Host 保留且可写；服务缺失、后端准备或写入失败直接拒绝调用：

```ts
import { BasePlugin, Plugin } from '@pluxel/core'
import { PluginFs, writeFileAtomic } from '@pluxel/services/fs'

@Plugin()
export class ReportsPlugin extends BasePlugin {
	async saveReport(bytes: Uint8Array): Promise<void> {
		const files = await this.ctx.require(PluginFs)({ durable: true, writable: true })
		await writeFileAtomic(files, 'reports/latest.bin', bytes)
	}
}
```

解析 token 或取得 `ctx.fs` 访问函数不执行 IO；调用该函数才等待后端和目录就绪。可选功能先检查 `this.ctx.fs`，仅在需要保存时调用；未安装服务时是否允许继续由业务决定，不能把初始化失败当成可选缺失。

`durable` 和 `writable` 分别表达需求。`InMemory` 无法满足 `durable: true`，以 `ENOTSUP` 失败；只读后端无法满足 `writable: true`，以 `EROFS` 失败。检查在获取资源前执行，实际写入仍执行只读约束。没有这些要求时使用 `await this.ctx.require(PluginFs)()`。

## 使用文件操作

目录内直接调用 `readFile()`、`readdir()`、`mkdir()`、`stat()`、`rename()`、`rm()` 或 `open()`。方法与类型以固定版本的 [ZenFS API](https://zenfs.dev/core/) 为准，常见参数见 [Node promises API](https://nodejs.org/api/fs.html#promises-api)。

缺失文件沿用标准 `ENOENT`，不统一转换成空数据。业务允许“尚未保存”时才处理这一分支；损坏内容、权限、配额和其他 IO 失败继续传播。例如在已经取得 `files` 的业务方法中：

```ts
try {
	const text = await files.readFile('settings.json', 'utf8')
	return JSON.parse(text)
} catch (error) {
	if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
		return undefined
	}
	throw error
}
```

`readdir(path, { withFileTypes: true })` 返回目录直接子项；需要稳定顺序时由业务显式排序。缺失目录是否代表空集合，同样由领域决定。

`writeFileAtomic(files, path, string | Uint8Array)` 在同目录完整写入临时文件并关闭，再 rename 替换目标；父目录按需创建。它在提交完成后才 resolve，失败不会通过删除旧目标重试来伪装成功。普通 `writeFile()` 保留库语义；原子替换不等于断电 fsync 或多文件事务，revision、并发 writer 和提交后发布仍归业务所有。

## 目录与资源所有权

每个 Plugin node 使用固定目录；fork 分开，Part 与所属 Plugin 共用，restart 和 HMR 不改变目录。普通停止或删除 fork 不隐式删除业务文件。provider 保存自己的业务数据时，在 provider 的生命周期内取得访问函数，不能借当前 caller 改变文件归属。

目录借用自 Host。不要关闭共享后端；自己打开的 FileHandle、watcher 和后台任务由当前 generation 通过 `ctx.effects` 或原生 `await using` 释放。等待自己发起的 IO 后再退出，Host final 清理不排空任意未等待的裸文件操作。裸 promises 对象也不自动随 generation 撤回；Host 关闭后不再使用借用引用。

目录绑定表达数据归属，不是同进程恶意代码的安全沙箱。原生 driver 的数据库目录、日志 file sink、源码加载及其他需要宿主绝对路径的能力由各自部署入口配置，不从 `PluginFs` 推导原生磁盘路径。

## 验证

普通隔离测试可安装 `fs({ backend: InMemory })`。要求跨 Host、进程或页面保留的数据，使用真实的 Passthrough 临时目录或浏览器 IndexedDB，关闭后重新创建 Host 再检查；不要给内存配置附加虚假的持久性标签。测试还应覆盖业务允许的缺失分支、损坏内容和保存失败后是否仍保留已确认状态。
