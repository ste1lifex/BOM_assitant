# dsh-plugin-lcsc

> 立创商城 / 嘉立创选料与 BOM 成本体检，为 DeepSeek Harness 提供 2 个工具。
> LCSC/JLCPCB part finder and BOM cost auditor for DeepSeek Harness agents.

只暴露 **2 个工具**，避免与其他插件一起装时污染模型上下文。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add dsh-plugin-lcsc

# 从本地目录
dsh plugin --profile web add /path/to/lcsc-dsh-plugin
```

装完重启宿主（`dsh web` / 关闭重开）。这是 host-only bundle，不产生 UI 面板。
`engines.dsh` 要求 `>=0.2.2-rc.1 <0.3.0`。

## 两个工具

### `find_lcsc_parts` — 按需求找料

把「用料需求」变成按综合性价比排序的候选：单价（按实际采购量取档）、库存覆盖、参数匹配、基础库优先。

| 参数 | 默认 | 说明 |
|---|---|---|
| `need` | 必填 | 中文或英文：类别 + 封装 + 参数；也接受型号或 LCSC 编号 |
| `assembly` | `hand` | `hand` 手焊 / `smt` 嘉立创贴片（扩展库计上料费） |
| `quantity` | 1 | 每板用量 |
| `boards` | 1 | 打板数量（决定价格档与上料费摊销） |
| `sort` | `balanced` | `balanced` / `cost` / `stock` |
| `limit` | 5 | 返回条数 1–8 |
| `include_cny` | hand 时 true | 尝试取立创国内站人民币价 |
| `exclude_lcsc` | — | 排除的料号（找替代料用） |

### `audit_lcsc_bom` — BOM 体检

CSV / TSV / JSON 行入，逐行给出价格（USD 阶梯，按采购量取档）、库存、基础库/扩展库；SMT 模式下计扩展库上料费，并给扩展库料推荐基础库替代。

| 参数 | 默认 | 说明 |
|---|---|---|
| `bom` | 必填 | CSV/TSV 文本（表头可选，中英文均可）或 `[{"lcsc":"C1581","qty":5}]` |
| `assembly` | `hand` | `hand` 不计上料费 / `smt` 计 $3/唯一料号/单 |
| `boards` | 1 | 打板数量 |
| `include_cny` | false | 额外尝试人民币零售价（best effort，限 10 个料号） |
| `suggest_alternatives` | true | 为扩展库料推荐基础库替代（仅 smt） |

输出除 `rows` / `summary` 外还有：

- `summary.lines_in_bom`、`summary.skipped_lines` + `skipped[]`：**没有 LCSC 编号的行不会被静默丢弃**，逐行给出位号与名称
- 每行 `stock_source` / `price_source`：该行的价格与库存分别取自哪个仓库
- `summary.library_unknown`：查得到但不在嘉立创 SMT 库里的料

> `skipped_lines > 0` 表示总价一定偏低——缺的料没算进去。

## 数据口径

| 仓库 | 用途 | 数据源 |
|---|---|---|
| 嘉立创 SMT 备料仓 | 贴片打样价格 + 库存 | JLCPCB SMT 元件接口 |
| 立创国际站 lcsc.com | 零售阶梯价、国际仓库存 | 商品页 |
| 立创国内站 item.szlcsc.com | 人民币零售价（best effort） | EasyEDA → 商品页 |

- **USD 与 CNY 从不互相换算**：有真实人民币价才给 `unit_cny`，否则给 `unit_cny_estimate` 并标注「估算参考」。
- `assembly=smt`：价格与库存都取嘉立创 SMT 备料仓。
- `assembly=hand`：价格取立创零售阶梯价，库存取可验证来源，行内标注来源。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: lcsc-parts
  config:
    timeoutMs: 8000
    retries: 3
    cacheTtlMs: 600000
    usdToCnyFactor: 6.0
```

## 局限（无法消除）

1. **价格本质是美元 SMT 元件阶梯价**，不是立创商城零售价——两套体系，不换算。
2. **人民币价链路脆弱**：国内站经 EasyEDA 跳转，可能整体 0 覆盖，此时人民币只有估算。
3. **6.0 是标定系数，不是汇率**，不区分品类；可在配置里调。
4. **三个仓库三种库存**：立创国际站的库存不等于国内仓库存，不能互相冒充。
5. **没有 LCSC 编号的料算不出价格**——插件不做自动选型猜测。
6. **价格/库存是快照**；上料费只含 $3/唯一料号/单，不含工程费、钢网费、焊点费、加急费；「优选扩展库」分类未公开，可能高估。
7. **替代料只做保守同类替换**（同类别、同封装、基础库、有库存），不做电气/热/寿命/认证等效验证。

## 许可

MIT
