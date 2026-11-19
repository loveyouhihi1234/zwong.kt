(() => {
  function findInput(img) {
    if (img.id === "image-capt-cbt") {
      return document.querySelector('input[name="captchaCbt"]');
    }
    const scope = img.closest("form") || img.closest(".modal");
    return (
      scope?.querySelector('input[name="captcha"], input[name="captchaCbt"]') ||
      document.querySelector('input[name="captcha"]')
    );
  }

  function findPairs() {
    const pairs = [];
    for (const img of document.querySelectorAll('img[id^="image-capt"]')) {
      if (!img.checkVisibility()) continue;
      const input = findInput(img);
      if (input?.checkVisibility()) pairs.push({ img, input });
    }
    return pairs;
  }

  window.taxcapWatchCaptchas({
    portal: "dvc",
    findPairs,
    readImage: window.taxcapReadCanvasImage,
  });
})();
