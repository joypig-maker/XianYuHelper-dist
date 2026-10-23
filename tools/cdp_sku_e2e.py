"""
SKU 规格图真实落盘测试（v1.8.4）

之前只测过数据层（propertyImage 有值、URL 200、extractDetail 不丢图），
从没验证过「文件真的写到磁盘」——而那正是用户反复报的失败点。

做法：连上扩展的 service worker，走真实 chrome.downloads 落盘。

跑：python tools/cdp_sku_e2e.py
"""
import json
import os
import shutil
import sys
import time
import urllib.request

sys.path.insert(0, "tools")
from cdp_lib import new_tab  # noqa: E402

OUT = r"D:\work\闲鱼浏览器插件\_sku_test"
ITEM = "844934128301"
SPEC_URL = ("http://img.alicdn.com/bao/uploaded/i4/"
            "O1CN01w6UGhB1dBHFuJg4U9_!!0-mtopupload.jpg")


def find_sw():
    data = json.load(urllib.request.urlopen(
        "http://127.0.0.1:9222/json/list", timeout=8))
    for t in data:
        u = t.get("url", "")
        if "service_worker.js" in u and "chrome-extension://" in u:
            return t["webSocketDebuggerUrl"], u
    return None, None


def tree(root, limit=60):
    out = []
    if not os.path.isdir(root):
        return out
    for dirpath, _dirnames, filenames in os.walk(root):
        for f in filenames:
            p = os.path.join(dirpath, f)
            try:
                sz = os.path.getsize(p)
            except OSError:
                sz = -1
            out.append((os.path.relpath(p, root).replace("\\", "/"), sz))
    return out[:limit]


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT, exist_ok=True)

    # 唤醒扩展（SW 是懒启动的）
    new_tab("https://www.goofish.com/item?id=%s" % ITEM)
    time.sleep(12)

    sw_ws, sw_url = find_sw()
    if not sw_ws:
        print("★ 扩展 SW 没起来")
        return
    print("扩展 SW:", sw_url[:76])

    import websocket
    ws = websocket.create_connection(sw_ws, timeout=180, suppress_origin=True)
    mid = [0]

    def send(method, params=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method,
                            "params": params or {}}))
        return mid[0]

    def wait_for(mid_no, timeout=120):
        end = time.time() + timeout
        while time.time() < end:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            if m.get("id") == mid_no:
                return m
        return None

    dir_path = (OUT + "/商品_" + ITEM).replace("\\", "/")
    item = {
        "dir": dir_path,
        "site": "xianyu",
        "itemId": ITEM,
        "images": [],
        "skus": {
            "specs": ["颜色", "尺码"],
            "specDefs": [
                {"name": "颜色", "values": [
                    {"value": "皮面果绿", "image": SPEC_URL},
                    {"value": "黑色", "image": SPEC_URL},
                ]},
                {"name": "尺码", "values": [{"value": "28", "image": ""}]},
            ],
            "list": [{"key": "皮面果绿|28", "price": "49.90", "stock": "99"}],
        },
        "videos": [],
        "meta": {"title": "落盘测试", "description": "d", "price": "49.9"},
        "text": "标题：落盘测试\n",
        "filename": "文案.txt",
    }

    send("Runtime.evaluate", {
        "expression": """
        (async () => {
          try {
            const r = await chrome.runtime.sendMessage(
              {type:'xy:download-items', items: %s});
            return JSON.stringify(r);
          } catch(e) { return JSON.stringify({err: String(e)}); }
        })()
        """ % json.dumps([item], ensure_ascii=False),
        "awaitPromise": True, "returnByValue": True})
    r = wait_for(mid[0], 120)
    val = r.get("result", {}).get("result", {}).get("value") if r else None
    print("\n★ 下载接口返回:", val)

    time.sleep(4)
    print("\n=== 落盘文件 ===")
    files = tree(OUT)
    if not files:
        print("  ★ 一个文件都没有")
    for rel, sz in files:
        print("  %-46s %d 字节" % (rel, sz))
    sku = [f for f in files if "/sku/" in f[0]]
    print("\n规格图文件数: %d" % len(sku))
    for rel, sz in sku:
        print("   %s (%d 字节)" % (rel, sz))

    # info.json 里 sku_specs 有没有 local_image
    info = os.path.join(OUT, "商品_" + ITEM, "info.json")
    if os.path.isfile(info):
        j = json.load(open(info, encoding="utf-8"))
        specs = j.get("sku_specs") or []
        print("\ninfo.json sku_specs:")
        for s in specs:
            for v in s.get("values", []):
                print("   %s=%s  local_image=%s" % (
                    s.get("name"), v.get("value"), v.get("local_image")))
    ws.close()


if __name__ == "__main__":
    main()
