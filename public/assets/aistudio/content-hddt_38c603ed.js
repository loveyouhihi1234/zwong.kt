// hoadondientu.gdt.gov.vn (Next.js + antd): captcha là
// <img alt="captcha" src="data:image/svg+xml;base64,..."> và ô nhập là field
// antd "cvalue" (id="cvalue") trong cùng form. Trang có thể mở nhiều form có
// captcha cùng lúc (đăng nhập, tra cứu, popup) nên ghép theo form chứa ảnh.
const SVG_PREFIX = "data:image/svg+xml;base64,";

function findPairs() {
  const pairs = [];
  for (const img of document.querySelectorAll('img[alt="captcha"]')) {
    if (!img.getAttribute("src")?.startsWith(SVG_PREFIX)) continue;
    const input = img.closest("form")?.querySelector('input[id="cvalue"], input[id$="_cvalue"]');
    if (input) pairs.push({ img, input });
  }
  return pairs;
}

async function readImage(img) {
  const bytes = Uint8Array.from(atob(img.getAttribute("src").slice(SVG_PREFIX.length)), (c) =>
    c.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

watchCaptchas({ portal: "hddt", findPairs, readImage });
