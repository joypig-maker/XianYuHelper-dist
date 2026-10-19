/**
 * util.js 数据提取逻辑自测（node tools/test-util.js）
 * 用模拟的 mtop 响应结构验证提取是否健壮
 */
require('../src/common/util.js');
var U = globalThis.XYUtil;

var assert = require('assert');

// 模拟 mtop.taobao.idle.pc.detail 的 data
var detailResp = {
  itemDO: {
    itemId: '1054899470781',
    title: '出一台 iPhone 15 128G 成色九新',
    desc: '自用机，无维修，配件齐全',
    price: '3980.00',
    sellerId: '2200811223',
    imageInfos: [
      { url: '//img.alicdn.com/bao/uploaded/i4/aaa.jpg_400x400q90.jpg' },
      { url: 'https://img.alicdn.com/bao/uploaded/i2/bbb.jpg' },
      'https://img.alicdn.com/bao/uploaded/i3/ccc.jpg_.webp'
    ],
    location: '成都',
    wantNum: 12
  },
  sellerDO: { userNick: '小王数码严选', userId: '2200811223' },
  trackParams: { itemId: '1054899470781', sellerId: '2200811223' }
};

var d = U.extractDetail(detailResp);
assert.ok(d, '应能提取出详情');
assert.strictEqual(d.itemId, '1054899470781');
assert.strictEqual(d.title, '出一台 iPhone 15 128G 成色九新');
assert.strictEqual(d.price, '3980');
assert.strictEqual(d.sellerNick, '小王数码严选');
assert.strictEqual(d.sellerId, '2200811223');
assert.strictEqual(d.desc, '自用机，无维修，配件齐全');
assert.strictEqual(d.images.length, 3, '应有 3 张图');
assert.strictEqual(d.images[0], 'https://img.alicdn.com/bao/uploaded/i4/aaa.jpg');
assert.strictEqual(d.images[2], 'https://img.alicdn.com/bao/uploaded/i3/ccc.jpg');
assert.strictEqual(d.url, 'https://www.goofish.com/item?id=1054899470781');
console.log('✓ extractDetail 通过', JSON.stringify(d, null, 0).slice(0, 120) + '...');

// 模拟字段缺失 + 嵌套更深的响应
var weird = {
  data: {
    nested: {
      item: { itemId: 998877665544, title: '二手显示器', images: ['//img.alicdn.com/x.png'] }
    },
    seller: { user: { userNick: '显示器小店' } }
  }
};
var d2 = U.extractDetail(weird.data);
assert.ok(d2 && d2.itemId === '998877665544', '深搜应能找到 itemId');
assert.ok(d2.title === '二手显示器');
assert.ok(d2.images[0] === 'https://img.alicdn.com/x.png');
assert.ok(d2.sellerNick === '显示器小店');
console.log('✓ 深搜兜底通过');

// 搜索页卡片收集
var searchResp = {
  resultList: [
    { itemId: '11111111', title: 'iPad Air 4', price: '1800', picUrl: '//img.alicdn.com/a.jpg' },
    { item: { itemId: '22222222', title: 'Switch 游戏机', price: '1200' } }
  ],
  other: { itemId: '11111111', title: 'iPad Air 4' }
};
var cards = U.collectCards(searchResp);
assert.strictEqual(cards.length, 2, '应去重并收集 2 条');
assert.strictEqual(cards[0].url, 'https://www.goofish.com/item?id=11111111');
console.log('✓ collectCards 通过');

// 文件名与目录名
assert.strictEqual(U.cleanFileName('a/b:c*d?"e<f>g|h'), 'abcdefgh');
var dir = U.buildDirName(U.extractDetail(detailResp), '{shop}_{title}_{itemId}');
assert.ok(dir.indexOf('小王数码严选') === 0, '目录名应含店铺名');
assert.ok(dir.length <= 80);
console.log('✓ 目录名：', dir);

// 文案生成
var txt = U.buildText(U.extractDetail(detailResp), 'txt');
assert.ok(txt.indexOf('标题：') === 0 && txt.indexOf('出') > 0);
var json = U.buildText(U.extractDetail(detailResp), 'json');
assert.ok(JSON.parse(json).itemId === '1054899470781');
console.log('✓ 文案生成通过');

console.log('\n全部测试通过 ✅');
