// thuedientu.gdt.gov.vn/etaxnnt: form đăng nhập #loginForm có ảnh
// <img id="safecode" src="/etaxnnt/servlet/ImageServlet"> và ô nhập
// <input id="vcode" name="_verifyCode">. Nút làm mới gắn thêm ?d=<giờ> vào src
// nên mỗi ảnh mới có key riêng.

function findPairs() {
  const img = document.getElementById("safecode");
  const input = document.getElementById("vcode");
  return img?.checkVisibility() && input ? [{ img, input }] : [];
}

watchCaptchas({ portal: "tdt", findPairs, readImage: readCanvasImage });
