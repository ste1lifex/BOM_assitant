#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针 4：LCSC 全球站 www.lcsc.com（美元口径交叉验证）。

URL: https://www.lcsc.com/product-detail/{C编号}.html  （直接按 C 号即可，无需 productId）
用途: 拿美元阶梯价（webData.productPriceList）、库存口径、参数，用于判定
      嘉立创 SMT 接口 componentPrices 的币种（美元 or 人民币）。

用法:
    python3 probe_global.py codes      # 批量（含国内料 dataIsNull 形态）
    python3 probe_global.py search     # 全球站搜索接口可行性（结论：不适合 MVP）
"""

import json
import sys

import common as C

HEADERS = {"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
           "Accept-Language": "en-US,en;q=0.9",
           "Referer": "https://www.lcsc.com/"}

CODES = ["C668215", "C1581", "C16581", "C7434398", "C231329", "C15850",
         "C52923", "C25744", "C318884", "C709357", "C5373222", "C19330",
         "C70110", "C725790", "C8678", "C22383473", "C91552", "C82942",
         "C2687116", "C193402", "C17168", "C1002", "C351410", "C605432",
         "C51721", "C999999999"]


def fetch(code):
    url = f"https://www.lcsc.com/product-detail/{code}.html"
    st, body, rh = C.request_with_retry(url, headers=HEADERS,
                                        raw_save=f"global_{code}.html")
    html = body.decode("utf-8", "ignore") if isinstance(body, bytes) else str(body)
    return st, html


def extract(html):
    d = C.parse_next_data(html)
    if not d:
        return None, None
    pp = C.dig(d, "props", "pageProps", default={}) or {}
    w = pp.get("webData")
    if not w:
        return d, {"dataIsNull": True, "keys": sorted(pp.keys())}
    prices = []
    for p in w.get("productPriceList") or []:
        prices.append({"ladder": p.get("ladder"),
                       "productPrice": p.get("productPrice"),
                       "usdPrice": p.get("usdPrice"),
                       "currencySymbol": p.get("currencySymbol")})
    flat = {
        "dataIsNull": False,
        "productId": w.get("productId"),
        "productCode": w.get("productCode"),
        "productModel": w.get("productModel"),
        "brandNameEn": w.get("brandNameEn"),
        "currencySymbol": w.get("currencySymbol"),
        "currencyType": w.get("currencyType"),
        "minBuyNumber": w.get("minBuyNumber"),
        "productArrange": w.get("productArrange"),
        "productUnit": w.get("productUnit"),
        "stockNumber": w.get("stockNumber"),
        "domesticStockVO": w.get("domesticStockVO"),
        "overseasStockVO": w.get("overseasStockVO"),
        "smtLabel": w.get("smtLabel"),
        "isReel": w.get("isReel"),
        "reelPrice": w.get("reelPrice"),
        "encapStandard": w.get("encapStandard"),
        "prices": prices,
        "n_params": len(w.get("paramVOList") or []),
        "param_sample": (w.get("paramVOList") or [])[:3],
    }
    return d, flat


def run_codes():
    out = {}
    for code in CODES:
        st, html = fetch(code)
        d, flat = extract(html)
        if d is None:
            out[code] = {"http": st, "size": len(html), "no_next_data": True,
                         "waf": "aliyun_waf" in html}
            print(f"{code}: FAIL http={st} no NEXT_DATA")
            continue
        out[code] = flat
        if flat.get("dataIsNull"):
            print(f"{code}: dataIsNull=True（国际站无此料）")
        else:
            p = flat["prices"]
            print(f"{code}: USD {p[0]['productPrice'] if p else None}@{p[0]['ladder'] if p else '-'}"
                  f" ~ {p[-1]['productPrice'] if p else None}@{p[-1]['ladder'] if p else '-'}"
                  f" cur={flat['currencySymbol']} stock={flat['stockNumber']} "
                  f"minBuy={flat['minBuyNumber']} n_prices={len(p)}")
    C.save_out("global_codes.json", out)


def run_search():
    """全球站搜索：wmsc 接口。记录失败形态，判断是否值得为 MVP 接入。"""
    out = {}
    url = "https://wmsc.lcsc.com/ftps/wm/search/v3/global"
    payload = {"keyword": "TP4054"}
    st, body, rh = C.request_with_retry(url, method="POST", payload=payload,
                                        headers={"Origin": "https://www.lcsc.com",
                                                 "Referer": "https://www.lcsc.com/"},
                                        raw_save="global_search_try1.json")
    txt = body.decode("utf-8", "ignore") if isinstance(body, bytes) else str(body)
    out["plain_keyword"] = {"http": st, "body": txt[:500]}
    print("plain:", st, txt[:300])
    # 参考前端字段名重试（未签名）
    payload2 = {"globalKeyword": "TP4054", "currentPage": 1, "pageSize": 10,
                "s_z": 1}
    st2, body2, _ = C.request_with_retry(url, method="POST", payload=payload2,
                                         headers={"Origin": "https://www.lcsc.com",
                                                  "Referer": "https://www.lcsc.com/"},
                                         raw_save="global_search_try2.json")
    txt2 = body2.decode("utf-8", "ignore") if isinstance(body2, bytes) else str(body2)
    out["globalKeyword"] = {"http": st2, "body": txt2[:500]}
    print("globalKeyword:", st2, txt2[:300])
    C.save_out("global_search.json", out)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "codes"
    {"codes": run_codes, "search": run_search}[cmd]()
    print(f"[stats] {C.stats()}")
