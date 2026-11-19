(() => {
  function findPairs() {
    const img = document.getElementById("safecode");
    const input = document.getElementById("vcode");
    return img?.checkVisibility() && input?.checkVisibility() ? [{ img, input }] : [];
  }

  window.taxcapWatchCaptchas({
    portal: "tdt",
    findPairs,
    readImage: window.taxcapReadCanvasImage,
  });
})();
