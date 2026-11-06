// IoTDeck dashboard: devices, widgets, live updates, and control.
// All user-facing text goes through i18n (Arabic by default, English optional).
(() => {
  // ---------- Language helpers ----------

  const t = (key, vars) => (window.i18n ? window.i18n.t(key, vars) : key);
  const numberLocale = 'en-US'; // readings always use Western digits

  // ---------- DOM helpers (no innerHTML with user data) ----------

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    appendChildren(el, children);
    return el;
  }

  function s(tag, attrs, ...children) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs || {})) el.setAttribute(key, String(value));
    appendChildren(el, children);
    return el;
  }

  function appendChildren(el, children) {
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  const $ = (id) => document.getElementById(id);

  // ---------- State ----------

  const state = {
    user: null,
    devices: new Map(), // id -> { id, name, latest, lastSeen, online }
    widgets: [],
    cards: new Map(), // widget id -> element
    history: new Map(), // `${deviceId}` -> [{ ts, data }]
    sockets: new Map(), // deviceId -> WebSocket
    pending: new Map(), // widget id -> { value, until } for switches you just set
    filter: null, // deviceId or null
    focusPage: false, // true when this page is one device's own page (?device=)
    studio: false, // layout edit mode (drag, resize)
    view: 'dash', // phone tabs: dash | activity | me
  };

  // ---------- API ----------

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
    if (res.status === 401) {
      location.replace('/signin');
      throw new Error(t('signed_out'));
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || t('request_failed'));
    return body;
  }

  // ---------- Formatting ----------

  function timeAgo(ts) {
    if (!ts) return t('time_never');
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (sec < 5) return t('time_now');
    if (sec < 60) return t('time_sec', { n: sec });
    const min = Math.round(sec / 60);
    if (min < 60) return t('time_min', { n: min });
    const hr = Math.round(min / 60);
    if (hr < 48) return t('time_hour', { n: hr });
    return t('time_day', { n: Math.round(hr / 24) });
  }

  function formatValue(v) {
    if (typeof v === 'number') return v.toLocaleString(numberLocale, { maximumFractionDigits: 2 });
    if (typeof v === 'boolean') return v ? t('on') : t('off');
    if (v === undefined || v === null) return '—';
    return String(v);
  }

  // live: the board's connection is open and it has pinged recently (the server decides this).
  // offline: no connection. The last time it sent a value is shown next to the status.
  function deviceStatus(device) {
    return device.online ? 'live' : 'offline';
  }

  // Every board gets the same line. Connected: the time it connected. Not connected: when it was last heard.
  function statusLine(device, status) {
    if (status === 'offline') {
      return device.lastSeen ? `${t('offline')} · ${t('last_seen', { t: timeAgo(device.lastSeen) })}` : t('offline');
    }
    const since = device.onlineSince;
    if (!since) return t('live');
    const d = new Date(since);
    const sameDay = d.toDateString() === new Date().toDateString();
    const when = sameDay
      ? d.toLocaleTimeString(numberLocale, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString(numberLocale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return t('connected_since', { t: when });
  }

  function isOnline(device) {
    return deviceStatus(device) !== 'offline';
  }

  // ---------- Toast ----------

  let toastTimer;
  function toast(message, kind = 'ok') {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', kind === 'error');
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  // ---------- Modals ----------

  function openModal(id) {
    const modal = $(id);
    modal.classList.add('open');
    const firstInput = modal.querySelector('input, select');
    if (firstInput) setTimeout(() => firstInput.focus(), 30);
  }

  function closeModal(modal) {
    // Closing the look popup without saving drops the preview
    if (modal.id === 'theme-modal' && savedTheme) applyTheme(savedTheme);
    modal.classList.remove('open');
  }

  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal(backdrop);
    });
  });
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.closest('.modal-backdrop')));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-backdrop.open').forEach(closeModal);
  });

  // ---------- Rendering: greeting, sidebar, stats, filters ----------

  function renderGreeting() {
    if (state.focusPage) {
      const device = state.devices.get(state.filter);
      $('greeting').textContent = device ? device.name : t('device_fallback');
      return;
    }
    if (!state.user) return;
    const first = (state.user.name || '').trim().split(' ')[0];
    $('greeting').textContent = t('hello', { name: first || t('there') });
  }

  // Phone: the devices as round avatars you swipe through
  function renderChips() {
    const row = $('chips');
    if (!row) return;
    row.replaceChildren();
    const devices = [...state.devices.values()];
    row.append(
      h(
        'button',
        { class: `chip${state.filter ? '' : ' selected'}`, type: 'button', onclick: () => switchDevice(null) },
        h('span', { class: 'chip-av' }, s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z' }))),
        h('span', { class: 'chip-name', text: t('back_all') }),
      ),
    );
    for (const device of devices) {
      const online = isOnline(device);
      row.append(
        h(
          'button',
          { class: `chip${online ? ' online' : ''}${state.filter === device.id ? ' selected' : ''}`, type: 'button', onclick: () => switchDevice(device.id) },
          h('span', { class: 'chip-av' }, (device.name || '?').trim().slice(0, 1).toUpperCase(), h('span', { class: 'chip-dot' })),
          h('span', { class: 'chip-name', text: device.name }),
        ),
      );
    }
    row.append(
      h(
        'button',
        { class: 'chip chip-add', type: 'button', onclick: () => { resetDeviceModal(); openModal('device-modal'); } },
        h('span', { class: 'chip-av' }, s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: 'M12 5v14M5 12h14' }))),
        h('span', { class: 'chip-name', text: t('new_device') }),
      ),
    );
    const sel = row.querySelector('.chip.selected');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderSidebar() {
    renderChips();
    const list = $('device-list');
    list.replaceChildren();
    const devices = [...state.devices.values()];
    if (devices.length === 0) {
      list.append(h('p', { class: 'hint', style: 'padding:8px 12px;', text: t('no_devices') }));
      return;
    }
    for (const device of devices) {
      const status = deviceStatus(device);
      const selected = state.filter === device.id;
      const item = h(
        'div',
        {
          class: `device-item${selected ? ' selected' : ''}`,
          role: 'button',
          tabindex: '0',
          'aria-pressed': String(selected),
          onclick: () => openDevicePage(device.id),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openDevicePage(device.id);
            }
          },
        },
        h('span', { class: `status-dot ${status === 'live' ? 'online pulse' : status === 'quiet' ? 'online' : ''}`, 'aria-hidden': 'true' }),
        h(
          'span',
          { class: 'meta' },
          h('span', { class: 'name', text: device.name }),
          // Every board uses the same line: its status, then the time of its last value (a dash if it has sent none)
          h('span', { class: 'sub', text: statusLine(device, status) }),
          selected ? h('span', { class: 'viewing', text: t('viewing_now') }) : null,
        ),
        h('span', {
          class: 'widget-remove',
          role: 'button',
          title: t('delete_device'),
          'aria-label': t('delete_named', { name: device.name }),
          style: 'opacity:0.0;',
          onclick: (e) => {
            e.stopPropagation();
            removeDevice(device);
          },
          text: '×',
        }),
      );
      item.addEventListener('mouseenter', () => (item.querySelector('.widget-remove').style.opacity = '1'));
      item.addEventListener('mouseleave', () => (item.querySelector('.widget-remove').style.opacity = '0'));
      list.append(item);
    }
  }

  // On phones the device list scrolls sideways: keep the selected device in view
  function revealSelected() {
    const el = document.querySelector('#device-list .device-item.selected');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderStats() {
    const devices = [...state.devices.values()];
    const online = devices.filter(isOnline).length;
    $('stat-devices').textContent = String(devices.length);
    $('stat-online').textContent = String(online);
    $('stat-widgets').textContent = String(state.widgets.length);
    const bar = $('appbar-state');
    if (bar) {
      bar.textContent = devices.length ? t('online_of', { online, total: devices.length }) : '';
      bar.classList.toggle('live', online > 0);
    }
    $('subtitle').textContent =
      devices.length === 0
        ? t('connect_hint')
        : t(devices.length === 1 ? 'subtitle_one' : 'subtitle_many', { online, total: devices.length });
  }

  function renderFilters() {
    const row = $('filter-row');
    row.replaceChildren();
    if (state.focusPage) {
      row.append(
        h('a', { class: 'btn btn-ghost', href: '/dashboard?all=1', text: t('back_all'), onclick: (e) => { e.preventDefault(); switchDevice(null); } }),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: openThemeModal, text: t('customize') }),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => openSetup(state.filter), text: t('device_setup') }),
      );
      return;
    }
    if (!state.filter) return;
    const device = state.devices.get(state.filter);
    row.append(
      h('span', { class: 'hint', style: 'align-self:center;', text: t('showing', { name: device ? device.name : t('device_fallback') }) }),
      h(
        'button',
        {
          class: 'btn btn-ghost',
          type: 'button',
          onclick: () => {
            state.filter = null;
            renderAll();
          },
        },
        t('show_all'),
      ),
    );
  }

  // ---------- Device pages and look ----------

  const THEME_COLORS = ['#7c8cff', '#3ee3b5', '#ffb86b', '#ff6b8a', '#5ec8ff', '#c792ea'];
  const THEME_BACKGROUNDS = ['night', 'aurora', 'ocean', 'ember'];
  let savedTheme = null;
  let draftTheme = null;

  // Switch device without reloading the page, like an app
  async function openDevicePage(deviceId) {
    switchDevice(deviceId);
  }

  async function switchDevice(deviceId) {
    if (state.studio) setStudio(false);
    state.filter = deviceId || null;
    state.focusPage = Boolean(deviceId);
    try {
      history.replaceState(null, '', deviceId ? `/dashboard?device=${encodeURIComponent(deviceId)}` : '/dashboard?all=1');
    } catch {}
    setView('dash');
    if (deviceId) await loadTheme();
    else {
      savedTheme = null;
      applyTheme({ accent: THEME_COLORS[0], background: 'night' });
    }
    renderAll();
    window.scrollTo({ top: 0 });
  }

  function setView(view) {
    state.view = view;
    $('main').dataset.view = view;
    document.querySelectorAll('#tabbar [data-view]').forEach((b) => {
      if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (view !== 'dash' && state.studio) setStudio(false);
  }

  function applyTheme(theme) {
    document.body.dataset.bg = theme.background;
    document.body.style.setProperty(
      '--custom-bg',
      theme.background === 'custom' ? `url("/api/devices/${state.filter}/background?v=${theme.v || 0}")` : 'none',
    );
    document.documentElement.style.setProperty('--accent', theme.accent);
    document.documentElement.style.setProperty('--accent-glow', `${theme.accent}59`);
  }

  async function loadTheme() {
    try {
      const { theme } = await api(`/api/devices/${state.filter}/theme`);
      savedTheme = theme;
      applyTheme(theme);
    } catch {
      // Keep the default look if the theme cannot be loaded
    }
  }

  function openThemeModal() {
    draftTheme = { ...(savedTheme || { accent: THEME_COLORS[0], background: 'night' }) };
    renderThemeModal();
    openModal('theme-modal');
  }

  function renderThemeModal() {
    $('theme-accents').replaceChildren(...THEME_COLORS.map((color) => h('button', {
      class: 'swatch',
      type: 'button',
      role: 'radio',
      'aria-checked': String(color === draftTheme.accent),
      'aria-label': color,
      style: `--swatch:${color}`,
      onclick: () => {
        draftTheme.accent = color;
        applyTheme(draftTheme);
        renderThemeModal();
      },
    })));
    $('theme-bgs').replaceChildren(...THEME_BACKGROUNDS.map((bg) => h(
      'button',
      {
        class: 'gadget-card',
        type: 'button',
        role: 'radio',
        'aria-checked': String(bg === draftTheme.background),
        onclick: () => {
          draftTheme.background = bg;
          applyTheme(draftTheme);
          renderThemeModal();
        },
      },
      h('span', { class: 'bg-preview', 'data-bg': bg, 'aria-hidden': 'true' }),
      h('span', { class: 'gadget-name', text: t(`bg_${bg}`) }),
    )));
  }

  async function saveDeviceTheme() {
    try {
      const { theme } = await api(`/api/devices/${state.filter}/theme`, { method: 'PUT', body: JSON.stringify(draftTheme) });
      savedTheme = theme;
      applyTheme(theme);
      closeModal($('theme-modal'));
      toast(t('theme_saved'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Uploads are saved right away, like the image itself. Accent and preset changes still need Save.
  async function uploadDeviceBackground(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast(t('theme_image_type'), 'error');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast(t('theme_image_size'), 'error');
      return;
    }
    try {
      const { theme } = await api(`/api/devices/${state.filter}/background`, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      savedTheme = theme;
      draftTheme = { ...theme };
      applyTheme(theme);
      renderThemeModal();
      toast(t('theme_image_saved'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeDeviceBackground() {
    try {
      const { theme } = await api(`/api/devices/${state.filter}/background`, { method: 'DELETE' });
      savedTheme = theme;
      draftTheme = { ...theme };
      applyTheme(theme);
      renderThemeModal();
      toast(t('theme_image_removed'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function cancelDeviceTheme() {
    closeModal($('theme-modal'));
  }

  // ---------- Widgets ----------

  // ---------- Tiles: the canvas, sizes, icons ----------

  // Icons are small line drawings (24x24). A tile keeps the name of the one you pick.
  const ICON_PATHS = {
    bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
    power: 'M12 3v8M6.4 7.2a7 7 0 1 0 11.2 0',
    fan: 'M12 12m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M12 10.5C12 6 14 4 16 4s2.5 3 0 5.5c-1 1-2.5 1.5-4 1M13.5 12c4.500 0 6.500 2 6.500 4s-3 2.500-5.500 0c-1-1-1.500-2.500-1-4M12 13.500c0 4.500-2 6.500-4 6.500s-2.500-3 0-5.500c1-1 2.500-1.500 4-1M10.500 12C6 12 4 10 4 8s3-2.500 5.500 0c1 1 1.500 2.500 1 4',
    thermo: 'M14 14.800V5a2 2 0 0 0-4 0v9.800a4 4 0 1 0 4 0zM12 9v7',
    drop: 'M12 3s6 6.500 6 11a6 6 0 0 1-12 0c0-4.500 6-11 6-11z',
    bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
    door: 'M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18M14 12v.5',
    lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V8a4 4 0 0 1 8 0v3',
    plant: 'M12 21v-9M12 12C12 7 9 5 5 5c0 4 2 7 7 7zM12 14c0-4 2-6 6-6 0 4-2 6-6 6zM8 21h8',
    wifi: 'M2 9a15 15 0 0 1 20 0M5 12.500a10 10 0 0 1 14 0M8.500 16a5 5 0 0 1 7 0M12 19.500v.01',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400',
    moon: 'M20 14.500A8 8 0 1 1 9.500 4 6.500 6.500 0 0 0 20 14.500z',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.500 2h-15zM10 21h4',
    gauge: 'M4 18a9 9 0 1 1 16 0M12 14l4-5M12 14.500v.01',
    chart: 'M4 19V5M4 19h16M8 15l3-4 3 2 5-7',
    hand: 'M9 11V5.500a1.500 1.500 0 0 1 3 0V11M12 10V4.500a1.500 1.500 0 0 1 3 0V11M15 11V6.500a1.500 1.500 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-2-3.500a1.500 1.500 0 0 1 2.500-1.500L9 15V9a1.500 1.500 0 0 1 3 0',
    slider: 'M4 8h10M18 8h2M4 16h2M10 16h10M16 6v4M8 14v4',
    text: 'M5 6h14M5 12h14M5 18h9',
    photo: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 16l5-5 4 4 2-2 5 5M15 8.500v.01',
    flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
    home: 'M4 11.500 12 5l8 6.500V19a1 1 0 0 1-1 1h-4v-5H9v5H5a1 1 0 0 1-1-1z',
    dot: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  };
  const PICKABLE_ICONS = ['bulb', 'power', 'fan', 'thermo', 'drop', 'bolt', 'door', 'lock', 'plant', 'wifi', 'sun', 'moon', 'bell', 'gauge', 'chart', 'hand', 'home', 'flag'];
  const DEFAULT_ICON = {
    toggle: 'bulb', button: 'hand', slider: 'slider', value: 'thermo', text: 'text', gauge: 'gauge',
    bar: 'chart', line: 'chart', indicator: 'dot', image: 'photo', label: 'flag',
  };
  // Starting size on the canvas: [columns, rows]. A phone shows 4 columns.
  const DEFAULT_SIZE = {
    toggle: [2, 1], button: [2, 1], slider: [4, 1], value: [2, 1], text: [2, 1], gauge: [2, 2],
    bar: [2, 1], line: [4, 2], indicator: [2, 1], image: [2, 2], label: [4, 1],
  };
  const TILE_COLORS = ['#7c8cff', '#3ee3b5', '#ffb86b', '#ff6b8a', '#5ec8ff', '#c792ea'];

  function iconSvg(name) {
    return s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: ICON_PATHS[name] || ICON_PATHS.dot }));
  }

  function tileSize(widget) {
    const c = widget.config || {};
    const d = DEFAULT_SIZE[widget.type] || [2, 1];
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
    return [clamp(Number(c.w) || d[0], 1, 4), clamp(Number(c.h) || d[1], 1, 4)];
  }

  // Numbers count up to their new value instead of jumping
  const tweens = new WeakMap();
  function setNumber(el, raw) {
    if (typeof raw !== 'number') {
      el.textContent = formatValue(raw);
      el.dataset.num = '';
      return;
    }
    const from = el.dataset.num === '' || el.dataset.num === undefined ? raw : Number(el.dataset.num);
    el.dataset.num = String(raw);
    if (from === raw || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = formatValue(raw);
      return;
    }
    const start = performance.now();
    const token = {};
    tweens.set(el, token);
    const step = (now) => {
      if (tweens.get(el) !== token) return;
      const p = Math.min(1, (now - start) / 600);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = formatValue(from + (raw - from) * eased);
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = formatValue(raw);
    };
    requestAnimationFrame(step);
  }

  function buzz(ms = 12) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch {}
  }

  // ---------- Rendering: the canvas ----------

  function visibleWidgets() {
    return state.widgets.filter((w) => !state.filter || w.deviceId === state.filter);
  }

  function renderGrid() {
    const grid = $('grid');
    grid.replaceChildren();
    state.cards.clear();
    grid.classList.toggle('editing', state.studio);

    const visible = visibleWidgets();

    if (state.widgets.length === 0) {
      grid.append(
        h(
          'div',
          { class: 'empty' },
          h('h3', { text: t('first_dash_title') }),
          h('p', { text: t('first_dash_text') }),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: openWidgetModal, text: t('add_widget_cta') }),
        ),
      );
      return;
    }

    if (visible.length === 0) {
      grid.append(
        h(
          'div',
          { class: 'empty' },
          h('p', { text: t('device_no_widgets') }),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: openWidgetModal, text: t('add_widget_cta') }),
        ),
      );
      return;
    }

    visible.forEach((widget, i) => {
      const card = buildWidgetCard(widget);
      card.style.setProperty('--i', String(Math.min(i, 14)));
      state.cards.set(widget.id, card);
      grid.append(card);
      updateWidgetCard(card, widget);
    });

    grid.append(
      h(
        'button',
        { class: 'add-tile', type: 'button', onclick: openWidgetModal },
        s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, s('path', { d: 'M12 5v14M5 12h14' })),
        t('add_widget_btn'),
      ),
    );
  }

  function buildWidgetCard(widget) {
    const [w, hgt] = tileSize(widget);
    const cfg = widget.config || {};
    const icon = cfg.icon && ICON_PATHS[cfg.icon] ? cfg.icon : DEFAULT_ICON[widget.type] || 'dot';
    const decor = widget.type === 'image' || widget.type === 'label';

    const edit = h(
      'div',
      { class: 'edit-ui' },
      h('button', { class: 'e-del', type: 'button', 'aria-label': t('remove_widget'), title: t('remove'), onclick: (e) => { e.stopPropagation(); removeWidget(widget); } },
        s('svg', { viewBox: '0 0 24 24' }, s('path', { d: 'M6 6l12 12M18 6 6 18' }))),
      h('button', { class: 'e-resize', type: 'button', 'aria-label': t('resize_tile'), title: t('resize_tile') },
        s('svg', { viewBox: '0 0 24 24' }, s('path', { d: 'M20 14v6h-6M10 20 20 10' }))),
    );
    const titled = Boolean((widget.title || '').trim());
    const top = widget.type === 'label'
      ? null
      : h(
        'div',
        { class: `tile-top${titled ? '' : ' untitled'}` },
        h('span', { class: 'tile-ico' }, iconSvg(icon)),
        h('span', { class: 'tile-title', 'data-role': 'title', text: widget.title }),
        widget.type === 'slider' ? h('span', { class: 'slider-value', 'data-role': 'value' }) : null,
        h('span', { class: 'tile-dev', 'data-role': 'device' }),
      );

    const card = h(
      'article',
      {
        class: 'tile',
        'data-id': widget.id,
        'data-type': widget.type,
        'data-fit': cfg.fit || 'cover',
        'data-w': String(w),
        style: `--w:${w};--h:${hgt};${cfg.accent ? `--tile-accent:${cfg.accent};` : ''}`,
      },
      top,
      widgetBody(widget, icon),
      decor ? null : h('div', { class: 'tile-foot', 'data-role': 'updated' }),
      edit,
    );
    bindTileEditing(card, widget);
    return card;
  }

  function widgetBody(widget, icon) {
    const type = widget.type;
    if (type === 'label') {
      const cfg = widget.config || {};
      return h(
        'div',
        { class: 'label-block' },
        h('div', { class: 'label-title' }, h('span', { class: 'tile-ico' }, iconSvg(icon)), h('span', { text: widget.title || '' })),
        cfg.sub ? h('div', { class: 'label-sub', text: cfg.sub }) : null,
      );
    }

    if (type === 'image') {
      return h(
        'div',
        { class: 'img-layer' },
        h('div', { class: 'img-empty', 'data-role': 'img-empty' },
          s('svg', { viewBox: '0 0 24 24' }, s('path', { d: ICON_PATHS.photo })),
          h('span', { text: t('image_empty') })),
        h('img', { 'data-role': 'img-a', alt: '', draggable: 'false', onerror: (e) => e.target.classList.remove('show') }),
        h('img', { 'data-role': 'img-b', alt: '', draggable: 'false', onerror: (e) => e.target.classList.remove('show') }),
      );
    }

    const body = (...kids) => h('div', { class: 'tile-body' }, ...kids);

    if (type === 'value' || type === 'text') {
      return body(h(
        'div',
        { class: `big-value${type === 'text' ? ' text-value' : ''}` },
        h('span', { 'data-role': 'value' }),
        h('span', { class: 'unit', 'data-role': 'unit' }),
      ));
    }

    if (type === 'slider') {
      return body(
        h(
          'div',
          { class: 'slider-row' },
          h('input', { class: 'slider', type: 'range', 'data-role': 'slider', 'aria-label': widget.title || t('type_slider') }),
        ),
      );
    }

    if (type === 'gauge') {
      const arc = 2 * Math.PI * 80 * 0.75;
      return body(
        s(
          'svg',
          { class: 'gauge', viewBox: '0 0 200 200', role: 'img', 'aria-label': t('gauge_label') },
          s('circle', {
            class: 'track',
            cx: 100, cy: 100, r: 80, fill: 'none', 'stroke-width': 14, 'stroke-linecap': 'round',
            'stroke-dasharray': `${arc} ${2 * Math.PI * 80}`, transform: 'rotate(135 100 100)',
          }),
          s('circle', {
            class: 'fill', 'data-role': 'fill',
            cx: 100, cy: 100, r: 80, fill: 'none', 'stroke-width': 14, 'stroke-linecap': 'round',
            'stroke-dasharray': `${arc} ${2 * Math.PI * 80}`, 'stroke-dashoffset': arc, transform: 'rotate(135 100 100)',
          }),
          s('text', { class: 'gauge-value', x: 100, y: 108, 'data-role': 'gv' }),
          s('text', { class: 'gauge-unit', x: 100, y: 130, 'data-role': 'gu' }),
        ),
      );
    }

    if (type === 'line') {
      return h(
        'div',
        { class: 'tile-body' },
        h(
          'div',
          { class: 'big-value' },
          h('span', { 'data-role': 'value' }),
          h('span', { class: 'unit', 'data-role': 'unit' }),
        ),
        s(
          'svg',
          { class: 'spark', viewBox: '0 0 300 86', preserveAspectRatio: 'none', role: 'img', 'aria-label': t('trend_label') },
          s('path', { class: 'area', 'data-role': 'area', d: '' }),
          s('path', { class: 'line', 'data-role': 'line', d: '' }),
        ),
      );
    }

    if (type === 'toggle') {
      return body(
        h('div', { class: 'state-text', 'data-role': 'state' }),
        h('button', { class: 'tile-hit', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': widget.title || '', 'data-role': 'switch' }),
      );
    }

    if (type === 'bar') {
      return body(
        h(
          'div',
          { class: 'big-value', style: 'font-size:clamp(22px,24cqmin,34px);margin-bottom:8px;' },
          h('span', { 'data-role': 'value' }),
          h('span', { class: 'unit', 'data-role': 'unit' }),
        ),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', 'data-role': 'bar' })),
      );
    }

    if (type === 'indicator') {
      return body(
        h('div', { class: 'control' }, h('span', { class: 'lamp', 'data-role': 'lamp' }), h('span', { class: 'state-text', 'data-role': 'state' })),
      );
    }

    // button
    return body(
      h('div', { class: 'state-text', text: t('trigger') }),
      h('button', { class: 'pulse-btn', type: 'button', 'data-role': 'pulse', 'aria-label': widget.title || t('trigger'), text: t('trigger') }),
    );
  }

  function updateWidgetCard(card, widget) {
    const device = state.devices.get(widget.deviceId);
    // This tile's own value and time. Other tiles do not change it.
    const info = device && device.fields ? device.fields[widget.field] : undefined;
    const raw = info ? info.value : device && device.latest ? device.latest[widget.field] : undefined;
    const fieldTs = info ? info.ts : null;
    const unit = widget.config && widget.config.unit ? widget.config.unit : '';
    const q = (role) => card.querySelector(`[data-role="${role}"]`);

    // The device name shows only on the "all devices" view, where tiles from several boards mix
    const deviceEl = q('device');
    if (deviceEl) deviceEl.textContent = !state.filter && device ? device.name : '';

    if (widget.type === 'label') return;

    if (widget.type === 'image') {
      const cfg = widget.config || {};
      const a = q('img-a');
      const b = q('img-b');
      const urlOf = (slot, v) => `/api/widgets/${widget.id}/image?slot=${slot}&v=${v}`;
      if (cfg.imgA && a.dataset.v !== String(cfg.imgA)) { a.src = urlOf('a', cfg.imgA); a.dataset.v = String(cfg.imgA); }
      if (!cfg.imgA) { a.removeAttribute('src'); a.dataset.v = ''; }
      if (cfg.imgB && b.dataset.v !== String(cfg.imgB)) { b.src = urlOf('b', cfg.imgB); b.dataset.v = String(cfg.imgB); }
      if (!cfg.imgB) { b.removeAttribute('src'); b.dataset.v = ''; }
      // The second picture shows while the linked field is on
      let on = false;
      if (cfg.stateField && device) {
        const f = device.fields && device.fields[cfg.stateField];
        const v = f ? f.value : device.latest ? device.latest[cfg.stateField] : undefined;
        on = v === true || (typeof v === 'number' && v > 0);
      }
      const showB = Boolean(cfg.imgB) && on;
      b.classList.toggle('show', showB);
      a.classList.toggle('show', Boolean(cfg.imgA) && !showB);
      q('img-empty').hidden = Boolean(cfg.imgA || cfg.imgB);
      return;
    }

    const stamp = q('updated');
    if (stamp) stamp.dataset.ts = fieldTs ? String(fieldTs) : '';

    if (widget.type === 'value') {
      setNumber(q('value'), raw);
      q('unit').textContent = typeof raw === 'number' ? unit : '';
    }

    if (widget.type === 'text') {
      q('value').textContent = raw === undefined ? t('waiting_data') : String(raw);
      q('unit').textContent = typeof raw === 'number' ? unit : '';
    }

    if (widget.type === 'slider') {
      const min = Number(widget.config.min ?? 0);
      const max = Number(widget.config.max ?? 100);
      const input = q('slider');
      const valueEl = q('value');
      input.min = String(min);
      input.max = String(max);
      const paint = () => input.style.setProperty('--p', `${(((Number(input.value) - min) / (max - min || 1)) * 100).toFixed(1)}%`);
      // Keep the thumb where the user drags it until they let go
      if (!input.dataset.dragging) {
        input.value = String(typeof raw === 'number' ? raw : min);
        paint();
        valueEl.textContent = typeof raw === 'number' ? `${formatValue(raw)} ${unit}`.trim() : t('not_set_yet');
      }
      if (!input.dataset.bound) {
        input.dataset.bound = '1';
        input.addEventListener('input', () => {
          input.dataset.dragging = '1';
          paint();
          valueEl.textContent = `${input.value} ${unit}`.trim();
        });
        input.addEventListener('change', async () => {
          delete input.dataset.dragging;
          buzz(8);
          try {
            await sendCommand(widget.deviceId, widget.field, Number(input.value));
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      }
    }

    if (widget.type === 'gauge') {
      const min = Number(widget.config.min ?? 0);
      const max = Number(widget.config.max ?? 100);
      const num = typeof raw === 'number' ? raw : min;
      const pct = Math.min(1, Math.max(0, (num - min) / (max - min || 1)));
      const arc = 2 * Math.PI * 80 * 0.75;
      q('fill').setAttribute('stroke-dashoffset', String(arc * (1 - pct)));
      setNumber(q('gv'), raw);
      q('gu').textContent = unit;
    }

    if (widget.type === 'bar') {
      const min = Number(widget.config.min ?? 0);
      const max = Number(widget.config.max ?? 100);
      const num = typeof raw === 'number' ? raw : min;
      const pct = Math.min(1, Math.max(0, (num - min) / (max - min || 1)));
      q('bar').style.width = `${(pct * 100).toFixed(1)}%`;
      setNumber(q('value'), raw);
      q('unit').textContent = typeof raw === 'number' ? unit : '';
    }

    if (widget.type === 'indicator') {
      const on = raw === true || (typeof raw === 'number' && raw > 0);
      q('lamp').classList.toggle('on', on);
      card.classList.toggle('on', on);
      q('state').textContent = raw === undefined ? t('waiting_data') : on ? t('on') : t('off');
    }

    if (widget.type === 'line') {
      const points = (state.history.get(widget.deviceId) || [])
        .map((r) => r.data[widget.field])
        .filter((v) => typeof v === 'number');
      setNumber(q('value'), raw);
      q('unit').textContent = typeof raw === 'number' ? unit : '';
      const { line, area } = sparkPaths(points);
      q('line').setAttribute('d', line);
      q('area').setAttribute('d', area);
    }

    if (widget.type === 'toggle') {
      const pend = state.pending.get(widget.id);
      let on = Boolean(raw);
      if (pend) {
        if (pend.value === Boolean(raw) || Date.now() > pend.until) state.pending.delete(widget.id);
        else on = pend.value;
      }
      const sw = q('switch');
      sw.setAttribute('aria-checked', String(on));
      card.classList.toggle('on', on);
      // A switch shows the last value set from the dashboard. It does not wait for the board.
      q('state').textContent = raw === undefined && !pend ? t('not_set_yet') : on ? t('on') : t('off');
      if (!sw.dataset.bound) {
        sw.dataset.bound = '1';
        sw.addEventListener('click', () => toggleControl(widget, card));
      }
    }

    if (widget.type === 'button') {
      const btn = q('pulse');
      if (!btn.dataset.bound) {
        btn.dataset.bound = '1';
        bindHoldButton(widget, btn);
      }
    }

    // Each tile shows when its own value last changed, its average gap, and a warning after 15 minutes
    // Buttons and switches the dashboard sends have no time until they have been used
    if (stamp) {
      if (widget.type === 'button' || (INPUT_GADGETS.includes(widget.type) && !fieldTs)) {
        stamp.dataset.ts = '';
        stamp.textContent = '';
      } else {
        // Switches are sent by the dashboard, so an average gap only means something for values the board sends
        const avg = INPUT_GADGETS.includes(widget.type) ? 0 : state.intervals.get(widget.deviceId)?.[widget.field];
        stamp.dataset.avg = avg ? String(avg) : '';
        stamp.textContent = stampText(fieldTs, avg);
        const stale = fieldTs && Date.now() - fieldTs > 15 * 60 * 1000;
        stamp.classList.toggle('stale', Boolean(stale));
        stamp.title = stale ? t('stale_note') : '';
      }
    }
  }

  // ---------- Edit mode: drag to reorder, drag the corner to resize ----------

  function setStudio(on) {
    state.studio = Boolean(on);
    $('grid').classList.toggle('editing', state.studio);
    $('studio-bar').classList.toggle('hidden', !state.studio);
    for (const id of ['edit-layout', 'tab-edit']) {
      const el = $(id);
      if (el) el.setAttribute('aria-pressed', String(state.studio));
    }
    if (state.studio) buzz(10);
    else saveLayoutNow();
  }

  let layoutTimer = null;
  function queueLayoutSave() {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(saveLayoutNow, 600);
  }

  async function saveLayoutNow() {
    clearTimeout(layoutTimer);
    const items = state.widgets.map((w, i) => {
      const [cw, ch] = tileSize(w);
      return { id: w.id, position: i, w: cw, h: ch };
    });
    if (!items.length) return;
    try {
      await api('/api/widgets/layout', { method: 'PUT', body: JSON.stringify({ items }) });
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Put the visible tiles into the order they now have on screen
  function adoptDomOrder() {
    const ids = [...$('grid').querySelectorAll('.tile')].map((el) => el.dataset.id);
    const shown = new Set(ids);
    const byId = new Map(state.widgets.map((w) => [w.id, w]));
    const queue = ids.map((id) => byId.get(id)).filter(Boolean);
    state.widgets = state.widgets.map((w) => (shown.has(w.id) ? queue.shift() : w));
  }

  let activeDrag = null;

  function bindTileEditing(card, widget) {
    // Moving: with a mouse, drag at once; with a finger, press and hold for a moment first
    card.addEventListener('pointerdown', (event) => {
      if (!state.studio || event.button > 0) return;
      if (event.target.closest('.edit-ui button')) return;
      beginDrag(card, widget, event);
    });
    const handle = card.querySelector('.e-resize');
    handle.addEventListener('pointerdown', (event) => {
      if (!state.studio) return;
      event.stopPropagation();
      event.preventDefault();
      beginResize(card, widget, event);
    });
  }

  function beginDrag(card, widget, event) {
    if (activeDrag) return;
    const grid = $('grid');
    const touch = event.pointerType === 'touch' || event.pointerType === 'pen';
    const startX = event.clientX;
    const startY = event.clientY;
    const grab = { x: 0, y: 0 };
    let started = false;
    let holdTimer = null;
    const pointerId = event.pointerId;

    const start = () => {
      started = true;
      const r = card.getBoundingClientRect();
      grab.x = startX - r.left;
      grab.y = startY - r.top;
      card.classList.add('dragging');
      try { card.setPointerCapture(pointerId); } catch {}
      buzz(15);
      activeDrag = { card, move };
    };

    const place = (px, py) => {
      card.style.transform = 'none';
      const natural = card.getBoundingClientRect();
      card.style.transform = `translate(${px - grab.x - natural.left}px, ${py - grab.y - natural.top}px)`;
    };

    function move(ev) {
      if (ev.pointerId !== pointerId) return;
      if (!started) {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (!touch && dist > 5) start();
        else if (touch && dist > 9) cancel(); // the finger is scrolling, not dragging
        if (!started) return;
      }
      ev.preventDefault();
      place(ev.clientX, ev.clientY);
      // Near the top or bottom edge, scroll the page
      if (ev.clientY < 90) window.scrollBy(0, -14);
      else if (ev.clientY > window.innerHeight - 110) window.scrollBy(0, 14);

      // Which tile is under the finger? Swap places with it
      const under = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el.classList && el.classList.contains('tile') && el !== card);
      if (!under) return;
      const tiles = [...grid.querySelectorAll('.tile')];
      const first = new Map(tiles.map((el) => [el, el.getBoundingClientRect()]));
      const before = tiles.indexOf(card) < tiles.indexOf(under);
      grid.insertBefore(card, before ? under.nextSibling : under);
      for (const el of tiles) {
        if (el === card) continue;
        const a = first.get(el);
        const b = el.getBoundingClientRect();
        const dx = a.left - b.left;
        const dy = a.top - b.top;
        if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
      place(ev.clientX, ev.clientY);
    }

    function cancel() {
      clearTimeout(holdTimer);
      cleanup();
    }

    function cleanup() {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
    }

    function up(ev) {
      if (ev.pointerId !== pointerId) return;
      clearTimeout(holdTimer);
      cleanup();
      // A tap without dragging opens the tile's settings
      if (!started) {
        if (ev.type === 'pointerup' && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) openEditWidget(widget);
        return;
      }
      activeDrag = null;
      // Settle into the slot
      const from = card.getBoundingClientRect();
      card.style.transform = 'none';
      const to = card.getBoundingClientRect();
      card.classList.remove('dragging');
      card.animate(
        [{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`, scale: 1.04 }, { transform: 'none', scale: 1 }],
        { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' },
      );
      card.style.transform = '';
      adoptDomOrder();
      queueLayoutSave();
    }

    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
    if (touch) holdTimer = setTimeout(start, 280);
  }

  // While a tile is being dragged with a finger, the page must not scroll under it
  document.addEventListener('touchmove', (e) => { if (activeDrag) e.preventDefault(); }, { passive: false });

  function beginResize(card, widget, event) {
    const grid = $('grid');
    const rtl = document.documentElement.dir === 'rtl';
    const cs = getComputedStyle(grid);
    const cols = cs.gridTemplateColumns.split(' ').length;
    const gap = parseFloat(cs.columnGap) || 10;
    const row = parseFloat(cs.gridAutoRows) || 86;
    const k = parseFloat(cs.getPropertyValue('--k')) || 1;
    const colW = (grid.clientWidth - gap * (cols - 1)) / cols;
    const stepX = (colW + gap) * k;
    const stepY = row + gap;
    const [w0, h0] = tileSize(widget);
    const x0 = event.clientX;
    const y0 = event.clientY;
    const pointerId = event.pointerId;
    card.classList.add('resizing');
    activeDrag = { card };
    buzz(10);

    const move = (ev) => {
      if (ev.pointerId !== pointerId) return;
      ev.preventDefault();
      const dx = (rtl ? -1 : 1) * (ev.clientX - x0);
      const w = Math.min(4, Math.max(1, w0 + Math.round(dx / stepX)));
      const hgt = Math.min(4, Math.max(1, h0 + Math.round((ev.clientY - y0) / stepY)));
      if (w !== tileSize(widget)[0] || hgt !== tileSize(widget)[1]) {
        widget.config = { ...(widget.config || {}), w, h: hgt };
        card.style.setProperty('--w', String(w));
        card.dataset.w = String(w);
        card.style.setProperty('--h', String(hgt));
        buzz(6);
      }
    };
    const up = (ev) => {
      if (ev.pointerId !== pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      card.classList.remove('resizing');
      activeDrag = null;
      queueLayoutSave();
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function sparkPaths(values) {
    if (values.length < 2) return { line: '', area: '' };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const W = 300, H = 86, pad = 8;
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = pad + (1 - (v - min) / span) * (H - pad * 2);
      return [x.toFixed(1), y.toFixed(1)];
    });
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    return { line, area };
  }

  // ---------- Controls ----------

  async function sendCommand(deviceId, field, value) {
    return api(`/api/devices/${deviceId}/command`, {
      method: 'POST',
      body: JSON.stringify({ field, value }),
    });
  }

  async function toggleControl(widget, card) {
    const sw = card.querySelector('[data-role="switch"]');
    const next = sw.getAttribute('aria-checked') !== 'true';
    // Hold the new state until the board reports it (about 10 s), so the switch does not flip back
    state.pending.set(widget.id, { value: next, until: Date.now() + 20000 });
    sw.setAttribute('aria-checked', String(next));
    card.classList.toggle('on', next);
    buzz(14);
    card.querySelector('[data-role="state"]').textContent = next ? t('on') : t('off');
    try {
      await sendCommand(widget.deviceId, widget.field, next);
    } catch (err) {
      state.pending.delete(widget.id);
      toast(err.message, 'error');
      updateWidgetCard(card, widget);
    }
  }

  // A button works like a real one. Pressing sends on once, releasing sends off once.
  // Nothing is sent while it stays pressed.
  function bindHoldButton(widget, btn) {
    let held = false;
    // Sends one after another, so the release can never overtake the press
    let queue = Promise.resolve();
    const send = (value) => {
      queue = queue
        .then(() => sendCommand(widget.deviceId, widget.field, value))
        .catch((err) => toast(err.message, 'error'));
    };
    btn.addEventListener('pointerdown', (event) => {
      if (held) return;
      held = true;
      btn.setPointerCapture(event.pointerId);
      btn.classList.add('held');
      send(true);
    });
    const release = () => {
      if (!held) return;
      held = false;
      btn.classList.remove('held');
      send(false);
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // ---------- Live connections ----------

  function connectDevice(deviceId) {
    if (state.sockets.has(deviceId)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/view/${deviceId}`);
    state.sockets.set(deviceId, ws);

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      const device = state.devices.get(deviceId);
      if (!device) return;
      // The board applied a command: show it now, before its next report
      if (msg.type === 'ack') {
        device.online = true;
        if (!device.onlineSince) device.onlineSince = Date.now();
        device.latest = { ...(device.latest || {}), [msg.field]: msg.value };
        device.fields = { ...(device.fields || {}), [msg.field]: { value: msg.value, ts: msg.ts || Date.now() } };
        refreshDevice(deviceId);
        return;
      }
      // The board connected to the dashboard
      if (msg.type === 'hello') {
        device.online = true;
        if (!device.onlineSince) device.onlineSince = Date.now();
        renderSidebar();
        renderStats();
        return;
      }
      if (msg.type !== 'reading' || !msg.data) return;
      device.online = true;
      if (!device.onlineSince) device.onlineSince = msg.ts || Date.now();
      device.latest = msg.data;
      // Each value keeps its own time, so a gadget that did not change keeps its old time
      device.fields = { ...(device.fields || {}) };
      for (const [name, value] of Object.entries(msg.data)) {
        device.fields[name] = { value, ts: msg.ts };
      }
      device.lastSeen = msg.ts;
      const hist = state.history.get(deviceId) || [];
      hist.push({ ts: msg.ts, data: msg.data });
      if (hist.length > 60) hist.splice(0, hist.length - 60);
      state.history.set(deviceId, hist);
      refreshDevice(deviceId);
    });

    ws.addEventListener('close', () => {
      state.sockets.delete(deviceId);
      // Reconnect while the device is still on the dashboard
      if (state.devices.has(deviceId)) setTimeout(() => connectDevice(deviceId), 3000);
    });
  }

  function refreshDevice(deviceId) {
    for (const widget of state.widgets) {
      if (widget.deviceId !== deviceId) continue;
      const card = state.cards.get(widget.id);
      if (card) updateWidgetCard(card, widget);
    }
    renderSidebar();
    renderStats();
  }

  // ---------- Data loading ----------

  async function loadHistory(deviceId) {
    const { readings } = await api(`/api/devices/${deviceId}/readings?limit=60`);
    state.history.set(deviceId, readings);
  }

  async function refreshAll() {
    const [{ devices }, { widgets }] = await Promise.all([api('/api/devices'), api('/api/widgets')]);
    state.devices = new Map(devices.map((d) => [d.id, d]));
    state.widgets = widgets;

    const lineDevices = new Set(widgets.filter((w) => w.type === 'line').map((w) => w.deviceId));
    await Promise.all([...lineDevices].map((id) => loadHistory(id).catch(() => {})));

    for (const widget of widgets) connectDevice(widget.deviceId);
    renderAll();
    revealSelected();
  }

  function renderAll() {
    renderGreeting();
    renderSidebar();
    renderStats();
    renderFilters();
    renderGrid();
    updateTimestamps();
  }

  // The stamp text, with the average gap when there is one. Used by both the card update and the 1 s refresh.
  function stampText(ts, avg) {
    let text = ts ? t('updated_ago', { t: timeAgo(ts) }) : t('waiting_first');
    if (avg) text += ` · ${t('avg_every', { s: (avg / 1000).toFixed(1) })}`;
    return text;
  }

  function updateTimestamps() {
    document.querySelectorAll('[data-role="updated"][data-ts]').forEach((el) => {
      const ts = Number(el.dataset.ts);
      if (ts) el.textContent = stampText(ts, Number(el.dataset.avg));
    });
  }

  // ---------- Add / remove ----------

  // The add form, reused for editing: device, data field and gadget type are fixed then
  let editingWidget = null;

  function setEditMode(editing) {
    for (const el of [$('widget-device'), $('gadget-grid')]) {
      el.closest('.field').hidden = editing;
    }
    $('widget-title').textContent = editing ? t('edit_widget_title') : t('add_widget_title');
    $('widget-lead').textContent = editing ? t('edit_widget_lead') : t('add_widget_lead');
    $('widget-submit').textContent = editing ? t('save_widget') : t('add_widget_submit');
  }

  function openEditWidget(widget) {
    editingWidget = widget;
    setEditMode(true);
    $('widget-device').value = widget.deviceId;
    populateFieldOptions();
    $('widget-type').value = widget.type;
    $('widget-field').value = widget.field;
    $('widget-title-input').value = widget.title || '';
    $('widget-unit').value = (widget.config && widget.config.unit) || '';
    $('widget-min').value = String(widget.config && widget.config.min !== undefined ? widget.config.min : 0);
    $('widget-max').value = String(widget.config && widget.config.max !== undefined ? widget.config.max : 100);
    const cfg = widget.config || {};
    pickedIcon = cfg.icon || '';
    pickedAccent = cfg.accent || '';
    paintRecvButton(widget);
    $('widget-sub').value = cfg.sub || '';
    $('widget-fit').value = cfg.fit || 'cover';
    $('widget-statefield').value = cfg.stateField || '';
    syncWidgetFormType();
    renderImagePreviews(widget);
    $('widget-error').textContent = '';
    openModal('widget-modal');
  }

  function openWidgetModal() {
    if (state.devices.size === 0) {
      toast(t('add_device_first'), 'error');
      openModal('device-modal');
      return;
    }
    editingWidget = null;
    pickedIcon = '';
    pickedAccent = '';
    $('widget-sub').value = '';
    $('widget-fit').value = 'cover';
    $('widget-statefield').value = '';
    $('recv-field').hidden = true;
    setEditMode(false);
    const select = $('widget-device');
    select.replaceChildren(...[...state.devices.values()].map((d) => h('option', { value: d.id, text: d.name })));
    if (state.filter) select.value = state.filter;
    populateFieldOptions();
    renderGadgetGrid();
    syncWidgetFormType();
    $('widget-error').textContent = '';
    openModal('widget-modal');
  }

  function populateFieldOptions() {
    const device = state.devices.get($('widget-device').value);
    const list = $('field-options');
    list.replaceChildren(...Object.keys((device && device.latest) || {}).map((k) => h('option', { value: k })));
  }

  // ---------- Gadget picker ----------

  // Input gadgets send commands to the board. Output gadgets only show readings.
  const INPUT_GADGETS = ['toggle', 'button', 'slider'];
  const OUTPUT_GADGETS = ['value', 'text', 'gauge', 'bar', 'line', 'indicator'];
  const DECOR_GADGETS = ['image', 'label'];

  // Small drawings of each gadget. They move a little so the choice is easy to see.
  function gadgetArt(type) {
    const svg = (...children) => s('svg', { class: 'gadget-art', viewBox: '0 0 120 64', 'aria-hidden': 'true' }, ...children);
    if (type === 'value') {
      return svg(
        s('text', { class: 'art-num', x: 60, y: 38, 'text-anchor': 'middle' }, '24.5'),
        s('text', { class: 'art-sub', x: 60, y: 54, 'text-anchor': 'middle' }, '°C'),
      );
    }
    if (type === 'text') {
      return svg(
        s('text', { class: 'art-num', x: 60, y: 36, 'text-anchor': 'middle' }, 'Hello'),
        s('text', { class: 'art-sub', x: 60, y: 54, 'text-anchor': 'middle' }, 'status: ok'),
      );
    }
    if (type === 'slider') {
      return svg(
        s('rect', { class: 'art-bar-track', x: 14, y: 28, width: 92, height: 8, rx: 4 }),
        s('circle', { class: 'art-knob', cx: 28, cy: 32, r: 9 }),
      );
    }
    if (type === 'gauge') {
      const dash = `${2 * Math.PI * 40 * 0.75} ${2 * Math.PI * 40}`;
      return svg(
        s('circle', { class: 'art-track', cx: 60, cy: 52, r: 40, fill: 'none', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-dasharray': dash, transform: 'rotate(135 60 52)' }),
        s('circle', { class: 'art-fill', cx: 60, cy: 52, r: 40, fill: 'none', 'stroke-width': 8, 'stroke-linecap': 'round', 'stroke-dasharray': dash, transform: 'rotate(135 60 52)' }),
      );
    }
    if (type === 'line') {
      return svg(
        s('path', { class: 'art-line', pathLength: 1, d: 'M8 46 L26 34 L44 40 L62 22 L80 30 L98 16 L112 24', fill: 'none', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      );
    }
    if (type === 'toggle') {
      return svg(
        s('rect', { class: 'art-pill', x: 30, y: 20, width: 60, height: 30, rx: 15 }),
        s('circle', { class: 'art-knob', cx: 45, cy: 35, r: 11 }),
      );
    }
    if (type === 'bar') {
      return svg(
        s('rect', { class: 'art-bar-track', x: 14, y: 26, width: 92, height: 14, rx: 7 }),
        s('rect', { class: 'art-bar-fill', x: 14, y: 26, width: 92, height: 14, rx: 7 }),
      );
    }
    if (type === 'indicator') {
      return svg(
        s('circle', { class: 'art-lamp-glow', cx: 60, cy: 32, r: 22 }),
        s('circle', { class: 'art-lamp', cx: 60, cy: 32, r: 14 }),
      );
    }
    if (type === 'image') {
      return svg(
        s('rect', { class: 'art-bar-track', x: 22, y: 8, width: 76, height: 48, rx: 8 }),
        s('path', { class: 'art-line', d: 'M28 48 L50 28 L64 40 L74 32 L92 48', fill: 'none', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        s('circle', { class: 'art-knob', cx: 80, cy: 20, r: 5 }),
      );
    }
    if (type === 'label') {
      return svg(
        s('text', { class: 'art-num', x: 60, y: 34, 'text-anchor': 'middle' }, 'Aa'),
        s('rect', { class: 'art-bar-track', x: 20, y: 46, width: 80, height: 3, rx: 1.500 }),
      );
    }
    return svg(s('rect', { class: 'art-btn', x: 28, y: 20, width: 64, height: 30, rx: 15 }));
  }

  function renderGadgetGrid() {
    const current = $('widget-type').value;
    const card = (type) => h(
      'button',
      { class: 'gadget-card', type: 'button', role: 'radio', 'aria-checked': String(type === current), 'data-type': type, onclick: () => selectGadget(type) },
      gadgetArt(type),
      h('span', { class: 'gadget-name', text: t(`type_${type}`) }),
    );
    $('gadget-grid').replaceChildren(
      h('p', { class: 'gadget-group', text: t('group_input') }),
      ...INPUT_GADGETS.map(card),
      h('p', { class: 'gadget-group', text: t('group_output') }),
      ...OUTPUT_GADGETS.map(card),
      h('p', { class: 'gadget-group', text: t('group_decor') }),
      ...DECOR_GADGETS.map(card),
    );
  }

  function selectGadget(type) {
    $('widget-type').value = type;
    for (const card of $('gadget-grid').querySelectorAll('.gadget-card')) {
      card.setAttribute('aria-checked', String(card.dataset.type === type));
    }
    syncWidgetFormType();
  }

  // Look pickers in the widget form
  let pickedIcon = '';
  let pickedAccent = '';

  function renderLookPickers() {
    const type = $('widget-type').value;
    const current = pickedIcon || DEFAULT_ICON[type] || 'dot';
    $('icon-grid').replaceChildren(...PICKABLE_ICONS.map((name) => h(
      'button',
      {
        class: 'icon-btn', type: 'button', role: 'radio', 'aria-checked': String(name === current), title: name,
        onclick: () => { pickedIcon = name; renderLookPickers(); },
      },
      iconSvg(name),
    )));
    const colors = ['', ...TILE_COLORS];
    $('accent-swatches').replaceChildren(...colors.map((color) => h('button', {
      class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(color === pickedAccent),
      style: `--swatch:${color || 'linear-gradient(135deg,#7c8cff,#3ee3b5)'};`,
      'aria-label': color || 'default',
      onclick: () => { pickedAccent = color; renderLookPickers(); },
    })));
  }

  function syncWidgetFormType() {
    const type = $('widget-type').value;
    const decor = DECOR_GADGETS.includes(type);
    $('gauge-range').hidden = !['gauge', 'bar', 'slider'].includes(type);
    $('widget-unit').closest('.field').hidden = ['toggle', 'button', 'indicator'].includes(type) || decor;
    // Pictures and headings are not tied to a value from the board
    $('widget-field').closest('.field').hidden = decor;
    $('image-section').hidden = type !== 'image' || !editingWidget;
    $('label-section').hidden = type !== 'label';
    $('widget-sub').closest('.field').hidden = type !== 'label';
    $('look-section').hidden = type === 'image';
    renderLookPickers();
  }

  // Receiving on/off lives in the tile's settings
  function paintRecvButton(widget) {
    const field = $('recv-field');
    field.hidden = !OUTPUT_GADGETS.includes(widget.type);
    const on = !(widget.config && widget.config.receive === false);
    $('recv-btn').textContent = on ? t('receiving_on') : t('receiving_off');
    $('recv-btn').setAttribute('aria-pressed', String(on));
  }

  function renderImagePreviews(widget) {
    const cfg = (widget && widget.config) || {};
    for (const [slot, v] of [['a', cfg.imgA], ['b', cfg.imgB]]) {
      const box = $(`img-prev-${slot}`);
      box.style.backgroundImage = v ? `url("/api/widgets/${widget.id}/image?slot=${slot}&v=${v}")` : '';
      box.textContent = v ? '' : '—';
      $(`img-rm-${slot}`).hidden = !v;
    }
  }

  // Phone photos are big. Shrink them in the browser before they are sent.
  async function shrinkImage(file, maxSide = 1600) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const q of [0.86, 0.72, 0.58]) {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
      if (blob && blob.size <= 1.9 * 1024 * 1024) return blob;
    }
    throw new Error(t('image_too_big'));
  }

  async function uploadTileImage(slot, file) {
    if (!editingWidget || !file) return;
    try {
      const blob = await shrinkImage(file);
      const res = await fetch(`/api/widgets/${editingWidget.id}/image?slot=${slot}`, {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'image/jpeg' }, body: blob,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || t('request_failed'));
      editingWidget.config = { ...(editingWidget.config || {}), ...body.config };
      renderImagePreviews(editingWidget);
      renderAll();
    } catch (err) {
      $('widget-error').textContent = err.message;
    }
  }

  async function removeTileImage(slot) {
    if (!editingWidget) return;
    try {
      const body = await api(`/api/widgets/${editingWidget.id}/image?slot=${slot}`, { method: 'DELETE' });
      editingWidget.config = { ...(editingWidget.config || {}), ...body.config };
      delete editingWidget.config[slot === 'b' ? 'imgB' : 'imgA'];
      renderImagePreviews(editingWidget);
      renderAll();
    } catch (err) {
      $('widget-error').textContent = err.message;
    }
  }

  async function submitWidget(event) {
    event.preventDefault();
    const errorEl = $('widget-error');
    errorEl.textContent = '';
    const type = $('widget-type').value;
    const decor = DECOR_GADGETS.includes(type);
    const field = decor ? '' : $('widget-field').value.trim();
    const payload = {
      deviceId: editingWidget ? editingWidget.deviceId : $('widget-device').value,
      type,
      field,
      title: $('widget-title-input').value.trim() || field,
      unit: $('widget-unit').value.trim(),
      min: Number($('widget-min').value),
      max: Number($('widget-max').value),
      icon: pickedIcon,
      accent: pickedAccent,
      sub: $('widget-sub').value.trim(),
      fit: $('widget-fit').value,
      stateField: $('widget-statefield').value.trim(),
    };
    if (!decor && !/^[a-zA-Z0-9_]{1,32}$/.test(field)) {
      errorEl.textContent = t('field_invalid');
      return;
    }
    if (['gauge', 'bar', 'slider'].includes(type) && !(payload.max > payload.min)) {
      errorEl.textContent = t('gauge_range');
      return;
    }
    if (editingWidget) {
      try {
        const { field: savedField, title, config } = await api(`/api/widgets/${editingWidget.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        Object.assign(editingWidget, { field: savedField, title, config });
        closeModal($('widget-modal'));
        renderAll();
        toast(t('widget_saved'));
      } catch (err) {
        errorEl.textContent = err.message;
      }
      return;
    }
    try {
      const { widget } = await api('/api/widgets', { method: 'POST', body: JSON.stringify(payload) });
      state.widgets.push(widget);
      if (!state.history.has(widget.deviceId) && widget.type === 'line') await loadHistory(widget.deviceId).catch(() => {});
      connectDevice(widget.deviceId);
      closeModal($('widget-modal'));
      $('widget-form').reset();
      $('widget-min').value = '0';
      $('widget-max').value = '100';
      renderAll();
      toast(t('widget_added'));
      // A picture tile starts empty: open it so the photo can be chosen right away
      if (widget.type === 'image') setTimeout(() => openEditWidget(widget), 250);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  // Switches a widget's receiving on or off. Off: its values are not kept and the board stops sending them.
  async function toggleReceiving(widget) {
    const next = widget.config && widget.config.receive === false;  // currently off, so turn it on
    try {
      await api(`/api/widgets/${widget.id}/receiving`, { method: 'PUT', body: JSON.stringify({ on: next }) });
      const config = { ...(widget.config || {}) };
      if (next) delete config.receive;
      else config.receive = false;
      widget.config = config;
      renderAll();
      toast(next ? t('receiving_started') : t('receiving_stopped'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeWidget(widget) {
    if (!confirm(t('confirm_remove_widget', { name: widget.title || widget.field }))) return;
    try {
      await api(`/api/widgets/${widget.id}`, { method: 'DELETE' });
      state.widgets = state.widgets.filter((w) => w.id !== widget.id);
      renderAll();
      toast(t('widget_removed'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function removeDevice(device) {
    if (!confirm(t('confirm_delete', { name: device.name }))) return;
    try {
      await api(`/api/devices/${device.id}`, { method: 'DELETE' });
      state.devices.delete(device.id);
      state.widgets = state.widgets.filter((w) => w.deviceId !== device.id);
      const ws = state.sockets.get(device.id);
      state.sockets.delete(device.id);
      if (ws) ws.close();
      if (state.filter === device.id) state.filter = null;
      renderAll();
      toast(t('device_deleted'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function submitDevice(event) {
    event.preventDefault();
    const name = $('device-name').value.trim();
    const errorEl = $('device-error');
    errorEl.textContent = '';
    if (name.length < 2) {
      errorEl.textContent = t('name_short');
      return;
    }
    try {
      const { device, key } = await api('/api/devices', { method: 'POST', body: JSON.stringify({ name }) });
      state.devices.set(device.id, { id: device.id, name: device.name, latest: null, lastSeen: null, online: false });
      $('device-step-1').classList.add('hidden');
      $('device-step-2').classList.remove('hidden');
      $('device-key').textContent = key;
      newDevice = { id: device.id, key };
      $('setup-name-row').hidden = true;
      $('copy-key').disabled = false;
      $('device-snippet').textContent = buildSnippet(key, 'send');
      $('test-hint').textContent = t('test_send_hint');
      renderAll();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  // Code stays in English so it can be copied as-is into the Arduino IDE.
  // Test send: the board sends a temperature. Test write: the dashboard's LED switch controls the board.
  function buildSnippet(key, mode) {
    const common = [
      '/*',
      '  IoTDeck: free dashboards for ESP32 projects.',
      '',
      mode === 'send'
        ? '  Test send: the board sends a temperature only when it moves by 0.5 °C, at most every 5 minutes.'
        : '  Test write: the dashboard\'s LED switch turns the board\'s built-in LED on or off.',
      '  Fill in the Wi-Fi name and password, then upload the sketch.',
      '*/',
      '',
      '#include <IoTDeck.h>                                 // The IoTDeck library',
      '',
    ];
    const setup = [
      'void setup() {',
      // digitalWrite only changes a pin that is set to output first
      ...(mode === 'write' ? ['  pinMode(LED_BUILTIN, OUTPUT);'] : []),
      '  // Connects to Wi-Fi and to the dashboard.',
      `  IoTDeck.begin("${key}", "Wi-Fi name", "Wi-Fi password");`,
      '}',
      '',
    ];
    if (mode === 'send') {
      return [
        ...common,
        ...setup,
        'void loop() {',
        '  // Simulated slow drift between 20.5 and 24.5 °C. Replace with your sensor reading.',
        '  float temperature = 22.5 + 2.0 * sin(millis() / 300000.0);',
        '',
        '  // Sends when the value has moved by at least 0.5 °C, at most every 300 seconds (5 minutes).',
        '  // Use IoTDeck.sendEvery("TEMPERATURE", temperature, 60) to send every 60 seconds whatever the value does.',
        '  IoTDeck.send("TEMPERATURE", temperature, 0.5, 300);',
        '}',
      ].join('\n');
    }
    return [
      ...common,
      '// Runs when the dashboard\'s LED switch changes. value is 1 when on, 0 when off.',
      'IOTDECK_WRITE(LED) {',
      '  digitalWrite(LED_BUILTIN, value);',
      '}',
      '',
      ...setup,
      'void loop() {',
      '  // Nothing to do here. The library works in the background.',
      '}',
    ].join('\n');
  }

  // The device just created, so the test buttons know which device to use
  let newDevice = null;

  // Creates the matching gadget on the new device, so the test works straight away
  async function chooseTest(mode) {
    if (!newDevice) return;
    $('device-snippet').textContent = buildSnippet(newDevice.key || 'your-device-key', mode);
    $('test-hint').textContent = t(mode === 'send' ? 'test_send_hint' : 'test_write_hint');
    const body = mode === 'send'
      ? { deviceId: newDevice.id, type: 'value', field: 'TEMPERATURE', title: 'Temperature', unit: '°C', min: 0, max: 100 }
      : { deviceId: newDevice.id, type: 'toggle', field: 'LED', title: 'LED', unit: '', min: 0, max: 100 };
    const exists = state.widgets.some((w) => w.deviceId === newDevice.id && w.field === body.field);
    if (exists) return;
    try {
      const { widget } = await api('/api/widgets', { method: 'POST', body: JSON.stringify(body) });
      state.widgets.push(widget);
      connectDevice(widget.deviceId);
      renderAll();
      toast(t('test_widget_added'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Reopens the setup of an existing device: its ID, the code, and a new key if needed.
  // The key itself is only shown once when the device is created, so it is not shown again here.
  function openSetup(deviceId) {
    const device = state.devices.get(deviceId);
    newDevice = { id: deviceId, key: null };
    $('device-step-1').classList.add('hidden');
    $('device-step-2').classList.remove('hidden');
    $('setup-name-row').hidden = false;
    $('setup-name').value = device ? device.name : '';
    $('setup-id').textContent = deviceId;
    $('device-key').textContent = t('key_not_shown');
    $('copy-key').disabled = true;
    $('device-snippet').textContent = buildSnippet('PASTE_YOUR_DEVICE_KEY', 'send');
    $('test-hint').textContent = t('setup_reopen_hint', { name: device ? device.name : '' });
    openModal('device-modal');
  }

  // Renames the device. The name is shown everywhere on the dashboard.
  async function saveDeviceName() {
    const name = $('setup-name').value.trim();
    if (name.length < 2) {
      toast(t('name_short'), 'error');
      return;
    }
    try {
      const { device } = await api(`/api/devices/${newDevice.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      const cur = state.devices.get(device.id);
      if (cur) cur.name = device.name;
      renderAll();
      toast(t('name_saved'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // A new key for this device. The old key stops working.
  async function rotateKey() {
    if (!newDevice) return;
    if (!confirm(t('rotate_confirm'))) return;
    try {
      const { key } = await api(`/api/devices/${newDevice.id}/rotate-key`, { method: 'POST' });
      newDevice.key = key;
      $('copy-key').disabled = false;
      $('device-key').textContent = key;
      $('device-snippet').textContent = buildSnippet(key, 'send');
      toast(t('rotate_done'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // Average gap between received values, per device and per value, from the last 60 readings
  state.intervals = new Map();
  async function loadIntervals() {
    for (const device of state.devices.values()) {
      try {
        const { readings } = await api(`/api/devices/${device.id}/readings?limit=60`);
        const perField = {};
        for (const r of readings) {
          for (const name of Object.keys(r.data)) {
            (perField[name] ||= []).push(r.ts);
          }
        }
        const averages = {};
        for (const [name, times] of Object.entries(perField)) {
          const gaps = [];
          for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
          if (gaps.length) averages[name] = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        }
        state.intervals.set(device.id, averages);
      } catch {
        // Averages are optional
      }
    }
    for (const widget of state.widgets) {
      const card = state.cards.get(widget.id);
      if (card) updateWidgetCard(card, widget);
    }
  }

  // A board sent values that no widget shows. The notice appears on that device's page once for each event.
  // Dismissing it remembers the event on this browser.
  function showUnknownNotice(activity) {
    const box = $('unknown-notice');
    const device = state.filter ? state.devices.get(state.filter) : null;
    const event = device ? activity.find((a) => a.kind === 'unknown' && a.device_id === device.id) : null;
    let seen = 0;
    try { seen = Number(localStorage.getItem(`iotdeck-unknown-${device ? device.id : ''}`) || 0); } catch {}
    if (!event || event.ts <= seen) {
      box.classList.add('hidden');
      box.replaceChildren();
      return;
    }
    box.replaceChildren(
      h('p', { class: 'notice-text', text: t('unknown_notice', { name: device.name, fields: event.detail }) }),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'button', text: t('add_widget_cta'), onclick: () => { dismissUnknown(device.id, event.ts); openWidgetModal(); } }),
        h('button', { class: 'btn btn-ghost', type: 'button', text: t('dismiss_notice'), onclick: () => dismissUnknown(device.id, event.ts) }),
      ),
    );
    box.classList.remove('hidden');
  }

  function dismissUnknown(deviceId, ts) {
    try { localStorage.setItem(`iotdeck-unknown-${deviceId}`, String(ts)); } catch {}
    $('unknown-notice').classList.add('hidden');
  }

  // Activity: commands sent and sends refused, newest first. Refreshes by itself.
  async function loadActivity() {
    try {
      const { activity, retentionDays, readingsRetentionDays } = await api('/api/activity?limit=30');
      $('activity-note').textContent = t('activity_note', { n: retentionDays, r: readingsRetentionDays });
      const items = activity.map((a) => {
        const li = document.createElement('li');
        li.className = 'activity-item';
        const when = document.createElement('span');
        when.className = 'activity-time';
        when.textContent = timeAgo(a.ts);
        const kind = document.createElement('span');
        kind.className = `activity-kind ${a.kind}`;
        const label = { command: 'act_command', received: 'act_received', rejected: 'act_rejected', unknown: 'act_unknown' }[a.kind];
        kind.textContent = t(label || 'act_rejected');
        // The device name sits above the value, so the two never run together
        const text = document.createElement('div');
        text.className = 'activity-text';
        const device = state.devices.get(a.device_id);
        const name = document.createElement('span');
        name.className = 'activity-device';
        name.textContent = device ? device.name : a.device_id;
        const detail = document.createElement('span');
        detail.className = 'activity-detail';
        detail.textContent = a.detail;
        text.append(name, detail);
        li.append(when, kind, text);
        return li;
      });
      showUnknownNotice(activity);
      $('activity-list').replaceChildren(...(items.length ? items : [Object.assign(document.createElement('li'), { className: 'activity-empty', textContent: t('activity_empty') })]));
    } catch {
      // The activity list is optional
    }
  }

  // Daily usage: sends today against the limit
  // Refreshes by itself, so the admin's limit changes show without a page reload
  async function loadUsage() {
    try {
      const u = await api('/api/usage');
      const pct = u.limit > 0 ? Math.min(100, (u.used / u.limit) * 100) : 100;
      $('stat-usage').textContent = `${u.used.toLocaleString('en-US')} / ${u.limit.toLocaleString('en-US')}`;
      $('usage-fill').style.width = `${pct.toFixed(1)}%`;
      $('usage-fill').parentElement.setAttribute('aria-valuenow', String(Math.round(pct)));
      const card = $('stat-usage').parentElement;
      card.classList.toggle('warn', pct >= 80 && pct < 100);
      card.classList.toggle('full', pct >= 100);
      // Warn when the daily limit would run out within a day at the current rate (sends in the last 10 minutes)
      const remaining = Math.max(0, u.limit - u.used);
      const perMinute = u.recentSends / (u.windowMinutes || 10);
      const minutesLeft = perMinute > 0 ? remaining / perMinute : Infinity;
      let hint = card.querySelector('.usage-hint');
      if (!hint) {
        hint = document.createElement('div');
        hint.className = 'hint usage-hint';
        card.append(hint);
      }
      hint.textContent = remaining > 0 && minutesLeft < 24 * 60 ? t('usage_run_out', { time: formatMinutes(minutesLeft) }) : '';
    } catch {
      // Usage is shown only when available
    }
  }

  function formatMinutes(minutes) {
    const hours = Math.floor(minutes / 60);
    const rest = Math.round(minutes % 60);
    return hours ? `${hours} h ${rest} min` : `${rest} min`;
  }

  function copyText(text, label) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast(t('copied', { label })))
      .catch(() => toast(t('copy_failed'), 'error'));
  }

  function resetDeviceModal() {
    $('device-step-1').classList.remove('hidden');
    $('device-step-2').classList.add('hidden');
    $('device-form').reset();
    $('device-error').textContent = '';
    $('device-key').textContent = '';
  }

  // ---------- Boot ----------

  async function boot() {
    try {
      const { user } = await api('/api/me');
      state.user = user;
    } catch {
      return;
    }

    $('user-email').textContent = state.user.email;
    // The admin account gets a link to the admin page
    if ((state.user.email || '').toLowerCase() === 'admin@iotdeck.org') {
      $('logout').before(h('a', { class: 'btn btn-ghost btn-block', href: '/admin', text: 'Admin' }));
    }
    $('avatar').textContent = (state.user.name || state.user.email || '?').trim().charAt(0).toUpperCase();
    $('avatar-m').textContent = $('avatar').textContent;
    $('user-email-m').textContent = state.user.email;
    renderGreeting();

    // Studio: layout edit mode, and the phone tab bar
    $('edit-layout').addEventListener('click', () => setStudio(!state.studio));
    $('studio-done').addEventListener('click', () => setStudio(false));
    $('tab-edit').addEventListener('click', () => { setView('dash'); setStudio(!state.studio); });
    $('tab-add').addEventListener('click', () => { setView('dash'); openWidgetModal(); });
    document.querySelectorAll('#tabbar [data-view]').forEach((btn) => btn.addEventListener('click', () => { setView(btn.dataset.view); window.scrollTo({ top: 0 }); }));
    $('recv-btn').addEventListener('click', async () => {
      if (!editingWidget) return;
      await toggleReceiving(editingWidget);
      paintRecvButton(editingWidget);
    });
    $('logout-m').addEventListener('click', () => $('logout').click());
    $('grid').addEventListener('contextmenu', (e) => { if (state.studio) e.preventDefault(); });
    for (const slot of ['a', 'b']) {
      $(`img-file-${slot}`).addEventListener('change', (e) => { uploadTileImage(slot, e.target.files[0]); e.target.value = ''; });
      $(`img-rm-${slot}`).addEventListener('click', () => removeTileImage(slot));
    }

    $('add-device').addEventListener('click', () => { resetDeviceModal(); openModal('device-modal'); });
    $('add-device-2').addEventListener('click', () => { resetDeviceModal(); openModal('device-modal'); });
    $('add-widget').addEventListener('click', openWidgetModal);
    $('device-form').addEventListener('submit', submitDevice);
    $('copy-key').addEventListener('click', () => copyText($('device-key').textContent, t('key_label')));
    $('copy-code').addEventListener('click', () => copyText($('device-snippet').textContent, t('code_label')));
    $('rotate-key').addEventListener('click', rotateKey);
    $('save-name').addEventListener('click', saveDeviceName);
    $('test-send').addEventListener('click', () => chooseTest('send'));
    $('test-write').addEventListener('click', () => chooseTest('write'));
    $('widget-form').addEventListener('submit', submitWidget);
    loadUsage();
    setInterval(loadUsage, 10000);
    loadActivity();
    setInterval(loadActivity, 10000);
    loadIntervals();
    setInterval(loadIntervals, 30000);
    $('widget-device').addEventListener('change', populateFieldOptions);
    $('widget-type').addEventListener('change', syncWidgetFormType);
    $('logout').addEventListener('click', async () => {
      await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      location.replace('/signin');
    });

    // Re-render every dynamic text when the language is switched
    document.addEventListener('langchange', () => {
      if (state.user) renderAll();
      renderGadgetGrid();
      syncWidgetFormType();
    });

    $('theme-save').addEventListener('click', saveDeviceTheme);
    $('theme-image').addEventListener('change', uploadDeviceBackground);
    $('theme-image-remove').addEventListener('click', removeDeviceBackground);
    $('theme-cancel').addEventListener('click', cancelDeviceTheme);

    // A device page is the dashboard opened with ?device=<id>
    const focus = new URLSearchParams(location.search).get('device');
    if (focus && /^[a-f0-9]{16}$/.test(focus)) {
      state.filter = focus;
      state.focusPage = true;
    }

    // Without a chosen device, open the first one (?all=1 shows the overview)
    if (!focus && !new URLSearchParams(location.search).has('all')) {
      try {
        const { devices } = await api('/api/devices');
        if (devices.length) {
          location.replace(`/dashboard?device=${encodeURIComponent(devices[0].id)}`);
          return;
        }
      } catch {}
    }

    renderGadgetGrid();
    syncWidgetFormType();
    await refreshAll();
    if (state.focusPage) await loadTheme();
    setInterval(async () => {
      try {
        const { devices } = await api('/api/devices');
        for (const d of devices) {
          const cur = state.devices.get(d.id);
          if (!cur) { state.devices.set(d.id, d); continue; }
          const changed = cur.lastSeen !== d.lastSeen || JSON.stringify(cur.fields) !== JSON.stringify(d.fields);
          cur.name = d.name;
          cur.lastSeen = d.lastSeen;
          cur.latest = d.latest;
          cur.fields = d.fields;
          cur.online = d.online;
          cur.onlineSince = d.onlineSince;
          if (changed) refreshDevice(d.id);
        }
        renderSidebar();
        renderStats();
      } catch {}
    }, 60000);
    setInterval(() => { renderSidebar(); renderStats(); updateTimestamps(); }, 30000);
    setInterval(updateTimestamps, 1000);
  }

  boot();
})();
