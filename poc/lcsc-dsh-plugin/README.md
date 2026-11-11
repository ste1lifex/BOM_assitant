# dsh-plugin-lcsc

> 立创商城 / 嘉立创选料与 BOM 体检，为 DeepSeek Harness 提供 **2 个工具**。
> 默认面向**国内手焊 DIY**：给真实人民币价 + 国内库存；也支持嘉立创 SMT 的 $3/扩展库上料费核算。

当前版本 **0.3.2**（npm 上最新发布版本以 npm 页面为准）。

只暴露 2 个工具，不挤占模型上下文。

## 卖点

- **需求直接变料**：封装/容值/耐压/电流/精度/尺寸 → 参数过滤 + 分级降级；型号和 LCSC 编号优先精确匹配（`SMF5.0A`/`AO3401A`/`TP4054` 不会被误读成数值）。
- **真实国内价 + 国内库存**：Chrome 渲染立创官方商品页取 `price`/`stockNumber`，不是估算；无 Chrome/WAF/超时才降级为标注估算。
- **性价比排序**：单价（按采购量取档）+ 库存覆盖 + 参数匹配 + 基础库/扩展库权重；`assembly=smt` 时把 $3/料号上料费摊销进成本。
- **BOM 体检**：逐行 `smt/hand/dnp`、重复料号合并、双库存/双价格并列、批量摊销表（20/100/300/1000 片）、基础库替代的**净节省**、直接导出嘉立创 BOM CSV。
- **快且不留垃圾**：常驻 Chrome + CDP 多标签，28 料完整手焊 BOM 首次约 26.5s，缓存命中 **0.0s/次**；Chrome 缓存/JSON 缓存都有清理策略（见「边界」中的缓存行）。

## 先说边界（重要）

| 数据/能力 | 来源 | 边界与注意 |
|---|---|---|
| `price_cny`（人民币价） | 立创商城官方商品页 `pageProps.price` | 是 **1pc 零售价**，不是批量阶梯价/整盘价，也不是含税发票价；抓取时刻快照，会变 |
| `stock_lcsc`（国内库存） | 同一页 `productRecord.stockNumber` | **实时快照**（实测同一天 177000→22、89430→88000 都出现过）；不承诺有货，下单前复核 |
| `price_usd` / `stock_smt` | 嘉立创 SMT 元件接口 | USD 口径、SMT 备料仓；与国内人民币价是两套体系，**从不互相换算** |
| CNY 估算 | 最高采购量档 USD × 6.0 | 仅在无 Chrome / WAF / 超时时出现，必带 `estimated=true`，只作参考 |
| 上料费 | 嘉立创扩展库规则 | $3/唯一扩展库料号/单（可配），不含工程费、钢网费、焊点费、加急费；「优选扩展库」分类未公开，可能高估 |
| `region=cn` | — | 国内嘉立创 SMT 人民币费率表未内置，输出会显式标注按 USD 估算 |
| 本地 Chrome | `--headless=new` + CDP pipe | **没有 Chrome 就没有真实人民币价**（自动降级估算）；首次渲染需过 WAF 挑战（约 5s） |
| 替代料 | 同类别 + 基础库 + 参数匹配 | 只做保守同类替换，不做电气/热/寿命/认证等效；封装不同会标「需改 PCB」 |
| 选型范围 | — | 必须有 LCSC 编号或可搜到的型号/描述；插件不做“猜你要什么” |
| 价格/库存时效 | 公开页面/接口 | 都是抓取时刻快照；24h 缓存只用于性能，不代表历史价 |
| **本地缓存**（`~/.cache/dsh-plugin-lcsc`） | JSON 结果 + Chrome profile | JSON：24h TTL、最多 800 条，过期/超量自动删；Chrome：只保留 WAF cookie，HTTP/Code/GPU/Crashpad 缓存**每次关闭即清**，磁盘缓存硬上限 50MB；空闲 120s 关 Chrome、卸载 `dispose()`；`rm -rf ~/.cache/dsh-plugin-lcsc` 可整体清理 |

## 两个工具

### `find_lcsc_parts` — 按需求找料

