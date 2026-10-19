/**
 * 查「点 input 不进 selected、点 label 却可以」的结构性原因。
 * 只依赖 DOM，不需要重载扩展。
 */
const CDP = require('./cdp.js');

const PROBE = `
  var labs = document.querySelectorAll('.xy-check[data-xy-id]');
  var out = [];
  for (var i = 0; i < labs.length && i < 4; i++) {
    var lab = labs[i];
    var inp = lab.querySelector('input');
    var cl = inp ? inp.closest('.xy-check') : null;
    out.push({
      id: lab.getAttribute('data-xy-id'),
      hasInput: !!inp,
      inputParent: inp && inp.parentElement ? inp.parentElement.tagName + '.' + (inp.parentElement.className || '') : null,
      contains: lab.contains(inp),
      closestSame: cl === lab,
      closestCls: cl ? (cl.className || '').toString().slice(0, 40) : null,
      closestIsInput: cl === inp,
      labChildren: Array.prototype.map.call(lab.children, function (c) {
        return c.tagName + '.' + String(c.className || '').slice(0, 24);
      })
    });
  }
  return out;
`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  console.log(JSON.stringify(await page.evaluate(PROBE), null, 1));
  await b.close();
})();
