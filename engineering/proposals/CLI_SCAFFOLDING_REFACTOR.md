# CLI Scaffolding Follow-ups

> 状态：draft proposal。create/CLI ownership、固定 starter、轻量 Plugin template、byte plan 与 packed smoke 已实现；
> 当前事实见 [`../TOOLCHAIN.md`](../TOOLCHAIN.md)、[`../../packages/create/README.md`](../../packages/create/README.md)
> 与 [`../../packages/cli/README.md`](../../packages/cli/README.md)。本文只讨论尚未实现的 remote Plugin template。

## 已确定设计

### 两个产品入口，不共享生成结果

```text
pnpm create @pluxel
  -> @pluxel/create
  -> fixed example monorepo + versioned docs snapshot

pluxel new
  -> @pluxel/cli internal scaffold pipeline
  -> publishable Plugin package
```

`@pluxel/create` 不依赖或加载 CLI。starter 是固定资产，零插值、零 prompt、零远程 source；根项目不需要 name、
packageName 或 author 输入。create 的 tsdown build 使用标准 `copy` 把 starter 与仓库 `docs/` 一起快照到发布包，
创建时复制到 `docs/pluxel/`。

`@pluxel/cli` 只维护 Plugin package template。Plugin name、package name、class name 和 description 是真实变量，因此使用
严格 `pluxel-template.jsonc` 与只支持 `{{ key }}` / `{{ json key }}` 的 `.tpl`。普通文件逐字节复制；不引入
Handlebars、condition、loop、partial 或模板代码执行。

### 固定 starter 的质量门槛

create starter 使用中性 `@example/*` 命名并同时展示：

- 无 package manifest 和 Pluxel import 的 `host/web/` React source，以及直接依赖 workspace Plugins 的 host package；
- host-owned 单一 Vite config，以自己的 `web/` 为 root，并让 mode 只选择 static/dynamic route policy；
- 默认 static Vite mode 与经过 Web public copy 后重新 finalization 的 `staticApplication()` production build；
- React Todo client 与同 origin 的 Plugin-owned HTTP；
- 普通 domain package 和普通 Vitest；
- Valibot config、constructor required dependency、`definePluginRef()` optional integration；
- core-only 与 runtime test host；
- pnpm catalog、Turbo、Oxfmt、Oxlint、governance、CI；
- 与 create 发布物逐文件一致的 `docs/pluxel/`。

packed create smoke 必须完成外部安装、workspace `verify`、frozen static route、同一 Vite 的 SPA/API、dynamic mode。packed
CLI smoke 独立完成 Plugin install、verify、build 和 pack inventory。两者不比较 parity。

## 为什么不使用 giget 交付官方 starter

giget 解决 Git provider、ref、subdirectory、archive、cache、offline 和 auth；它不定义 Pluxel prompt、identity、render、
collision、overwrite 或 install policy。官方 starter 需要与 create 发布版本和 docs 快照一起可审计、离线、可复现，因此
不经过网络 acquisition。

当前只有一个 bundled Plugin template，也没有证据表明需要远程 portfolio。现在加入 giget 只会增加下载、缓存、凭证和
archive 信任边界，不会改善固定 starter 或单插件生成。

## 未来 remote Plugin template

只有出现至少一个由真实团队维护、无法放进 CLI tarball 的 Plugin template 时，才新增 remote source。giget 可以作为
internal acquisition adapter，但不得替代现有 pipeline：

```text
explicit remote specifier
  -> giget download to CLI-owned temporary directory
  -> archive/filesystem safety validation
  -> existing manifest + prompt + byte-plan pipeline
  -> explicit materialization
  -> optional explicit install
```

第一版只接受显式 provider syntax，例如：

```sh
pluxel new --template gh:acme/pluxel-plugin-template#<immutable-ref>
```

bare identifier 始终只解析 bundled template；`./`、`../`、absolute path 和 `file:` 始终是 local source。registry 或
provider 中出现同名项目不得改变 source kind。

### Adapter 约束

- lazy import giget，bundled/local path 与 `pluxel --help` 不加载它；
- destination 必须是 CLI 创建的 temporary directory，禁止把最终用户目录交给 giget 或启用 destructive clean；
- 拒绝 symlink、device、socket、path escape、case-fold collision，并限制文件数、单文件和总解压大小；
- provenance 记录 requested specifier、resolved commit 与 content digest；
- credential 不进入日志、manifest input、render data 或 cache key diagnostics；
- cleanup 在 acquisition、prompt、plan、materialize、install、cancel 任一失败路径上幂等执行；
- remote template 默认不安装，只有显式 `--install` 才允许运行 package-manager lifecycle scripts；
- manifest 仍不能声明 shell command、JavaScript hook 或 post-create code。

### 验收条件

remote support 只有同时满足以下条件才可发布：

1. 至少一个受维护的远程 Plugin template 通过 packed install/verify/build/pack smoke；
2. 本地 HTTP/provider fixture 覆盖 ref、subdirectory、cache hit、offline miss 与 auth redaction；
3. malicious archive 覆盖 symlink、path escape、case collision、文件数量和解压大小限制；
4. failure injection 证明所有 command exit path 清理 temporary root；
5. packed CLI 证明 remote adapter 不进入 bundled/local 或 help hot path；
6. stable error code 区分 acquire、auth、offline、contract、render、target 和 install failure。

## 否决条件

出现任一情况则停止或缩小 remote 方向：

- giget 必须接管最终 destination 或清理用户目录；
- bundled Plugin template 或 create starter 必须经过 provider/cache；
- remote template 需要任意代码执行才能工作；
- 为 remote adapter 扩张 `.tpl` 语言，引入 condition、loop 或 dynamic helper；
- provider 无法给出足够 provenance，CI 不能区分 immutable 与 mutable source；
- 没有真实外部 template consumer，只是为了预先建立 registry。

## 未决问题

1. remote v1 是否完全拒绝 branch，还是只允许交互模式并明确显示 mutable provenance？
2. 出现真实 template author 后，是否发布 `pluxel-template.jsonc` JSON Schema；runtime validator 始终仍是信任边界。
3. remote cache 的容量、过期和清理应复用 giget 默认，还是由 CLI 建立更严格的 per-source quota？
