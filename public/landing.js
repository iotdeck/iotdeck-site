// Homepage: board tilt, pin tooltips, live tiles, and the switch that drives the board LED.
(() => {
  const root = document.documentElement;
  root.classList.add('home-js');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tr = (key) => (window.i18n ? window.i18n.t(key) : key);

  const hero = document.querySelector('.home-hero');
  const hub = document.getElementById('hub');
  const board = document.getElementById('board');
  const tip = document.getElementById('tip');
  const bg = document.querySelector('.home-bg');
  const glow = document.querySelector('.home-glow');

  // ---- Smooth cursor-following motion (lerped every frame) ----
  const pointer = { x: window.innerWidth * 0.7, y: window.innerHeight * 0.3 };
  const cur = { x: pointer.x, y: pointer.y, rx: 0, ry: 0, trx: 0, try: 0 };

  if (!reduceMotion) {
    window.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });

    hub.addEventListener('pointermove', (e) => {
      const r = hub.getBoundingClientRect();
      const nx = (e.clientX - r.left) / r.width - 0.5;
      const ny = (e.clientY - r.top) / r.height - 0.5;
      cur.try = nx * 14;   // board turns toward the cursor
      cur.trx = -ny * 10;
    });
    hub.addEventListener('pointerleave', () => { cur.try = 0; cur.trx = 0; });

    const frame = () => {
      cur.x += (pointer.x - cur.x) * 0.08;
      cur.y += (pointer.y - cur.y) * 0.08;
      cur.rx += (cur.trx - cur.rx) * 0.1;
      cur.ry += (cur.try - cur.ry) * 0.1;
      const px = (cur.x / window.innerWidth) * 100;
      const py = (cur.y / window.innerHeight) * 100;
      glow.style.transform = `translate3d(${cur.x}px, ${cur.y}px, 0)`;
      bg.style.setProperty('--gx', `${px}%`);
      bg.style.setProperty('--gy', `${py}%`);
      board.style.setProperty('--rx', `${cur.rx.toFixed(2)}deg`);
      board.style.setProperty('--ry', `${cur.ry.toFixed(2)}deg`);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } else {
    glow.style.display = 'none';
  }

  // ---- Tooltip for pins, the chip and the LED ----
  const showTip = (el, html) => {
    const r = el.getBoundingClientRect();
    tip.innerHTML = html;
    tip.style.left = `${r.left + r.width / 2}px`;
    tip.style.top = `${r.top}px`;
    tip.classList.add('show');
  };
  const hideTip = () => tip.classList.remove('show');

  const pinHtml = (el) => {
    const name = el.dataset.name || '';
    const role = el.dataset.role ? tr(el.dataset.role) : '';
    return `<b>${name}</b>${role}`;
  };

  const setFocus = (signal) => {
    if (signal) hub.dataset.focus = signal; else delete hub.dataset.focus;
  };

  board.querySelectorAll('.pin, .led, .chip').forEach((el) => {
    const openTip = () => {
      const isChip = el.classList.contains('chip');
      const html = isChip ? `<b>ESP32</b>${tr(el.dataset.tip)}` : pinHtml(el);
      showTip(el.querySelector('rect, circle') || el, html);
      if (el.dataset.signal) setFocus(el.dataset.signal);
    };
    el.addEventListener('pointerenter', openTip);
    el.addEventListener('focus', openTip);
    el.addEventListener('pointerleave', () => { hideTip(); setFocus(null); });
    el.addEventListener('blur', () => { hideTip(); setFocus(null); });
  });

  // ---- Tiles light their trace; the switch turns the board LED on and off ----
  const tiles = hub.querySelectorAll('.hub-tile');
  tiles.forEach((tile) => {
    tile.addEventListener('pointerenter', () => setFocus(tile.dataset.signal));
    tile.addEventListener('pointerleave', () => setFocus(null));
    tile.addEventListener('focus', () => setFocus(tile.dataset.signal));
    tile.addEventListener('blur', () => setFocus(null));
  });

  const switchTile = hub.querySelector('.tile-switch');
  const switchState = document.getElementById('switch-state');
  const setLed = (on) => {
    hub.dataset.led = on ? 'on' : 'off';
    switchTile.setAttribute('aria-pressed', String(on));
    switchState.dataset.i18n = on ? 'demo_on' : 'demo_off';
    switchState.textContent = tr(switchState.dataset.i18n);
  };
  switchTile.addEventListener('click', () => setLed(hub.dataset.led !== 'on'));

  // ---- Live values: they glide to a new target instead of jumping ----
  const tempEl = document.getElementById('temp-value');
  const humEl = document.getElementById('hum-value');
  const gaugeFill = document.getElementById('gauge-fill');
  const sparkPath = document.querySelector('#spark');
  const temp = { shown: 22, target: 22.4 };
  const hum = { shown: 64, target: 64 };
  const history = Array.from({ length: 30 }, () => 22);

  const pickTemp = () => { temp.target = +(21 + Math.random() * 4).toFixed(1); };
  const pickHum = () => { hum.target = Math.round(45 + Math.random() * 30); };
  pickTemp(); pickHum();
  setInterval(pickTemp, 2400);
  setInterval(pickHum, 3600);

  const drawSpark = () => {
    const pts = history.map((v, i) => {
      const x = (i / (history.length - 1)) * 200;
      const y = 36 - ((v - 20) / 6) * 32;
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    sparkPath.setAttribute('d', `M${pts.join(' L')}`);
  };

  let lastSample = 0;
  const tick = (now) => {
    temp.shown += (temp.target - temp.shown) * 0.04;
    hum.shown += (hum.target - hum.shown) * 0.04;
    tempEl.textContent = temp.shown.toFixed(1);
    humEl.textContent = Math.round(hum.shown);
    gaugeFill.style.strokeDashoffset = (1 - hum.shown / 100).toFixed(3);
    if (now - lastSample > 260) {
      lastSample = now;
      history.push(temp.shown); history.shift();
      drawSpark();
    }
    if (!reduceMotion) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  drawSpark();
  // Start the gauge at its value without a visible sweep
  gaugeFill.style.strokeDashoffset = (1 - hum.shown / 100).toFixed(3);

  // ---- Keep tooltip text in the chosen language ----
  document.addEventListener('langchange', () => {
    setLed(hub.dataset.led === 'on');
    hideTip();
  });

  // ---- Sections fade in as they scroll into view ----
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
