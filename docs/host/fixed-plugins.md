---
title: 启停和配置内置插件
description: 用浏览器扩展「净链」启停随应用发布的规则，修改参数，并在重开后恢复选择。
---

净链把两个插件打进同一份浏览器扩展。「移除 UTM 追踪参数」默认启用，「移除页内锚点」默认停用。用户可以在设置页启停规则或修改参数，直接从清理后的链接看到结果。

## 运行净链

示例位于 Pluxel 源码仓库的 `projects/host-wxt/`。取与本文档一致的版本，在仓库根目录运行以下命令。开发服务会打开已加载扩展的 Chromium。浏览器在宿主机、开发服务在容器时，按示例 README 手动加载扩展。[Pluxel 源码仓库](https://github.com/PluxelJS/pluxel)

```sh
vp install --frozen-lockfile
vp run @pluxel-example/host-wxt#dev
```

点击浏览器工具栏的「净链」，打开「规则设置」。以下步骤使用初次运行时的默认设置。

1. 「测试链接」默认是 `https://example.org/guide?ref=mail&utm_source=feed#setup`。UTM 规则移除 `utm_source`，「清理结果」保留 `?ref=mail#setup`。
2. 在 UTM 规则的「额外移除的参数」填写 `ref`，点击「保存配置」。结果变为 `https://example.org/guide#setup`。再填入 `ref id` 并保存，表单会提示使用逗号分隔，结果仍沿用上一次有效配置。
3. 关闭 UTM 规则的开关。清理结果恢复为原始链接。停用期间把参数改为 `ref, id` 并保存，设置页显示「已保存，启用时采用」。
4. 关闭设置页，再次打开「规则设置」。规则仍处于停用状态，参数仍为 `ref, id`。把测试链接换成 `https://example.org/guide?ref=mail&id=7&utm_source=feed#setup`，然后启用规则。结果应为 `https://example.org/guide#setup`。

## 把开关接到自己的应用

在应用工厂的 `plugins` 中写入随包导入的插件类和初始启动选择，例如 `{ plugin: TrackingParameters, autoStart: true }`。规则在 `init()` 中向 `LinkCleaner` 注册清理函数，并返回撤销注册的函数。Host 停止该节点时执行清理，其他规则继续处理链接。见示例的 `src/tracking.ts`。

净链把每条规则的开关保存在 `browser.storage.local`。新页面启动 Host 时以该选择作为 `autoStart`。已打开的页面收到变更后，用 `TrackingParameters.nodeAddress()` 取得节点地址，调用 `host.startNode(node)` 或 `host.stopNode(node)` 同步本页的运行状态。开关显示已保存的选择，旁边的状态来自 `host.status()`。某条规则启动失败时，重开设置仍能查看原因、单独关闭它，继续使用其余规则。关闭页面时释放 Host。

在单个 Host 管理启动策略的应用中，可用 `host.setAutoStart(node, enabled)` 记录选择。让 `policy.document` 使用持久存储，并在代码显式声明默认开关时设置 `policyMode: 'saved-first'`。单次 `stopNode` 只影响本次运行，重开后仍按启动策略和依赖关系运行。被其他插件依赖的节点即使关闭主动启动，也可能被依赖方拉起。[保存配置和运行策略](./configuration.md#保存配置和运行策略)

## 保存参数并显示生效结果

设置页打开表单时从 `host.config.get(node)` 读取保存值和 `managedRevision`。提交编辑时使用原版本，避免覆盖其他页面刚保存的参数。示例的 `entrypoints/options/management.ts` 在页面 Host 上处理提交。给 UTM 规则设置两个参数的调用如下。

```ts
const result = await host.config.patch(
	TrackingParameters.nodeAddress(),
	{ set: { extraParameters: 'ref, id' } },
	{ expectedManagedRevision: revision },
)
if (!result.ok) throw new Error(result.message)
```

表单遇到校验错误或版本冲突时保留草稿。成功后按 `result.application` 显示处理结果。

- `applied` 表示运行中的插件已采用有效配置。净链用 `configs.onUpdate()` 更新清理函数读取的参数。
- `deferred` 表示节点停用，插件下次启动时通过 `configs.use(schema)` 读取有效配置。
- `saved-not-applied` 表示值已保存，当前实例尚未采用。显示 `applyFailure` 原因。需要重新初始化的插件可重启后采用新值。

净链把 `config.document` 交给浏览器持久存储，已打开的页面订阅文档变更，新页面启动时读取保存值。[插件配置与更新](../plugin-development/configuration.md) · [其他宿主的存储选择](./runtime-portability.md#重开后还要保留什么)
