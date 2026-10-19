/**
 * 把 dist 下的临时抓包样本精简后固化为测试固件。
 *
 * 那些 json 是一次性调试产物（几百 KB，含大量埋点字段），直接让测试去读
 * 既慢又脆——清理一次 dist 测试就全挂。这里按「测试真正要看的结构」抽出来：
 * 保留节点层级和字段形态，砍掉 trackInfo / 埋点这些无关的巨字段。
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

const KEEP_A_ITEM_FIELDS = ['offerId', 'title', 'offerPicUrl', 'odPicUrl', 'linkUrl', 'loginId',
  'priceInfo', 'list', 'grid', 'province', 'city', 'memberId', 'bizType'];

/* ---------- 1. 1688 关键词搜索页 ---------- */
{
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', '_search-api.json'), 'utf8'))[0];
  const b = raw.body.trim();
  const o = JSON.parse(b.slice(b.indexOf('(') + 1, b.lastIndexOf(')')));
  const items = o.data.data.OFFER.items.slice(0, 5).map((it) => {
    const d = it.data;
    const slim = {};
    KEEP_A_ITEM_FIELDS.forEach((k) => { if (d[k] !== undefined) slim[k] = d[k]; });
    return { cellType: it.cellType, viewType: it.viewType, data: slim };
  });
  const fx = { data: { OFFER: { found: o.data.data.OFFER.found, keywords: o.data.data.OFFER.keywords, items: items } } };
  fs.writeFileSync(path.join(OUT, '1688-search-api.json'), JSON.stringify(fx, null, 2));
  console.log('1688 搜索页固件：%d 条商品，%d 字节', items.length,
    fs.statSync(path.join(OUT, '1688-search-api.json')).size);
}

/* ---------- 2. 1688 整店页 ---------- */
{
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'offerlist-2.json'), 'utf8'));
  const body = typeof raw.moduleasyncservice === 'string'
    ? JSON.parse(raw.moduleasyncservice) : raw.moduleasyncservice;
  const list = body.data.content.offerList.slice(0, 5).map((n) => {
    const keep = {};
    ['id', 'subject', 'offerImages', 'imageInfos', 'consignPrice', 'priceSegments',
      'finalPriceVo', 'memberId', 'saleQuantity'].forEach((k) => {
      if (n[k] !== undefined) keep[k] = n[k];
    });
    return keep;
  });
  const fx = { content: { offerList: list, offerCount: body.data.content.offerCount } };
  fs.writeFileSync(path.join(OUT, '1688-offerlist.json'), JSON.stringify(fx, null, 2));
  console.log('1688 整店页固件：%d 条商品，%d 字节', list.length,
    fs.statSync(path.join(OUT, '1688-offerlist.json')).size);
}

/* ---------- 3. 1688 SKU 选择器（含完整主图集） ---------- */
{
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dist', 'laputa-sku-sample.json'), 'utf8'));
  fs.writeFileSync(path.join(OUT, '1688-sku-selector.json'), JSON.stringify(raw.data, null, 2));
  console.log('1688 SKU 固件：%d 字节', fs.statSync(path.join(OUT, '1688-sku-selector.json')).size);
}
