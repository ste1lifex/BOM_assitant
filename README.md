# BOM_assitant — 立创选料 DSH 插件

按「用料需求」在立创商城 / 嘉立创元件库中找**性价比最优**的料，给已有 BOM 做价格、库存、基础库/扩展库体检，
并按立创商城编号把**官方数据手册 PDF** 下载到指定目录。
来自 [Recording_card](../Recording_card)（开源录音工牌）项目里立创选型与查价的探索，做成 DeepSeek Harness（DSH）插件。

## 三个工具（默认手焊）

| 工具 | 作用 |
|---|---|
| `find_lcsc_parts` | 三种模式：需求→参数匹配；LCSC 编号（1–20 个）→ 带 `ok/out_of_stock/not_in_smt_library/unknown_code` 状态；`category` + `filters` + `sort="size"` 品类浏览。结果带全量属性、尺寸、datasheet/product 链接 |
| `audit_lcsc_bom` | 已有 BOM（CSV 或 JSON）→ 逐行价格/库存/基础库-扩展库；SMT 模式算 $3/料号上料费并推荐基础库替代 |
| `download_lcsc_datasheet` | LCSC 编号 + 目标目录 → 官方数据手册 PDF 落盘（校验 `%PDF-`，返回路径/大小/SHA-256） |

- `assembly=hand`（默认）：DIY 手焊，不考虑上料费；立创国内站人民币价 best-effort，取不到时给批量档 USD × 6.0 的**参考估算**（明确标注，非实际报价）
- `assembly=smt`：嘉立创贴片，基础库优先，扩展库按 $3/唯一料号/单摊销
- 数据手册解析：查看器页 / `wmsc` 跳转 / `datasheet.lcsc.com` / 商品页 `pdfUrl` 依次尝试，国际站没有时用国内站 `atta.szlcsc.com` 兜底
- 检索数据源是 **JLCPCB SMT 元件库**，不是立创全部零售 SKU；电声/机电件覆盖薄，品类查询优先英文关键词
- 只暴露 3 个工具，避免与其他插件一起装时污染模型上下文

## 目录

```
docs/
  立创找料DSH插件_调研与决策.md      # 开源生态调研、prior art、数据源实测、决策建议
  工具设计_LCSC选料插件.md           # 工具面/参数/排序算法/实现状态
  改进记录_0.3.0.md                  # 对 Recording_card 改进建议的逐条落地与验收
  数据手册下载_调研与实现.md          # 0.4.0：手册 URL 的五种形态、解析兜底与实测
  改进记录_0.5.0.md                  # 0.5.0：按 agent 反馈重做 find（状态化/品类浏览/属性/禁止跨品类）
research/
  prior-art.md                       # 20+ 同类项目调研（初稿）
  lcsc-probe/                        # 数据源探针脚本
poc/
  lcsc-dsh-plugin/                   # 可安装 DSH bundle（index.js 工具层 + data.js 数据层 + cn.js 国内站适配器 + datasheet.js 手册下载，零依赖）
  validate.mjs                       # 离线测试（247 项）
  test-improvements.mjs              # 0.3.0 联网验收（BOM v0.6 + 人民币 golden 数据）
  test-datasheet.mjs                 # 0.4.0 联网验收：5 种手册解析路径 + 国内站兜底
  test-recording-card.mjs            # 早期集成脚本（BOM v0.5）
  test-output/                       # 实测 JSON / PDF 输出（datasheets/ 已忽略）
```

## 快速开始

```bash
# 离线测试（247 项）
node poc/validate.mjs

# 用 Recording_card BOM 联网实测
node poc/test-recording-card.mjs

# 数据手册下载联网验收（产物在 poc/test-output/datasheets/）
node poc/test-datasheet.mjs

# 装进 DSH（在 DSH 会话中让 agent 执行 plugin_manager install_bundle）
#   target: /absolute/path/to/poc/lcsc-dsh-plugin
```

## 数据源与限制

