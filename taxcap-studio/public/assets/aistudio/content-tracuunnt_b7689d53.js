// tracuunnt.gdt.gov.vn/tcnnt (mstdn.jsp, mstcn.jsp...): ảnh
// <img src="/tcnnt/captcha.png?uid="> nằm cạnh <input id="captcha"> trong
// cùng form tra cứu.

function findPairs() {
  const pairs = [];
  for (const img of document.querySelectorAll('img[src^="/tcnnt/captcha.png"]')) {
    const input = img.closest("form")?.querySelector('input[name="captcha"]');
    if (img.checkVisibility() && input) pairs.push({ img, input });
  }
  return pairs;
}

watchCaptchas({ portal: "tracuunnt", findPairs, readImage: readCanvasImage });
