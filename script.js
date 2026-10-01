document.addEventListener('DOMContentLoaded', function () {
  var heroLayers = document.querySelectorAll('.hero-bg-layer');
  if (heroLayers.length > 1) {
    var heroIdx = 0;
    setInterval(function () {
      var current = heroLayers[heroIdx];
      var nextIdx = (heroIdx + 1) % heroLayers.length;
      var next = heroLayers[nextIdx];
      current.classList.remove('active');
      void next.offsetWidth; // restart the kenburns animation on the incoming layer
      next.classList.add('active');
      heroIdx = nextIdx;
    }, 5500);
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) entry.target.classList.add('in-view');
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.reveal').forEach(function (el) { observer.observe(el); });
});
