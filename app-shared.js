'use strict';
/* 入场动画只在首次进入视口播一次；不做视差、不做无限循环 */
(function () {
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var items = [].slice.call(document.querySelectorAll('[data-rise]'));
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach(function (e) { e.classList.add('in'); });
    return;
  }
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
  items.forEach(function (e, i) { e.style.transitionDelay = Math.min(240, i * 45) + 'ms'; io.observe(e); });
})();
