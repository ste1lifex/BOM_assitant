#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针 1：嘉立创 SMT 元件库接口（jlcpcb.com）。

接口: POST https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList
用途: 按 C 编号/型号/关键词搜索候选料，返回 库存 / 价格阶梯 / 分类 / 链接。
关键问题: componentPrices、buyComponentPrices 的币种；分页上限；C99 内部料号规则。

用法:
    python3 probe_jlc.py codes          # BOM 料号批量取字段（默认）
    python3 probe_jlc.py keywords       # 关键词搜索质量（中文/型号/编号/品类）
    python3 probe_jlc.py paging         # total / pageSize 上限 / 翻页
    python3 probe_jlc.py c99            # 内部装配料号 C99xxxx
    python3 probe_jlc.py fields         # 单个料号完整字段清单
    python3 probe_jlc.py params         # 请求参数边界（缺参/无效值）
    python3 probe_jlc.py stock          # 库存口径相关字段
所有原始响应落 /tmp/lcsc_probe_raw/，精简结果落 /tmp/lcsc_probe_out/jlc_*.json
"""

import json
import sys

import common as C

JLC_URL = ("https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/"
           "smtGood/selectSmtComponentList")
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://jlcpcb.com",
    "Referer": "https://jlcpcb.com/",
}

# Recording_card BOM v0.5 主料 + 对比料（C 编号）
BOM_CODES = [
    "C7434398", "C668215", "C16581", "C1581", "C15850", "C52923", "C25744",
    "C11702", "C25905", "C318884", "C2286", "C709357", "C22383473",
    "C2905009", "C91552", "C8678", "C347476", "C82942", "C2687116",
    "C193402", "C5373222", "C19330", "C70110", "C231329", "C405945",
    "C56379557", "C77020", "C25941", "C60489", "C106235", "C21376",
    "C84263", "C25882", "C25900", "C114765", "C25741", "C25076", "C17168",
    "C2929994", "C1002", "C2836286", "C351410", "C351449", "C19267416",
    "C709358", "C2763630", "C605432", "C7519", "C169426", "C13762",
    "C284108", "C725790", "C51721", "C5373222", "C22383473",
]


def call(payload, tag):
    status, body, _ = C.request_with_retry(
        JLC_URL, method="POST", payload=payload, headers=HEADERS,
        raw_save=f"jlc_{tag}.json")
    try:
        return status, json.loads(body.decode("utf-8", "ignore"))
    except Exception:  # noqa: BLE001
        return status, {"_raw": body[:500].decode("utf-8", "ignore")}


def slim(item):
    """精简单条结果，保留跨源比对所需字段。"""
    keys = ["componentCode", "componentModelEn", "componentBrandEn",
            "componentLibraryType", "componentSource", "componentTypeEn",
            "erpComponentName", "componentName", "describe",
            "stockCount", "canPresaleNumber", "minPurchaseNum",
            "preMinPurchaseNum", "leastPatchNumber", "lossNumber",
            "encapsulationNumber", "componentPrices", "buyComponentPrices",
            "initialPrice", "shopCostPrice", "fullReelPrice",
            "lcscGoodsUrl", "urlSuffix", "componentId",
            "isBuyComponent", "noBuyReason", "componentProductType",
            "shopShowPriceFlag", "shopShowForeignPriceFlag",
            "shopRealPriceFlag", "rohsFlag", "assemblyComponentFlag",
            "componentAlternativesCode", "firstSortName", "secondSortName",
            "componentSpecificationEn"]
    return {k: item.get(k) for k in keys if k in item}


def page_info(d):
    info = C.dig(d, "data", "componentPageInfo", default={}) or {}
    return {"total": info.get("total"), "list": info.get("list") or [],
            "pageSize": info.get("pageSize"), "currentPage": info.get("currentPage")}


def run_codes():
    out, missing = {}, []
    for code in BOM_CODES:
        st, d = call({"keyword": code, "currentPage": 1, "pageSize": 10}, f"code_{code}")
        info = page_info(d) if isinstance(d, dict) else {"list": []}
        match = None
        for it in info["list"]:
            if (it.get("componentCode") or "").upper() == code:
                match = it
                break
        if match:
            out[code] = slim(match)
        else:
            missing.append({"code": code, "http": st,
                            "total": info.get("total"),
                            "codes": [i.get("componentCode") for i in info["list"]][:5]})
        print(f"{code}: {'OK' if match else 'MISS'} "
              f"price1={C.dig(match or {}, 'componentPrices', 0, 'productPrice')} "
              f"shopCost={C.dig(match or {}, 'shopCostPrice')} "
              f"stock={C.dig(match or {}, 'stockCount')} "
              f"lib={C.dig(match or {}, 'componentLibraryType')}")
    C.save_out("jlc_codes.json", {"items": out, "missing": missing})
    print("\nsaved /tmp/lcsc_probe_out/jlc_codes.json", len(out), "items,", len(missing), "missing")
    return out


def run_keywords():
    tests = [
        "TP4054", "TP4056", "AD142A4", "C668215", "C1581", "0402WGF1002TCE",
        "100nF 0402", "100nF", "0.1uF", "10uF 0805", "锂电充电芯片",
        "充电芯片", "电池管理", "microSD 卡座", "TF卡座", "type-c 16p",
        "按键开关", "电阻 10k 0402", "LMA2718B381", "不存在型号XYZ123",
        "", "   ", "C99", "C9900", "C9900001",
    ]
    out = {}
    for kw in tests:
        st, d = call({"keyword": kw, "currentPage": 1, "pageSize": 10},
                     "kw_" + (kw.strip() or "EMPTY"))
        info = page_info(d) if isinstance(d, dict) else {"total": None, "list": []}
        lst = info["list"]
        out[kw] = {
            "http": st, "total": info.get("total"), "n": len(lst),
            "codes": [(i.get("componentCode"), i.get("componentModelEn"))
                      for i in lst[:6]],
            "libs": sorted({i.get("componentLibraryType") for i in lst}),
            "srcs": sorted({i.get("componentSource") for i in lst}),
        }
        print(f"kw={kw!r:28} total={info.get('total')} n={len(lst)} "
              f"first={out[kw]['codes'][:3]} libs={out[kw]['libs']}")
    C.save_out("jlc_keywords.json", out)


def run_paging():
    out = {}
    # 用宽关键词 "0402" 观察 total 与翻页；再测 pageSize 边界
    st, d = call({"keyword": "0402", "currentPage": 1, "pageSize": 20}, "pg_base")
    info = page_info(d)
    out["base_0402"] = {"total": info["total"], "pageSize": info["pageSize"],
                        "currentPage": info["currentPage"], "n": len(info["list"])}
    print("base 0402:", out["base_0402"])
    sizes = [0, 1, 5, 10, 20, 50, 100, 200, 500, 1000]
    for ps in sizes:
        st, d = call({"keyword": "0402", "currentPage": 1, "pageSize": ps},
                     f"pg_size_{ps}")
        info = page_info(d) if isinstance(d, dict) else {}
        n = len(info.get("list") or [])
        out[f"pageSize={ps}"] = {"http": st, "total": info.get("total"),
                                 "returned": n,
                                 "echoPageSize": info.get("pageSize"),
                                 "code": (d or {}).get("code"),
                                 "msg": (d or {}).get("msg")}
        print(f"pageSize={ps:5d} http={st} returned={n} total={info.get('total')} "
              f"echo={info.get('pageSize')}")
    # 翻页一致性：page 1..5 的编号
    pages = {}
    for pg in range(1, 6):
        st, d = call({"keyword": "0402", "currentPage": pg, "pageSize": 20},
                     f"pg_{pg}")
        info = page_info(d) if isinstance(d, dict) else {}
        codes = [i.get("componentCode") for i in (info.get("list") or [])]
        pages[pg] = codes
        print(f"page={pg} n={len(codes)} first={codes[:3]}")
    out["pages_0402"] = pages
    # 越界页 / 非法页码
    for pg in [0, -1, 99999]:
        st, d = call({"keyword": "0402", "currentPage": pg, "pageSize": 20},
                     f"pg_bad_{pg}")
        info = page_info(d) if isinstance(d, dict) else {}
        out[f"page={pg}"] = {"http": st, "total": info.get("total"),
                             "returned": len(info.get("list") or []),
                             "code": (d or {}).get("code"), "msg": (d or {}).get("msg")}
        print(f"page={pg} http={st} returned={out[f'page={pg}']['returned']} "
              f"code={(d or {}).get('code')} msg={(d or {}).get('msg')}")
    C.save_out("jlc_paging.json", out)


def run_c99():
    """C99xxxxxxx 是嘉立创 SMT 内部装配料号（BOM 里由 JLC 系统生成）。"""
    out = {}
    for kw in ["C9900", "C990000001", "C99", "C9900001234"]:
        st, d = call({"keyword": kw, "currentPage": 1, "pageSize": 20},
                     "c99_" + kw)
        info = page_info(d) if isinstance(d, dict) else {"list": []}
        codes = [i.get("componentCode") for i in info["list"]]
        out[kw] = {"http": st, "total": info.get("total"), "codes": codes[:10],
                   "detail": [slim(i) for i in info["list"][:2]]}
        print(f"kw={kw}: total={info.get('total')} codes={codes[:6]}")
    # 宽关键词里真实出现的 C99 形态
    st, d = call({"keyword": "连接器", "currentPage": 1, "pageSize": 100},
                 "c99_wide")
    info = page_info(d)
    c99 = [i.get("componentCode") for i in info["list"]
           if str(i.get("componentCode", "")).startswith("C99")]
    out["wide_连接器_c99_forms"] = c99[:20]
    out["wide_连接器_total"] = info.get("total")
    print("连接器 100 条中 C99 形态:", c99[:10], "total=", info.get("total"))
    C.save_out("jlc_c99.json", out)


def run_fields():
    st, d = call({"keyword": "C668215", "currentPage": 1, "pageSize": 1},
                 "fields_C668215")
    item = C.dig(d, "data", "componentPageInfo", "list", 0, default={}) or {}
    C.save_out("jlc_fields_C668215.json", {"top": d, "item": item})
    print("http", st, "response top keys:", list(d.keys()))
    print("data keys:", list((d.get("data") or {}).keys()))
    print("item fields:", len(item))
    for k in sorted(item.keys()):
        v = item[k]
        s = json.dumps(v, ensure_ascii=False)
        if len(s) > 120:
            s = s[:120] + "..."
        print(f"  {k:32} = {s}")
    print("\nsaved /tmp/lcsc_probe_out/jlc_fields_C668215.json")


def run_params():
    out = {}
    cases = {
        "无 payload": None,
        "空对象": {},
        "仅 keyword": {"keyword": "TP4054"},
        "仅 currentPage": {"currentPage": 1},
        "keyword+page": {"keyword": "TP4054", "currentPage": 1},
        "pageSize 字符串": {"keyword": "TP4054", "currentPage": 1, "pageSize": "20"},
        "pageSize null": {"keyword": "TP4054", "currentPage": 1, "pageSize": None},
        "多余字段": {"keyword": "TP4054", "currentPage": 1, "pageSize": 5,
                 "componentLibraryType": "base", "sortBy": "price"},
        "componentLibraryType=base": {"keyword": "0402", "currentPage": 1,
                                      "pageSize": 10,
                                      "componentLibraryType": "base"},
        "componentLibraryType=expand": {"keyword": "0402", "currentPage": 1,
                                        "pageSize": 10,
                                        "componentLibraryType": "expand"},
    }
    for name, payload in cases.items():
        tag = "param_" + str(abs(hash(name)) % 100000)
        if payload is None:
            st, body, _ = C.request_with_retry(JLC_URL, method="POST", payload=None,
                                               headers={**HEADERS}, raw_save=tag + ".json")
            d = {"_raw": body[:300].decode("utf-8", "ignore")}
        else:
            st, d = call(payload, tag)
        info = page_info(d) if isinstance(d, dict) else {}
        out[name] = {"http": st, "code": (d or {}).get("code"),
                     "msg": (d or {}).get("msg"),
                     "total": info.get("total"),
                     "n": len(info.get("list") or []),
                     "codes": [i.get("componentCode") for i in (info.get("list") or [])][:5]}
        print(f"{name:26} http={st} code={(d or {}).get('code')} "
              f"total={info.get('total')} n={out[name]['n']} "
              f"codes={out[name]['codes'][:3]}")
    C.save_out("jlc_params.json", out)


def run_stock():
    """库存口径：stockCount / canPresaleNumber / validStockNumber 等。"""
    out = {}
    for code in ["C7434398", "C668215", "C1581", "C22383473", "C5373222",
                 "C70110", "C231329"]:
        st, d = call({"keyword": code, "currentPage": 1, "pageSize": 5},
                     "stock_" + code)
        info = page_info(d) if isinstance(d, dict) else {"list": []}
        it = next((i for i in info["list"]
                   if (i.get("componentCode") or "").upper() == code), {})
        out[code] = {"stockCount": it.get("stockCount"),
                     "canPresaleNumber": it.get("canPresaleNumber"),
                     "minPurchaseNum": it.get("minPurchaseNum"),
                     "leastPatchNumber": it.get("leastPatchNumber"),
                     "lossNumber": it.get("lossNumber"),
                     "encapsulationNumber": it.get("encapsulationNumber"),
                     "componentLibraryType": it.get("componentLibraryType"),
                     "isBuyComponent": it.get("isBuyComponent"),
                     "noBuyReason": it.get("noBuyReason")}
        print(f"{code}: {json.dumps(out[code], ensure_ascii=False)}")
    C.save_out("jlc_stock.json", out)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "codes"
    fn = {"codes": run_codes, "keywords": run_keywords, "paging": run_paging,
          "c99": run_c99, "fields": run_fields, "params": run_params,
          "stock": run_stock}[cmd]
    t0 = __import__("time").time()
    fn()
    print(f"\n[stats] {C.stats()} elapsed={__import__('time').time()-t0:.1f}s")
