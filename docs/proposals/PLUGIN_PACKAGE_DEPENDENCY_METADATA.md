# Plugin package dependency metadata

> 状态：研究中，尚未实现。本文记录已确认的问题和目标约束，不是当前 API。

## 问题

`pluxel build` 当前用 Rolldown import tracker 扫描带 `@Plugin` 的源码模块，再在成功构建后同步
`peerDependencies` 和 `pluxel.dependOn`。这个机制只服务于独立发布、由 dynamic route 发现的插件包；
static application 已由 `defineStaticRuntime({ plugins })` 给出固定 catalog，不需要包级 import tracker。

当前实现存在以下 correctness 问题：

1. producer 写入 `pluxel.dependOn: { required, optional }`，dynamic package loader 的
   `parseDependOn()` 却只接受字符串或数组，因此新结构会被读成空依赖集；
2. required 判定依赖“本次构建前是否位于 `dependencies`”，规则随后又把该项移动到
   `peerDependencies`；新进程再次构建时原信号已经消失，同一个 required dependency 会变成 optional；
3. static import 与 dynamic import 描述模块加载方式，不描述插件语义。`plugins.use(Provider)` 通常同样使用
   static import，不能据此判定 required；
4. optional provider 被移动到 `peerDependencies` 后没有同步
   `peerDependenciesMeta[name].optional = true`，package manager 仍可能把它当 required peer；
5. metadata sync 失败目前只记录 warning，release build 仍可能发布过期或错误 manifest；
6. `createOptionalDependencyHook()` 实际同时处理 required、optional、peer dependency 和 manifest，名称与职责不符。

更根本的问题是：constructor 是 required plugin dependency 的唯一事实源，而当前 tracker 只看 import 形式和
`package.json` 分区，并没有读取作者真正表达的依赖语义。

## 目标边界

- core graph 的 required edge 仍只来自 constructor metadata；包 manifest 不成为第二套 runtime graph。
- 包级 metadata 只帮助 dynamic route 做安装、发现、诊断和包操作，不能控制 plugin lifecycle。
- static application 不生成也不消费独立插件包依赖 manifest。
- dependency collector、schema validation 和产物规则归属 `@pluxel/rolldown/build`；CLI 只负责命令编排。
- 相同源码和输入连续构建任意次数，`package.json` 必须保持稳定。
- metadata 冲突在 release/CI build 中必须失败，不能静默发布。

## 目标数据模型

包级 dependency metadata 使用 producer/consumer 共同校验的单一结构：

```json
{
  "pluxel": {
    "dependOn": {
      "required": ["pluxel-plugin-database"],
      "optional": ["pluxel-plugin-audit"]
    }
  }
}
```

所有 plugin packages 使用 peer boundary；纯 optional package 另外写入 `peerDependenciesMeta.optional = true`。版本从已经存在的
peer/dev authoring metadata 读取，collector 不用 `dependencies` 分区判断依赖语义。同一 package 同时出现 required 与
optional usage 时 required 胜出，并移除 optional peer 标记。

dynamic loader 必须保留 required/optional 分类：required facts 可参与安装顺序、缺失诊断和 package operations；optional facts
不自动安装、不阻塞 consumer，只供 lazy optional scheduler、inventory 和诊断使用。

## 采集方向

不采用以下推导：

- 不能用 static/dynamic import 区分 required/optional；
- 不能只读 Rolldown resolved graph，因为 external 或 unresolved package 仍需诊断；
- 不能等 runtime 加载后反射，因为 package loader 在加载前就需要 package facts。

推荐由 source-aware collector 建立 identifier 到 import source 的映射，并只采集明确作者语义：

- concrete plugin constructor parameter 对应的实现包是 required package usage；
- abstract contract constructor parameter 只表达 required capability，不能静态猜测具体 provider package；provider selection 属于
  host/loader config；
- `defineOptionalPlugin()` 中的 literal import 是 optional package usage；
- 只有被标准 descriptor 包裹的 import 才具有 optional plugin 语义，其他 dynamic import 不参与 plugin metadata；
- `plugins.use(AbstractContract)` 不产生具体 provider package dependency；
- contract package 是正常共享协议依赖，不等同于 provider implementation；
- 第一阶段不生成 contract advertisement；未来若为离线 catalog 增加广告，也不能授权 loader 自动安装 provider。

collector 应内建于 `pluginPackage()` preset，而不是由 CLI 手动追加。内部仍可由多个单一职责的 Rolldown plugin、
tsdown input options 和 build-success transaction 组合；“一个 preset”不要求把所有阶段塞入一个 `transform()` hook。

## 验收条件

1. producer 与 dynamic loader 对同一 manifest schema 做共享 fixture 测试；
2. 同一 fixture 在两个独立构建进程中连续构建，第二次为零变更；
3. required constructor、optional descriptor、两者同时使用、多个 constructors、package rename 和无 package mapping 均有测试；
4. abstract contract integration 不进入具体 provider `dependOn`，lazy optional descriptor 正确进入 optional；
5. optional peer metadata 与 package installer“不自动安装、不阻塞”行为一致；
6. metadata 失败在 watch/dev 可诊断，在 release/CI 阻止发布；
7. static freezer 的 catalog、bundle closure 和 deployment manifest 不依赖本机制。
