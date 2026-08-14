# Workbench InsightFlare Analytics

> 状态：proposal。本文中的配置、事件和 UI 尚未实现，也不是当前公共契约。

## 决策

Workbench 使用 InsightFlare 作为唯一浏览器 analytics provider，复用其 pageview、session、Core Web Vitals、自定义事件、JSON 分析、
通知和 dashboard。Pluxel 只提供条件加载、稳定事件、脱敏和关闭能力；应用发行方配置并治理自己的 InsightFlare Site。

这项能力回答三个问题：

1. 哪些发行版实际启用了哪些 Plugin，它们是否成功 running；
2. Workbench shell 和 Plugin remote 的加载性能如何；
3. 哪些 release/version 仍被观察到，产品与版权摘要是否变化。

页面打开、Tab 切换和配置页访问不代表 Plugin 价值，不作为 adoption/usage 指标。业务调用量必须由对应领域定义。

## Host policy

Pluxel upstream 默认关闭，因为它不知道数据接收方。Rhythm 等产品可以在明确告知后默认启用，但关闭入口必须与首次发布同时存在。

```ts
workbench: {
	enabled: true,
	analytics: {
		provider: 'insightflare',
		scriptOrigin: 'https://insight.example.com',
		siteId: '...',
		policyVersion: '2026-08-01',
		noticeUrl: 'https://example.com/legal/telemetry',
		defaultEnabled: true,
		pluginInventory: 'all',
	},
}
```

第一版只支持 InsightFlare，不设计 provider registry 或 arbitrary script injection。Policy 经 host 校验后进入既有 Workbench bootstrap；
shell 读取 host hard-disable 和 browser preference 后才加载官方 SDK。

用户关闭时先保存 preference，再 reload Workbench。InsightFlare 当前没有可靠的 runtime unload；下一次 document load 必须在 script
request 前完成 gate。Workbench disabled/headless 时没有 analytics，业务 HTTP 不依赖它。

## Site 与隐私设置

为便于按公开发行批次聚合，默认一个产品/环境一个 Site，使用 event `releaseId` 区分发行版。`releaseId` 由同一公开 build/release
共享，不对应单个客户交付。客户级 `distributionId` 和 delivery carrier token 永不进入 analytics。

Workbench Site 至少配置：

```text
trackQueryParams       false
trackHash              false
autoTrackOutboundLinks false
ignoreDoNotTrack       false
trackingStrength       smart（按适用政策调整）
performanceSampleRate 按流量预算设置
```

SDK 仍会采集 pathname、title、referrer、language、timezone、screen size 和 UA Client Hints，必须进入 disclosure。Workbench 使用严格
referrer policy；document title 不拼接账号、对象或用户输入。

Self-host domains 已知且数量在 InsightFlare 限制内时使用 domain whitelist；空 whitelist 接受任意 origin，只适合把数据作为可伪造的
分析信号，不能用于身份认证。

## 路由边界

InsightFlare 当前会把真实 pathname 附在 pageview 和 custom event 上；`pathBlacklist` 也会丢弃该 path 的 custom event。因此：

- 只跟踪固定 shell/catalog route 和仅含稳定 Plugin ID 的 route；
- account/object/user 参数 route 的静态 prefix 必须进入 Site blacklist；
- 未知 third-party remote route 默认不宣称安全支持；
- blocked route 的 remote timing 可暂存在当前 tab，返回安全 route 后再发送；
- 需要参数化 route 性能时，先推动 InsightFlare 支持 manual/template pathname，不 fork tracker 或伪造 visit。

部署 runbook 必须验证 Workbench sensitive prefixes 与 InsightFlare Site blacklist 一致。

## 公共字段

所有 custom event 带固定、browser-safe context：

```ts
{
	schemaVersion: 1,
	applicationId,
	productVersion,
	workbenchVersion,
	runtimeMode: 'static' | 'dynamic',
	releaseId?,
	revision?,
	policyVersion,
}
```

`releaseId` 是同一公开 build/release 共享的不透明 ID，不是客户交付 ID。不要发送 `distributionId`、客户名、合同号、license text、
Plugin config、Vault、用户/对象 ID、日志、stack 或 delivery carrier token。

## 第一版事件

### `workbench_runtime_observed`

每个 browser/day 一次，runtime state fingerprint 变化后补充一次：

```ts
{
	catalogPluginCount,
	enabledPluginCount,
	runningPluginCount,
	failedPluginCount,
	blockedPluginCount,
	workbenchVariant,
}
```

### `workbench_plugin_state_observed`

只发送 enabled、running、failed 或 dependency-blocked Plugin；纯 disabled catalog entry 不逐项发送：

```ts
{
	pluginId,
	sourceKind: 'static' | 'package' | 'hmr',
	runtimeStatus:
		| 'started'
		| 'config-invalid'
		| 'dependency-missing'
		| 'dependency-failed'
		| 'start-failed'
		| 'catalog-drift',
}
```

同一 release、Plugin 和 state fingerprint 每个 browser/day 最多一次；状态变化可补充。它衡量 Workbench-observed lifecycle
coverage，不代表最终用户使用了业务功能。

单次加载有 event 上限；超过时只发送 aggregate 与 `truncated: true`。不要为大 catalog 制造无界 burst。

### `workbench_remote_loaded`

```ts
{
	pluginId,
	result: 'ready' | 'failed',
	durationMs,
	cache: 'warm' | 'cold' | 'unknown',
}
```

仅用于 UI 性能。Duration 有上限，失败只发送稳定 load code，不发送 message/stack。

### `workbench_distribution_observed`

```ts
{
	productDigest,
	noticePresent,
	observedNoticeDigest,
	telemetryPolicyVersion,
}
```

Workbench shell 持续渲染带稳定 attribute 的法律声明节点。客户端规范化实际 `textContent` 并用 Web Crypto 计算 digest，不上传
版权全文；不能从只在 About 打开时才存在的临时节点取样。

## Plugin inventory policy

Host 必须选择：

- `none`：只发送 aggregate 与性能；
- `official-only`：发送官方 Plugin lifecycle state；
- `all`：发送全部 enabled/running/failure Plugin 的稳定 ID。

Rhythm 可以使用 `all`；未知 host 默认 `none`。实现前必须用真实 InsightFlare query 验证 event encoding 能按 Plugin、runtime status 和
unique release 得到所需覆盖率，不能只验证“数据写进去了”。

## 性能与透明度

- preference gate 不阻塞首屏；SDK 异步加载，失败不影响 router、remote、RPC 或业务操作；
- custom event 不等待网络；session/event/payload 有硬预算；
- analytics script 自身的 CPU/network 成本进入性能基线；
- Settings/About 展示 controller、origin、policy、字段字典、retention、release ID 和 inventory policy；
- UI 只能显示本地 enqueue 状态，不能伪装成 collector receipt；
- 关闭不承诺删除 InsightFlare 已存数据，删除流程属于 data controller。

## 验收标准

- host 未配置或用户关闭时，加载前不请求 InsightFlare；
- query/hash 不发送；已支持 sensitive prefix 全部被 Site blacklist 实测拦截；
- document title/referrer 不泄露对象或用户输入；
- event schema、cardinality、数量和 payload size 有硬上限；
- Plugin inventory policy 精确过滤；页面打开不作为 adoption；
- SDK/collector failure 不影响 Workbench；
- dashboard 能查询 Plugin running/failure coverage、safe-route Web Vitals、remote timing 和 distribution digest；
- 不 fork InsightFlare、不直接写 D1、不伪造 visit；
- disclosure、关闭入口和 retention 链接与首次发布同时存在。
