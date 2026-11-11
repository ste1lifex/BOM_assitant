# dsh-plugin-lcsc

> 立创商城 / 嘉立创选料与 BOM 成本体检，为 DeepSeek Harness 提供 2 个工具。
> LCSC/JLCPCB part finder and BOM cost auditor for DeepSeek Harness agents.

只暴露 **2 个工具**，避免与其他插件一起装时污染模型上下文。
当前版本 **0.3.0**（对齐 Recording_card 的《工具改进建议》，见仓库 `docs/改进记录_0.3.0.md`）。

## 安装

```bash
# 从 npm（0.3.0 发布后）
dsh plugin --profile <profile> add dsh-plugin-lcsc

# 从本地目录
dsh plugin --profile <profile> add /path/to/lcsc-dsh-plugin
```

装完重启宿主。这是 host-only bundle，不产生 UI 面板。`engines.dsh` 要求 `>=0.2.2-rc.1 <0.3.0`。
人民币价依赖本机 Chrome（无 Chrome 时自动降级为 USD 估算，不影响其他功能）。

## 两个工具

### `find_lcsc_parts` — 按需求找料

把「用料需求」变成按综合性价比排序的候选：单价（按实际采购量取档）、库存覆盖、参数匹配、基础库优先。

- **先识别型号/LCSC 编号**：`SMF5.0A`、`AO3401A`、`TP4054`、`C307331` 等直接精确查询，不再被当成数值参数解析。
- 参数需求（封装/容值/耐压/电流/精度/尺寸/引脚数）先严格过滤；0 结果时按「放宽非核心参数 → 仅封装/品类 → 最近候选」降级，并给每条候选 `mismatch_reasons`。
- 每个候选同时给 `stock_smt`、`stock_lcsc`、`price_usd`、`price_cny`、已用价格档 `used_tier`。

| 参数 | 默认 | 说明 |
|---|---|---|
| `need` | 必填 | 中文或英文：类别 + 封装 + 参数；也接受型号 / LCSC 编号 |
| `assembly` | `hand` | `hand` 手焊 / `smt` 嘉立创贴片（扩展库计上料费） |
| `quantity` / `boards` | 1 | 每板用量 / 打板数量（决定价格档与上料费摊销） |
| `sort` | `balanced` | `balanced` / `cost` / `stock` |
| `limit` | 5 | 返回条数 1–8 |
| `include_cny` | hand 时 true | 用 Chrome 取立创国内站真实人民币价；失败时给标注的估算 |
| `exclude_lcsc` | — | 排除的料号（找替代料用） |
| `base_only` | false | 只要基础库；没有时明确提示而不是静默返回扩展库 |

### `audit_lcsc_bom` — BOM 体检

CSV / TSV / JSON 行入，逐行给出价格、双库存、基础库/扩展库、**贴装方式（place）**；SMT 模式计扩展库上料费，给基础库替代与净节省，并输出批量摊销表。

| 参数 | 默认 | 说明 |
|---|---|---|
| `bom` | 必填 | CSV/TSV 文本（表头可选，中英文均可，支持 place/mount 列）或 `[{"lcsc":"C1581","qty":5,"place":"smt"}]` |
| `assembly` | `hand` | `hand` 不计上料费 / `smt` 计 $3/唯一料号/单 |
| `boards` | 1 | 打板数量 |
| `include_cny` | hand 且 ≤8 行时 true | 用 Chrome 取真实人民币价（24h 缓存，最多 32 个料号）；大 BOM 默认跳过以免过慢 |
| `suggest_alternatives` | true | 扩展库料的基础库替代 + **净节省**（省上料费 − 元件成本变化；封装不同会标「需改 PCB」） |
| `export_bom` | false | 额外输出嘉立创 BOM CSV（Comment/Designator/Footprint/LCSC Part） |
| `region` | `global` | 费用口径标签：`global`（JLCPCB 国际）/ `cn`（国内，规则以官方计价页为准，输出会标注假设） |

输出要点：

- `place`：`smt` / `hand` / `dnp`；hand/dnp 不计入 SMT 元件与上料费，DNP 单列被排除的元件价值。
- 同一 LCSC 多行：按「料号 + place」合并数量与位号；**上料费按唯一料号只计一次**，阶梯价按合并数量取档。
- `summary.cost_table`：20 / 100 / 300 / 1000 片的每片成本（含上料费、工程/钢网费）。
- `summary.components_usd` + `extended_fee_per_order_usd` + `setup/stencil`，USD 与 CNY 分列不混算。
- `optimize`：`extended_parts_before/after`、`saving_usd_per_order`、`actions`（含净节省与封装兼容性）。
- `skipped_lines` + `skipped[]`：没有 LCSC 编号的行不会被静默丢弃。

## 数据口径

| 仓库 | 用途 | 数据源 |
|---|---|---|
| 嘉立创 SMT 备料仓 | 贴片打样价格 + 库存（USD） | JLCPCB SMT 元件接口 |
| 立创国际站 lcsc.com | USD 零售阶梯价、国际仓库存 | 商品页 `__NEXT_DATA__` |
| 立创国内站 item.szlcsc.com | 人民币零售价 + 国内库存（CNY） | EasyEDA/lceda 取 productId → **Chrome 无头渲染** → `__NEXT_DATA__`，24h 磁盘缓存 |

- **USD 与 CNY 并列、从不静默换算**；有真实人民币价才标 `estimated=false`，否则 `estimated=true` 的参考估算。
- 人民币链路失败（无 Chrome / WAF / 超时）自动降级，不阻塞其他结果。
- 价格为公开接口/页面快照，下单前请复核。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: lcsc-parts
  config:
    timeoutMs: 8000
    retries: 3
    cacheTtlMs: 600000
    usdToCnyFactor: 6.0        # 参考估算系数（批量档 USD -> CNY，不是汇率）
    cnRender: true             # 国内站 Chrome 渲染
    cnCacheTtlMs: 86400000     # 24h
    cnTimeoutMs: 30000
    cnConcurrency: 2
    extendedPartFeeUsd: 3.0    # 嘉立创扩展库上料费
    setupFeeUsd: 0.0           # 工程费（可选）
    stencilFeeUsd: 0.0         # 钢网费（可选）
```

## 测试

```bash
node poc/validate.mjs              # 103 项离线单测（无需网络/Chrome）
node poc/test-improvements.mjs     # 联网验收（Recording_card BOM v0.6 + 人民币 golden 数据）
node poc/test-recording-card.mjs   # 早期集成脚本（BOM v0.5）
```

## 局限（无法消除）

1. **价格本质是美元 SMT 元件阶梯价**，不是立创商城零售价——两套体系，不换算。
2. **人民币价依赖本机 Chrome**：无 Chrome / WAF / 超时时会给标注的估算，而不是真实价。
3. **6.0 是标定系数，不是汇率**，不区分品类；可在配置里调。
4. **三个仓库三种库存**：立创国际站库存 ≠ 国内仓库存，不互相冒充。
5. **没有 LCSC 编号的料算不出价格**——插件不做自动选型猜测。
6. **价格/库存是快照**；上料费只含 $3/唯一料号/单（可配），不含焊点费/加急费；「优选扩展库」分类未公开，可能高估。
7. **替代料只做保守同类替换**（同类别、基础库、有库存、参数匹配），不做电气/热/寿命/认证等效验证；封装变化会标注需改 PCB。
8. **region=cn 的人民币费率表未内置**：国内嘉立创 SMT 费用以官方计价页为准，工具目前仍按 USD 上料费估算并显式标注。

## 许可

MIT
