// Landing page: a looping temperature counter in the demo and fade-in sections on scroll.
(() => {
  document.documentElement.classList.add('lp-js');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Demo temperature drifts between 21 and 25 degrees, like a real sensor reading
  const tempEl = document.getElementById('lp-temp');
  if (tempEl && !reduceMotion) {
    let value = 22;
    let direction = 1;
    setInterval(() => {
      value += direction * 0.1;
      if (value >= 25 || value <= 21) direction = -direction;
      tempEl.textContent = value.toFixed(1);
    }, 220);
  }

  // Sections fade in as they scroll into view
  const sections = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || reduceMotion) {
    sections.forEach((el) => el.classList.add('in'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: 0.12 });
  sections.forEach((el) => observer.observe(el));
})();
