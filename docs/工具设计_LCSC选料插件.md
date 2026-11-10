# LCSC 选料插件：工具设计（收敛版）

> 设计日期 2026-11-10｜目标：**工具尽量少**（用户会装多个插件，工具多会污染模型上下文），只做别人没做的那一段。
> 核心场景：本地 agent 有「用料需求」（容值/耐压/尺寸/封装/电流等）→ 插件找到**符合条件、性价比最优、库存靠谱、尽量基础库**的料。

---

## 0. 一页结论

| 阶段 | 暴露给模型的工具 | 数量 |
|---|---|---|
| **v1（已实现）** | `find_lcsc_parts` —— 需求 → 候选料（已排序） | 2 个 |
| **v1（已实现）** | `audit_lcsc_bom` —— 已有 BOM → 价格/库存/库类型/上料费体检 | 同上 |
| 明确不做 | 通用关键词搜索、KiCad/EasyEDA 库转换、BOM/CPL 导出、库存管理、淘宝/1688、下单购物车 | — |

理由：两个工具职责清晰（选料 vs 体检 BOM），共用同一数据引擎；不再增加第三个，避免污染模型上下文。

> **2026-11-10 已确认并实现**：默认 `assembly=hand`（手焊，大多数 DIY 用户）；两个工具一起发；默认返回 5 条候选；已用 Recording_card 的 `data/bom_v0.5.csv` 联网实测通过。

---

## 1. 核心工具：`find_lcsc_parts`

### 1.1 工具描述（给模型看的 description）

> Find electronic components on LCSC/JLCPCB that match a requirement (package, capacitance, voltage rating, current, size, etc.). Returns 3-8 candidates ranked by real-world cost-effectiveness: unit price at your order quantity, stock availability, extended-library feeder fee, and basic-library preference. Choose assembly='smt' when the board will be assembled by JLCPCB (library type matters, extended parts cost $3 each); choose assembly='hand' when you will buy parts and hand-solder (ignore library type, prefer hand-solderable, use LCSC retail price). Use `need` like "0402 100nF 50V X7R capacitor" or "3.3V LDO SOT-23-5 500mA" or a part number like "C1581"/"TP4054".

### 1.2 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `need` | string | ✅ | — | 自然语言需求：类别 + 封装 + 关键参数，或型号 / LCSC 编号。越具体越好（容值、耐压、精度、电流、尺寸、材质） |
| `assembly` | enum `smt` / `hand` | ❌ | `hand` | **是否考虑库类型由它决定**：`smt`=嘉立创贴片（库类型重要、扩展库计入 $3/料号）；`hand`=自己买料手焊（库类型不重要、优先易手焊、用立创零售 CNY 价） |
| `quantity` | integer | ❌ | 1 | 每块板用量 |
| `boards` | integer | ❌ | 1 | 打板数量（决定扩展库上料费摊销与阶梯价档位） |
| `sort` | enum `balanced` / `cost` / `stock` | ❌ | `balanced` | 排序偏好：综合性价比 / 只看成本 / 库存优先 |
| `limit` | integer | ❌ | 5 | 返回条数，1-8（控制上下文） |
| `exclude_lcsc` | string[] | ❌ | — | 排除的 LCSC 号（找替代料时用） |

> 参数只有 6 个，必填 1 个；`assembly` 一个开关同时解决「要不要考虑库」和「用哪套价格口径」。

### 1.3 输出（紧凑 JSON，示例为真实数据）

