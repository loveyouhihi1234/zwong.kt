(() => {
  function findPairs() {
    const pairs = [];
    for (const img of document.querySelectorAll('img[src^="/tcnnt/captcha.png"]')) {
      if (!img.checkVisibility()) continue;
      const input = img.closest("form")?.querySelector('input[name="captcha"]');
      if (input?.checkVisibility()) pairs.push({ img, input });
    }
    return pairs;
  }

  window.taxcapWatchCaptchas({
    portal: "tracuunnt",
    findPairs,
    readImage: window.taxcapReadCanvasImage,
  });
})();
