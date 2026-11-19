// Mở side panel khi bấm icon (nếu trình duyệt hỗ trợ); ghi file qua chrome.downloads.
// Bổ sung kiểm tra an toàn chống crash Service Worker trên các trình duyệt / phiên bản chưa bật sidePanel.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} else if (chrome.action?.onClicked) {
  // Dự phòng an toàn cho Chrome cũ / Cốc Cốc: mở popup cửa sổ riêng khi bấm icon thay vì văng lỗi sập extension
  chrome.action.onClicked.addListener(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL('src/sidepanel/index.html'),
      type: 'popup',
      width: 440,
      height: 720
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'download') {
    // Tải lại cùng hóa đơn thì ghi đè, không sinh file trùng
    chrome.downloads.download({ url: msg.url, filename: msg.filename, conflictAction: 'overwrite', saveAs: false })
      .then((id) => reply({ id }), (e) => reply({ error: e.message }));
    return true;
  }
});