```jsonc
{"need":"0402 100nF 50V X7R ±10% capacitor","assembly":"hand","boards":5,"quantity":5}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `need` | 必填 | 中文/英文需求，或型号、LCSC 编号 |
| `assembly` | `hand` | `hand` 手焊（无上料费）/ `smt` 嘉立创贴片（扩展库计上料费） |
| `quantity` / `boards` | 1 | 每板用量 / 打板数（决定价格档与摊销） |
| `sort` | `balanced` | `balanced` / `cost` / `stock` |
| `limit` | 5 | 1–8 条 |
| `include_cny` | hand 时 true | 取真实国内人民币价（Chrome，24h 缓存） |
| `base_only` | false | 只保留基础库；没有时明确提示 |
| `exclude_lcsc` | — | 排除料号，用于找替代 |

每个候选同时给：`price_usd`（含 `tier`/阶梯）、`price_cny`（`estimated` 标记）、`stock_smt`、`stock_lcsc`、`library`、`package`、`pin_count`、`score`、`reasons`；放宽匹配时给 `mismatch_reasons`。

### `audit_lcsc_bom` — BOM 体检

```jsonc
{"bom":"C1581,5,smt\nC91552,1,hand\nC17168,1,dnp","assembly":"smt","boards":100,"include_cny":true,"export_bom":true}
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `bom` | 必填 | CSV/TSV（支持 `place/mount` 列）或 `[{"lcsc":"C1581","qty":5,"place":"smt"}]` |
| `assembly` | `hand` | `smt` 时计 $3/唯一扩展库料号/单 |
| `boards` | 1 | 打板数量 |
| `include_cny` | hand 且 ≤8 行时 true | 取真实 CNY（最多 32 料号、24h 缓存；大 BOM 默认跳过以免慢，可显式 true） |
| `suggest_alternatives` | true | 基础库替代 + 净节省（省上料费 − 元件价差；封装不同标注） |
| `export_bom` | false | 输出嘉立创 BOM CSV |
| `region` | `global` | 费用口径标签（`cn` 会标注费率假设） |

输出：`summary`（含 USD/CNY 分列、`cost_table`、`dnp/hand` 统计）、`rows`（含 `place`/双价/双库存/`flags`）、`optimize`（净节省与 actions）、`bom_csv`、`skipped`（缺料号行不静默丢弃）。

## 安装

```bash
# 从 npm
dsh plugin --profile <profile> add dsh-plugin-lcsc

# 从本地目录
dsh plugin --profile <profile> add /path/to/lcsc-dsh-plugin
```

Host-only bundle，无 UI 面板；`engines.dsh >= 0.2.2-rc.1 < 0.3.0`。装完重启宿主。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: lcsc-parts
  config:
    cnRender: true             # 国内站 Chrome 渲染（关掉则只有 USD + 估算）
    chromePath: ''             # 本机 Chrome/Chromium 路径；留空则自动嗅探（见下）
    cnConcurrency: 2           # 常驻 Chrome 并发标签数 1-8（WAF 阵发，建议 ≤2）
    cnBrowserIdleTtlMs: 120000 # 空闲多久关 Chrome
    cnQueryBudgetMs: 90000     # 单次 BOM 取 CNY 时间预算；超时先返回，缓存续跑
    cnCacheTtlMs: 86400000     # JSON 缓存 24h TTL
    cnCacheMaxEntries: 800     # JSON 缓存条数上限（超量删最旧）
    usdToCnyFactor: 6.0        # 仅用于估算，不是汇率
    extendedPartFeeUsd: 3.0    # 扩展库上料费
    setupFeeUsd: 0.0           # 工程费（可选）
    stencilFeeUsd: 0.0         # 钢网费（可选）
