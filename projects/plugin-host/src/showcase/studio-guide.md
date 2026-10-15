# 报表工作流

1. 在 Architecture Lab 页面选择 **Rendering engine**，编辑 **Report title**，生成报表预览。
2. 使用同一引擎与标题再次生成，查看右侧缓存命中变化。
3. 在底部 **最近产物** 查看本次插件运行生成的结果，最新结果排在前面。

支持 ECharts 图表、Canvas 绘图、Takumi JSX、真实 HeroUI v3 卡片、Markdown 与 Typst。Typst 输出 SVG，其他引擎输出 PNG。

## 排查

- 渲染或存储来源不符合预期时，打开插件信息检查依赖提供者。
- 出站请求使用插件配置与 **Outbound HTTP** 页面管理的设置。
- 清空缓存只影响预览缓存，已生成的产物仍保留。

这些面板跟随当前插件；切换到其他插件后，再返回即可读取最新状态。
