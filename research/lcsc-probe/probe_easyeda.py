#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针 2：EasyEDA 元件接口。

接口: GET https://easyeda.com/api/products/{LCSC编号}/components
用途: 拿 result.lcsc(.id/.price/.stock)、result.szlcsc(.id/.price/.stock)、封装。
关键问题: lcsc.price 与 szlcsc.price 的币种/口径、id 映射是否可靠、失败形态。

用法:
    python3 probe_easyeda.py codes     # BOM 料号批量
    python3 probe_easyeda.py invalid   # 不存在/非法编号失败形态
    python3 probe_easyeda.py mapping   # 对照 JLC componentId，验证 pid 映射
"""

import json
import sys

import common as C

EDA_URL = "https://easyeda.com/api/products/{code}/components"
HEADERS = {"Accept": "application/json, text/plain, */*",
           "Referer": "https://easyeda.com/"}

BOM_CODES = [
    "C7434398", "C668215", "C16581", "C1581", "C15850", "C52923", "C25744",
    "C11702", "C25905", "C318884", "C2286", "C709357", "C22383473",
    "C2905009", "C91552", "C8678", "C347476", "C82942", "C2687116",
    "C193402", "C5373222", "C19330", "C70110", "C231329", "C405945",
    "C56379557", "C77020", "C25941", "C60489", "C106235", "C21376",
    "C84263", "C25882", "C25900", "C114765", "C25741", "C25076", "C17168",
    "C2929994", "C1002", "C2836286", "C351410", "C351449", "C19267416",
    "C709358", "C2763630", "C605432", "C7519", "C169426", "C13762",
    "C284108", "C725790", "C51721",
]


def get_eda(code):
    url = EDA_URL.format(code=code)
    st, body, _ = C.request_with_retry(url, headers=HEADERS,
                                       raw_save=f"eda_{code}.json")
    try:
        return st, json.loads(body.decode("utf-8", "ignore"))
    except Exception:  # noqa: BLE001
        return st, {"_raw": body[:400].decode("utf-8", "ignore")}


def slim(code, d):
    r = (d or {}).get("result") or {}
    lc = r.get("lcsc") or {}
    sz = r.get("szlcsc") or {}
    return {
        "code": code,
        "success": (d or {}).get("success"),
        "api_code": (d or {}).get("code"),
        "message": (d or {}).get("message"),
        "title": r.get("title"),
        "package": C.dig(r, "packageDetail", "title"),
        "lcsc_id": lc.get("id"), "lcsc_price": lc.get("price"),
        "lcsc_stock": lc.get("stock"), "lcsc_min": lc.get("min"),
        "lcsc_step": lc.get("step"),
        "szlcsc_id": sz.get("id"), "szlcsc_price": sz.get("price"),
        "szlcsc_stock": sz.get("stock"), "szlcsc_min": sz.get("min"),
        "szlcsc_step": sz.get("step"),
        "szlcsc_url": sz.get("url"),
        "lcsc_url": lc.get("url"),
        "jlcOnSale": r.get("jlcOnSale"), "SMT": r.get("SMT"),
        "updated_at": r.get("updated_at"),
        "part_class": C.dig(r, "dataStr", "head", "c_para", "JLCPCB Part Class"),
        "manufacturer": C.dig(r, "dataStr", "head", "c_para", "Manufacturer"),
    }


def run_codes():
    out = {}
    for code in BOM_CODES:
        st, d = get_eda(code)
        if not ((d or {}).get("result")):
            out[code] = {"http": st, "raw": str(d)[:160]}
            print(f"{code}: FAIL http={st} {str(d)[:80]}")
            continue
        s = slim(code, d)
        out[code] = s
        print(f"{code}: lcsc={s['lcsc_price']} {s['lcsc_stock']} | "
              f"szlcsc={s['szlcsc_price']} {s['szlcsc_stock']} | "
              f"id={s['lcsc_id']}/{s['szlcsc_id']} pkg={s['package']}")
    C.save_out("easyeda_codes.json", out)


def run_invalid():
    codes = ["C999999999", "C00000", "C0", "C1581X", "XYZ", "C212121212121",
             "c1581"]
    out = {}
    for code in codes:
        st, d = get_eda(code)
        out[code] = {"http": st, "success": (d or {}).get("success"),
                     "code": (d or {}).get("code"),
                     "message": (d or {}).get("message"),
                     "has_result": bool((d or {}).get("result")),
                     "raw": json.dumps(d, ensure_ascii=False)[:220]}
        print(f"{code:18} http={st} success={(d or {}).get('success')} "
              f"code={(d or {}).get('code')} msg={(d or {}).get('message')} "
              f"has_result={out[code]['has_result']}")
    C.save_out("easyeda_invalid.json", out)


def run_mapping():
    """对照 JLC 接口 componentId，验证 EasyEDA szlcsc.id / lcsc.id 是否同源。"""
    jlc = (C.cache_get("jlc", "local:jlc_codes") or {})
    # 直接读落盘结果（probe_jlc.py 已写 /tmp/lcsc_probe_out/jlc_codes.json）
    try:
        jlc = json.load(open("/tmp/lcsc_probe_out/jlc_codes.json"))["items"]
    except Exception:  # noqa: BLE001
        jlc = {}
    rows = []
    for code in BOM_CODES:
        st, d = get_eda(code)
        r = (d or {}).get("result") or {}
        jid = (jlc.get(code) or {}).get("componentId")
        sid = C.dig(r, "szlcsc", "id")
        lid = C.dig(r, "lcsc", "id")
        rows.append({"code": code, "jlc_componentId": jid,
                     "eda_szlcsc_id": sid, "eda_lcsc_id": lid,
                     "match_jlc_eq_szlcsc": jid == sid,
                     "match_szlcsc_eq_lcsc": sid == lid})
        print(f"{code:12} jlc={jid!s:12} eda_sz={sid!s:12} eda_lc={lid!s:12} "
              f"jid==szid:{jid == sid} szid==lcid:{sid == lid}")
    same = sum(1 for r in rows if r["match_jlc_eq_szlcsc"])
    print(f"\nJLC.componentId == EasyEDA.szlcsc.id : {same}/{len(rows)}")
    C.save_out("easyeda_mapping.json", rows)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "codes"
    __import__("time").time()
    {"codes": run_codes, "invalid": run_invalid,
     "mapping": run_mapping}[cmd]()
    print(f"[stats] {C.stats()}")