```

### Chrome 路径：自动嗅探 + 可配置 + 失败可诊断

真实人民币价依赖本机 Chrome/Chromium。查找顺序：

1. 配置 `chromePath`（绝对路径，优先级最高）
2. 环境变量 `CHROME_BIN`
3. 自动嗅探：macOS/Linux 常见路径；Windows 按 `ProgramFiles` / `ProgramFiles(x86)` / `ProgramW6432` / `LOCALAPPDATA` 依次找 Chrome、Chromium、Edge

**找不到时会显式报错并给出修复步骤**：工具输出的 `hints` 里会写明失败原因、已尝试的路径，以及「配置 `chromePath` 或设置 `CHROME_BIN`」的具体做法。不会有"静默降级成估算"却没人知道的情况。

定位 Chrome：

```bash
where chrome                                   # Windows
ls /Applications | grep -i chrom               # macOS
which google-chrome chromium                   # Linux
```

```yaml
# 例：Windows 自定义安装位置
chromePath: 'D:\Apps\Chrome\Application\chrome.exe'
```

## 测试

```bash
node poc/validate.mjs              # 103 项离线单测（无网络/无 Chrome）
node poc/test-improvements.mjs     # 联网验收（BOM v0.6 100 片 + 人民币 golden 数据）
```

准确性参考（2026-11-11 实测）：28 个料的 BOM 数据 28/28 取到真实 CNY，手焊总价 **¥4.0791**（Recording_card 官方口径 ¥4.0793）；单料如 C1581 ¥0.0239、C7434398 ¥1.097。

## 已知问题（Known Issues）

### 1. 国内站 WAF 阵发，会成批失败

`item.szlcsc.com` 在阿里云 WAF 后面，触发后一段时间内**整批**请求都会被挑战。

- **已缓解**：单料失败自动**重试 1 次**（1.5s 退避）；`cnConcurrency` 默认已降到 **2**
- **失败不缓存，成功缓存 24h**：所以重跑只补失败项，已成功的直接命中缓存
- 工具输出会写清 `失败原因：szlcsc-waf-challenge×N`，并提示**稍后重试即可、不需要改配置**
- 若仍然频繁：把 `cnConcurrency` 降到 `1`

### 2. `product-id-not-found` 是数据缺口，重试无用

部分料号在 EasyEDA / lceda 查不到对应的国内商品 id（常见于新料、国内专属料、非零售料）。
这类只能看 USD 价，`hints` 里会明确标注，**不要**把它当成 Chrome 配置问题去反复调。

### 3. Chrome 必须装在本机

真实人民币价依赖本机 Chrome/Chromium。查找顺序：`chromePath` → `CHROME_BIN` → 自动嗅探。
找不到时 `hints` 会给出**已尝试的路径 + 修复方法**，按提示配 `chromePath` 即可，不需要改代码。

### 4. 手焊模式下出现 NOT-FOUND 可能只是国内站暂时不可用

判断条件是「嘉立创 SMT 没有 **且** 国内站查不到」。国内站被 WAF 挡住时，立创有货的料也会落到
`NOT-FOUND`。隔几分钟重跑通常就恢复；`hints` 会告诉你当时的真实原因。

### 5. 0.3.3 及更早：Chrome 适配器未初始化（0.3.4 已修）

0.3.3 的 `index.js` 漏了 `createCnAdapter` 的 import，导致 `apply()` 里创建适配器时抛
`createCnAdapter is not defined` 并被吞掉，**人民币链路整条不生效**（静默回退到旧路径）。
0.3.4 修复，并在 `validate.mjs` 增加了接线回归断言。

## 局限（无法消除，只会缓解）

1. 价格和库存是**快照**，不保证下单时一致；24h 缓存只提速，不改变这一点。
2. 人民币价依赖本机 Chrome + 立创页面结构；页面改版/WAF/无 Chrome 时只能给标注的估算，不能保证真实价。
3. 上料费不含焊点费/加急费/工程变更；「优选扩展库」分类未公开，可能高估费用。
4. `region=cn` 的人民币费率表未内置，国内 SMT 费用以官方计价页为准。
5. 替代料不验证电气/热/寿命/认证等效，封装变化需改 PCB。
6. 不做下单、不做比价大屏、不抓淘宝/1688；没有 LCSC 编号的料无法计价。
7. Chrome 进程按空闲/卸载退出；若宿主进程被强杀，可能留下一个 Chrome 残留进程（其 profile 缓存在下次启动前会先清理，不会持续膨胀）。

详细改进记录见仓库 [`docs/改进记录_0.3.0.md`](../../docs/改进记录_0.3.0.md)。

## 许可

MIT