- JLCPCB SMT 元件库接口：搜索、属性、基础库/扩展库、库存、USD 阶梯价（主数据源）
- lcsc.com 国际站商品页：USD 阶梯价、库存、`webData.pdfUrl`（手册直链）
- datasheet.lcsc.com / atta.szlcsc.com：官方数据手册 PDF CDN（0.4.0 新增）
- item.szlcsc.com 国内站：人民币 1pc 价（best-effort，阿里云 WAF 间歇限流）
- CNY 与 USD **从不未经标注地换算**；估算值固定标注「估算参考」
- 不绕过 WAF、不抓淘宝/1688、不做下单；价格库存为快照，下单前请复核

## 状态

- 插件 **v0.5.0**：按 agent 真实选型反馈重做 `find_lcsc_parts`
  - 精确编号状态化：1–20 个编号 → `ok / out_of_stock / not_in_smt_library / unknown_stock / unknown_code`，缺货不再被 `stock>0` 过滤
  - 品类浏览：`category="buzzer" + filters + sort="size" + max_scan=5000`，扫描 4605 条蜂鸣器（5×1000 分页）筛出 39 个无源压电贴片候选，按面积升序
  - 候选回吐全量 `attributes`、解析尺寸、`datasheet_url`、`product_url`；`filter_report` 给出可用属性值，agent 不必再裸探接口
  - 禁止跨品类降级：蜂鸣器查不到就返回 0 条 + 数据源边界提示，不再拿 WiFi 模组冒充
  - 改进记录见 [docs/改进记录_0.5.0.md](docs/改进记录_0.5.0.md)
- 基线 **v0.4.0**：新增 `download_lcsc_datasheet`（按 LCSC 编号把官方数据手册 PDF 下载到指定目录）
  - 支持 5 种真实链接形态：`lcsc.com` 查看器页、`wmsc` JS 跳转、`datasheet.lcsc.com` 直链、商品页 `pdfUrl`、国内站 `atta.szlcsc.com`
  - 逐候选 fetch → 看字节 → 抽下一跳（最多 3 跳）；只认 `%PDF-`，找不到就 `not-found`，不伪造链接
  - 默认文件名 `<编号>_<型号>.pdf`；`overwrite=false` 时不重复下载；64MB 上限；临时文件 + rename 原子落盘
  - 实测 C1581 / C7434398 / C2765186 / 国内站兜底全部成功，PDF 字节数与 Content-Length 一致
  - 调研细节见 [docs/数据手册下载_调研与实现.md](docs/数据手册下载_调研与实现.md)
- 基线 **v0.3.0**：按 Recording_card《工具改进建议》（docs/改进记录_0.3.0.md）完成 P0/P1 改进
  - 型号/LCSC 精确匹配优先（SMF5.0A / AO3401A / TP4054 不再被误解析）
  - BOM 逐行 place=smt/hand/dnp；重复料号合并、上料费按唯一料号只计一次
  - 双库存（stock_smt / stock_lcsc）+ 双价格（USD / CNY）并列不混算
  - 真实人民币价：Chrome 无头渲染国内站 + 24h 缓存（C1581 ¥0.0239、C7434398 ¥1.097 已验证；失败自动降级估算）
  - 批量摊销表（20/100/300/1000 片）+ 净节省替代建议 + 嘉立创 BOM CSV 导出
- 测试：`node poc/validate.mjs` 247 项离线全过；`node poc/test-improvements.mjs` 联网验收 OK；`node poc/test-datasheet.mjs` 4 条手册路径 + 国内站兜底 OK
- Recording_card BOM v0.6.1（100 片 SMT）：25 smt / 1 hand / 6 dnp，基础库 13 / 扩展库 12；元件 + 上料费合计约 USD 144.60（当日价格）
- 历史：v0.2.0 时 BOM v0.5（28 个唯一料）基础库 12 / 扩展库 16，SMT 5 片打样上料费 16×$3=$48
- **数据边界/使用注意**（价格口径、库存时效、Chrome 依赖、上料费假设、替代料局限）统一写在
  [poc/lcsc-dsh-plugin/README.md#先说边界重要](poc/lcsc-dsh-plugin/README.md#先说边界重要)

## License

MIT（见 [LICENSE](LICENSE)）。数据来自公开接口与页面，仅供选型参考，不构成采购承诺。