```json
{
  "need": "0402 100nF 50V X7R ±10%",
  "assembly": "smt", "quantity": 5, "boards": 5, "order_qty": 25,
  "currency": "USD", "source": ["JLCPCB-SMT", "LCSC-global"], "fetched_at": "2026-11-10T18:20:00+08:00",
  "candidates": [
    {
      "lcsc": "C307331", "model": "CL05B104KB54PNC", "package": "0402",
      "specs": {"Capacitance": "100nF", "Voltage Rating": "50V", "Tolerance": "±10%", "Temperature": "X7R"},
      "library": "base", "preferred": null,
      "stock": 21402583,
      "unit_price": 0.0089, "unit_effective": 0.0089,
      "fee_per_board": 0.0, "min_qty": 1,
      "score": 0.96, "reasons": ["基础库，无上料费", "库存 2140 万", "参数完全匹配"],
      "url": "https://www.lcsc.com/product-detail/C307331.html"
    },
    {
      "lcsc": "C1581", "model": "0402F104M500NT", "package": "0402",
      "specs": {"Capacitance": "100nF", "Voltage Rating": "50V", "Tolerance": "±20%"},
      "library": "expand", "preferred": null,
      "stock": 355642,
      "unit_price": 0.0071, "unit_effective": 0.1271,
      "fee_per_board": 0.60, "min_qty": 1,
      "score": 0.41, "reasons": ["扩展库：+$3/料号，5 片订单折合每片 $0.60", "单价更低但被上料费抵消"],
      "url": "https://www.lcsc.com/product-detail/C1581.html"
    }
  ],
  "notes": ["价格为公开接口快照，下单前请复核", "优选扩展库分类接口未暴露，以嘉立创 SMT 下单页为准"]
}
```

- `unit_effective` = 摊上料费后的实际单价：`unit_price + (library==expand && assembly==smt ? 3/(boards*quantity) : 0)`
- `fee_per_board` = 该料号每片板分摊的上料费：`library==expand && smt ? 3/boards : 0`
- `preferred`：接口暂不提供，固定 null + notes 说明（v1 用 base/expand 近似）

### 1.4 内部流程（一次调用 ≈ 1-2 次 HTTP）

1. **候选召回**：JLC SMT 接口关键词搜索 `keyword=need`，`pageSize=100`；`assembly=smt` 时可先按 `componentLibraryType=base` 搜一遍，不足再搜全部（保证基础库候选不被淹没）；最多取 2 页 ≈ 200 条。
2. **硬过滤**：
   - 参数不满足直接剔除（容值/耐压/精度/电流/温度/封装/尺寸，按 `attributes` + `componentSpecificationEn` 匹配）；
   - 库存 = 0 剔除（或标注不可用）；
   - `assembly=hand` 时剔除明显不适合手焊的（细间距 BGA/QFN 等）并优先 THT/大封装。
3. **计价**：
   - `smt`：订单量 `order_qty = boards × quantity`，取覆盖该量的最低阶梯价（USD），扩展库加上料费摊销；
   - `hand`：立创商城零售价（CNY，best-effort；国内站被 WAF 拦时降级为 JLC USD 价并标注 `cny_price=null`），不计上料费。
4. **打分排序**（见 §2）。
5. **输出前 N**，并附 `notes`（数据时效、币种、优选库说明）。

缓存：同一 `need` 10 分钟内复用（进程内存 + 可选磁盘），避免批量选料时反复打接口。

---

## 2. 排序算法（`balanced` 默认）

```
cost_score   = 1 - normalize(unit_effective)         # 对候选集内做 min-max 归一
stock_score  = clamp(log10(stock+1)/7, 0, 1)         # 库存量级分
cover_score  = stock >= max(order_qty*1.5, 10) ? 1 : stock/需要量
lib_score    = assembly==smt ? (base?1 : preferred?0.8 : 0) : 0.5
param_score  = 参数完全匹配 1 / 部分匹配 按命中比例

balanced: 0.40*cost_score + 0.25*stock_score + 0.15*cover_score + 0.10*lib_score + 0.10*param_score
cost:     0.75*cost_score + 0.10*stock_score + 0.15*param_score
stock:    0.20*cost_score + 0.55*stock_score + 0.25*param_score
```

- 扩展库的代价已经体现在 `unit_effective` 里，`lib_score` 只做 tie-breaker，避免双重惩罚；
- 每个候选输出 `reasons`（为什么推荐/为什么贵），便于 agent 直接向用户解释，无需二次推理。
- 库存为 0 → 剔除；库存不足订单量 → 保留但 `score` 扣减并标注。
- 最小起订量 > 订单量 → 标注，并按 `max(order_qty, min_qty)` 计算实际采购成本。

---

## 3. `assembly` 两套语义（“要不要考虑库”的开关）

| 维度 | `smt`（嘉立创贴片） | `hand`（买料手焊） |
|---|---|---|
| 库类型是否参与 | ✅ 基础库优先；扩展库按 $3/料号摊销 | ❌ 不考虑 |
| 价格口径 | 嘉立创 SMT 阶梯价（**USD**） | 立创商城零售价（**CNY**，best-effort） |
| 库存口径 | JLC SMT 库存 | 立创国内库存（取不到则退回 SMT 库存并标注） |
| 排序偏好 | 综合单价 + 上料费摊销 | 单价 + 库存 + 易手焊（THT/大封装优先） |
| 典型用户 | 嘉立创 SMT 打样 | 自己烙铁焊 / 洞洞板 |

> 注：嘉立创 SMT 的「扩展库」= Extended，$3/料号；「基础库/优选扩展库」免上料费。优选扩展库分类接口取不到，v1 用 base/expand 近似并在 notes 里提示。

---

## 4. 真实数据示例（证明可行）

### 例 1：0402 100nF 50V 去耦电容（smt，5 片板，每板 5 个）

| LCSC | 型号 | 库类型 | 单价 | 摊上料费后 | 结论 |
|---|---|---|---|---|---|
| **C307331** | CL05B104KB54PNC | base | $0.0089 | **$0.0089** | ✅ 推荐 |
| C1581 | 0402F104M500NT | expand | $0.0071 | $0.1271 | ❌ 单价更低但每片多摊 $0.60 上料费 |

整单对比（5 片 × 5 个 = 25 个）：C1581 = $0.18 + $3 上料费 ≈ $3.18；C307331 = $0.22 → **省约 $2.96**。

### 例 2：3.3V LDO SOT-23-5（500mA 需求）

- 基础库候选只有 3 个（XC6206 C5446 / AMS1117 C6186 / HT7533 C14289），其中 SOT-23-5 且 ≥500mA 的可能没有 → 工具应如实返回「无基础库满足 500mA，以下是扩展库候选 + 可降规提示」，而不是硬凑。
- 对照：Recording_card 用的 ME6211 C82942 是扩展库；若 250mA 够用，XC6206 C5446（base）可省 $3 上料费。

### 例 3：整板 BOM 视角（v1.1 的 `audit_lcsc_bom`）

Recording_card BOM v0.5：28 个唯一料号中 **16 个扩展库** → 单次 SMT 打样上料费 16×$3=$48，而元件成本约 $1.36。这类「上料费体检」正是 v1.1 第二个工具要解决的，v1 先不做。

---

## 5. 数据源与已知限制

| 数据源 | 用途 | 限制 |
|---|---|---|
| JLC SMT 元件库接口（POST，无需登录） | 主搜索：关键词、`componentLibraryType`、库存、USD 阶梯价、`attributes` 参数表、封装、替代编号 | 类目级宽泛词排序一般；`preferred` 标记取不到；中文品类词支持差 |
| lcsc.com 商品页 `__NEXT_DATA__` | 精确 USD 阶梯价/库存复核 | 国内专属料 `dataIsNull` |
| item.szlcsc.com（国内站） | `hand` 模式的 CNY 零售价/库存 | 阿里云 WAF 间歇拦截，只能 best-effort + 降级 |
| 缓存 | 10 分钟 TTL，减少接口压力 | — |

**CNY 参考估算**：只有 USD 时（手焊模式 CNY 取不到），输出 `cny_estimate = 该料最高采购量档 USD × usdToCnyFactor`（默认 6.0）。该系数来自 Recording_card 实测标定：20 个已知人民币价的料，`CNY / 最高量档USD` 中位数 6.07，估算中位误差 1.6%（首档 USD 的比值中位数约 3.1，**不能直接对首档乘 6.0**）。估算仅作参考，USD 仍是实际参考价；系数可通过插件 config 调整。

**接口实测**：`pageSize=100` 可用；属性表含 `Capacitance / Voltage Rating / Tolerance / Temperature / Output Voltage / Output Current / PSRR / Operating Temperature` 等英文名，可本地过滤。中文需求由模型转成英文/标准值（如“100nF 50V 0402”）即可。

---

## 6. 明确不做（别人做过的/不值得做的）

| 不做 | 原因 |
|---|---|
| 通用关键词搜索工具 | `dsh-pcb-parts-search`（芯灵 eda.cn）已做；我们的 `find_lcsc_parts` 只做「需求→排序推荐」 |
| KiCad/EasyEDA 符号封装库转换 | `easyeda2kicad`、`kicad-lcsc-manager` 等已成熟 |
| BOM/CPL 导出、制造文件 | `kicad-jlcpcb-tools`、`Fabrication-Toolkit` 已做 |
| 库存/物料管理系统 | InvenTree、Part-DB 已做 |
| 淘宝/1688 网络抓取 | 实测登录+签名+滑块+robots 禁止，不可行也不合规 |
| 下单/购物车/支付 | 不在定位内，链接跳转即可 |

---

## 7. 实施顺序

1. **v1（约 2-3 天）**：只发 `find_lcsc_parts`，复用现有 PoC 数据层（搜索/属性解析/计价/缓存），删除 `lcsc_search`、`lcsc_part`、`bom_check` 三个旧工具 → 收敛为 1 个；
2. 实测验收：用 Recording_card 的 28 个料逐条构造 `need`，检查 ① 参数匹配正确 ② 基础库候选能排到前面 ③ 无基础库时如实降级；用 `node poc/validate.mjs --offline` 保证回归；
3. **v1.1（按需）**：加 `audit_lcsc_bom`（BOM 体检 + 每个扩展库料给 1 个 base 替代候选）；
4. 发布：MIT，`awesome-dsh-plugin` 提 PR（市场自动收录），README 附数据来源/币种/免责声明。

---

## 8. 已确认的实现决策（2026-11-10）

- [x] 两个工具一起发：`find_lcsc_parts` + `audit_lcsc_bom`
- [x] 默认 `assembly=hand`（手焊），SMT 为显式可选
- [x] 默认输出 5 条候选（1-8 可调）
- [x] 实现位置：`poc/lcsc-dsh-plugin/`（数据层 `data.js` + 工具层 `index.js`）
- [x] 测试：`node poc/validate.mjs` 离线 60 项全过；`node poc/test-recording-card.mjs` 用 Recording_card 真实 BOM 联网实测通过
- [x] DSH 端到端：`plugin_manager install_bundle` 安装到当前 desktop profile（application: applied），两个工具已实际调用成功（含 BOM 体检、上料费、C1581→C307331 基础库替代）

### 实测结果摘要（Recording_card BOM v0.5，5 片板）

- 32 行 / 28 个唯一 LCSC 料：基础库 12、扩展库 16；全部有库存
- 嘉立创 SMT：元件 USD 7.07 + 扩展库上料费 16×$3 = **USD 48**，合计 **USD 55.07**（每片约 USD 11，打样费主导）
- 替代料建议已验证可行：C1581（扩展库 100nF）→ **C307331（基础库）**，每换掉 1 个扩展库料每单省 $3
- 手焊模式：无上料费；部分扩展库料（如 0402 都换基础库）可进一步降低采购复杂度
- CNY 价：实测被国内站 WAF 限流，工具自动降级为 USD 参考 + **批量档 USD×6.0 的参考估算**（`cny_estimate`）；20 个已核实价料验证该系数中位误差约 1.6%（注意乘的是最高量档，不是首档）
