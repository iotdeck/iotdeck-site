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

  function renderSidebar() {
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
          class: 'device-item',
          role: 'button',
          tabindex: '0',
          'aria-pressed': String(selected),
          style: selected ? 'background:var(--surface-hover);border-color:var(--border-strong);' : null,
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
          h('span', { class: 'sub', text: `${t(status)} · ${device.lastSeen ? timeAgo(device.lastSeen) : '—'}` }),
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

  function renderStats() {
    const devices = [...state.devices.values()];
    const online = devices.filter(isOnline).length;
    $('stat-devices').textContent = String(devices.length);
    $('stat-online').textContent = String(online);
    $('stat-widgets').textContent = String(state.widgets.length);
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
        h('a', { class: 'btn btn-ghost', href: '/dashboard', text: t('back_all') }),
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

  function openDevicePage(deviceId) {
    location.href = `/dashboard?device=${encodeURIComponent(deviceId)}`;
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

  function renderGrid() {
    const grid = $('grid');
    grid.replaceChildren();
    state.cards.clear();

    const visible = state.widgets.filter((w) => !state.filter || w.deviceId === state.filter);

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
      grid.append(h('div', { class: 'empty' }, h('p', { text: t('device_no_widgets') })));
      return;
    }

    for (const widget of visible) {
      const card = buildWidgetCard(widget);
      state.cards.set(widget.id, card);
      grid.append(card);
      updateWidgetCard(card, widget);
    }
  }

  function buildWidgetCard(widget) {
    const body = widgetBody(widget.type);
    // Only widgets that show values from the board can be switched off from receiving them
    const receiving = !(widget.config && widget.config.receive === false);
    const recv = OUTPUT_GADGETS.includes(widget.type)
      ? [h('button', {
          class: 'recv-toggle',
          type: 'button',
          'aria-pressed': String(receiving),
          title: t('receiving_hint'),
          text: receiving ? t('receiving_on') : t('receiving_off'),
          onclick: () => toggleReceiving(widget),
        })]
      : [];
    const edit = h(
      'button',
      { class: 'widget-remove widget-edit', type: 'button', 'aria-label': t('edit_widget'), title: t('edit_widget'), onclick: () => openEditWidget(widget) },
      '✎',
    );
    const remove = h(
      'button',
      {
        class: 'widget-remove',
        type: 'button',
        'aria-label': t('remove_widget'),
        title: t('remove'),
        onclick: () => removeWidget(widget),
      },
      '×',
    );
    return h(
      'article',
      { class: 'card widget', 'data-id': widget.id, 'data-type': widget.type },
      h(
        'div',
        { class: 'widget-head' },
        h(
          'div',
          null,
          h('div', { class: 'widget-title', 'data-role': 'title', text: widget.title }),
          h('div', { class: 'widget-device', 'data-role': 'device' }),
        ),
        h('div', { class: 'widget-actions' }, ...recv, edit, remove),
      ),
      body,
      h('div', { class: 'updated', 'data-role': 'updated' }),
    );
  }

  function widgetBody(type) {
    if (type === 'value') {
      return h(
        'div',
        { class: 'big-value' },
        h('span', { 'data-role': 'value' }),
        h('span', { class: 'unit', 'data-role': 'unit' }),
      );
    }

    if (type === 'text') {
      return h(
        'div',
        { class: 'big-value text-value' },
        h('span', { 'data-role': 'value' }),
        h('span', { class: 'unit', 'data-role': 'unit' }),
      );
    }

    if (type === 'slider') {
      return h(
        'div',
        { class: 'slider-row' },
        h('input', { class: 'slider', type: 'range', 'data-role': 'slider', 'aria-label': t('type_slider') }),
        h('span', { class: 'slider-value', 'data-role': 'value' }),
      );
    }

    if (type === 'gauge') {
      const arc = 2 * Math.PI * 80 * 0.75;
      return h(
        'div',
        null,
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
            cx: 100, cy: 100, r: 80, fill: 'none', stroke: 'url(#gaugeGrad)', 'stroke-width': 14, 'stroke-linecap': 'round',
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
        null,
        s(
          'svg',
          { class: 'spark', viewBox: '0 0 300 86', preserveAspectRatio: 'none', role: 'img', 'aria-label': t('trend_label') },
          s('path', { class: 'area', 'data-role': 'area', d: '' }),
          s('path', { class: 'line', 'data-role': 'line', d: '' }),
        ),
        h(
          'div',
          { class: 'big-value', style: 'font-size:28px;margin-top:10px;' },
          h('span', { 'data-role': 'value' }),
          h('span', { class: 'unit', 'data-role': 'unit' }),
        ),
      );
    }

    if (type === 'toggle') {
      return h(
        'div',
        { class: 'control' },
        h('span', { class: 'state-label', 'data-role': 'state' }),
        h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': 'false', 'data-role': 'switch' }),
      );
    }

    if (type === 'bar') {
      return h(
        'div',
        null,
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', 'data-role': 'bar' })),
        h(
          'div',
          { class: 'big-value', style: 'font-size:26px;margin-top:12px;' },
          h('span', { 'data-role': 'value' }),
          h('span', { class: 'unit', 'data-role': 'unit' }),
        ),
      );
    }

    if (type === 'indicator') {
      return h(
        'div',
        { class: 'control' },
        h('span', { class: 'lamp', 'data-role': 'lamp' }),
        h('span', { class: 'state-label', 'data-role': 'state' }),
      );
    }

    // button
    return h('button', { class: 'pulse-btn', type: 'button', 'data-role': 'pulse', text: t('trigger') });
  }

  function updateWidgetCard(card, widget) {
    const device = state.devices.get(widget.deviceId);
    // This gadget's own value and time. Other gadgets do not change it.
    const info = device && device.fields ? device.fields[widget.field] : undefined;
    const raw = info ? info.value : device && device.latest ? device.latest[widget.field] : undefined;
    const fieldTs = info ? info.ts : null;
    const deviceEl = card.querySelector('[data-role="device"]');
    // Device name, then the data field as its own chip, so the two are easy to tell apart
    if (device) {
      const chip = h('span', { class: 'field-chip', title: t('field_label'), text: widget.field });
      deviceEl.replaceChildren(document.createTextNode(`${device.name} `), chip);
    } else {
      deviceEl.textContent = t('device_removed');
    }
    card.querySelector('[data-role="updated"]').dataset.ts = fieldTs ? String(fieldTs) : '';

    const unit = widget.config && widget.config.unit ? widget.config.unit : '';

    if (widget.type === 'value') {
      card.querySelector('[data-role="value"]').textContent = formatValue(raw);
      card.querySelector('[data-role="unit"]').textContent = typeof raw === 'number' ? unit : '';
    }

    if (widget.type === 'text') {
      card.querySelector('[data-role="value"]').textContent = raw === undefined ? t('waiting_data') : String(raw);
      card.querySelector('[data-role="unit"]').textContent = typeof raw === 'number' ? unit : '';
    }

    if (widget.type === 'slider') {
      const min = Number(widget.config.min ?? 0);
      const max = Number(widget.config.max ?? 100);
      const input = card.querySelector('[data-role="slider"]');
      const valueEl = card.querySelector('[data-role="value"]');
      input.min = String(min);
      input.max = String(max);
      // Keep the thumb where the user drags it until they let go
      if (!input.dataset.dragging) {
        input.value = String(typeof raw === 'number' ? raw : min);
        // A slider is a control, not a reading: until it has been used it simply has no value yet
        valueEl.textContent = typeof raw === 'number' ? `${formatValue(raw)} ${unit}`.trim() : t('not_set_yet');
      }
      if (!input.dataset.bound) {
        input.dataset.bound = '1';
        input.addEventListener('input', () => {
          input.dataset.dragging = '1';
          valueEl.textContent = `${input.value} ${unit}`.trim();
        });
        input.addEventListener('change', async () => {
          delete input.dataset.dragging;
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
      card.querySelector('[data-role="fill"]').setAttribute('stroke-dashoffset', String(arc * (1 - pct)));
      card.querySelector('[data-role="gv"]').textContent = formatValue(raw);
      card.querySelector('[data-role="gu"]').textContent = unit;
    }

    if (widget.type === 'bar') {
      const min = Number(widget.config.min ?? 0);
      const max = Number(widget.config.max ?? 100);
      const num = typeof raw === 'number' ? raw : min;
      const pct = Math.min(1, Math.max(0, (num - min) / (max - min || 1)));
      card.querySelector('[data-role="bar"]').style.width = `${(pct * 100).toFixed(1)}%`;
      card.querySelector('[data-role="value"]').textContent = formatValue(raw);
      card.querySelector('[data-role="unit"]').textContent = typeof raw === 'number' ? unit : '';
    }

    if (widget.type === 'indicator') {
      const on = raw === true || (typeof raw === 'number' && raw > 0);
      card.querySelector('[data-role="lamp"]').classList.toggle('on', on);
      card.querySelector('[data-role="state"]').textContent =
        raw === undefined ? t('waiting_data') : on ? t('on') : t('off');
    }

    if (widget.type === 'line') {
      const points = (state.history.get(widget.deviceId) || [])
        .map((r) => r.data[widget.field])
        .filter((v) => typeof v === 'number');
      card.querySelector('[data-role="value"]').textContent = formatValue(raw);
      card.querySelector('[data-role="unit"]').textContent = typeof raw === 'number' ? unit : '';
      const { line, area } = sparkPaths(points);
      card.querySelector('[data-role="line"]').setAttribute('d', line);
      card.querySelector('[data-role="area"]').setAttribute('d', area);
    }

    if (widget.type === 'toggle') {
      const pend = state.pending.get(widget.id);
      let on = Boolean(raw);
      if (pend) {
        if (pend.value === Boolean(raw) || Date.now() > pend.until) state.pending.delete(widget.id);
        else on = pend.value;
      }
      const sw = card.querySelector('[data-role="switch"]');
      sw.setAttribute('aria-checked', String(on));
      // A switch shows the last value set from the dashboard. It does not wait for the board.
      card.querySelector('[data-role="state"]').textContent =
        raw === undefined && !pend ? t('not_set_yet') : on ? t('on') : t('off');
      if (!sw.dataset.bound) {
        sw.dataset.bound = '1';
        sw.addEventListener('click', () => toggleControl(widget, card));
      }
    }

    if (widget.type === 'button') {
      const btn = card.querySelector('[data-role="pulse"]');
      if (!btn.dataset.bound) {
        btn.dataset.bound = '1';
        bindHoldButton(widget, btn);
      }
    }

    // Each gadget shows when its own value last changed, its average gap, and a warning after 15 minutes
    const stamp = card.querySelector('[data-role="updated"]');
    // Buttons and switches the dashboard sends have no time until they have been used
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
        device.latest = { ...(device.latest || {}), [msg.field]: msg.value };
        device.fields = { ...(device.fields || {}), [msg.field]: { value: msg.value, ts: msg.ts || Date.now() } };
        refreshDevice(deviceId);
        return;
      }
      // The board connected to the dashboard
      if (msg.type === 'hello') {
        device.online = true;
        renderSidebar();
        renderStats();
        return;
      }
      if (msg.type !== 'reading' || !msg.data) return;
      device.online = true;
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
    syncWidgetFormType();
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
    setEditMode(false);
    const select = $('widget-device');
    select.replaceChildren(...[...state.devices.values()].map((d) => h('option', { value: d.id, text: d.name })));
    if (state.filter) select.value = state.filter;
    populateFieldOptions();
    renderGadgetGrid();
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
    );
  }

  function selectGadget(type) {
    $('widget-type').value = type;
    for (const card of $('gadget-grid').querySelectorAll('.gadget-card')) {
      card.setAttribute('aria-checked', String(card.dataset.type === type));
    }
    syncWidgetFormType();
  }

  function syncWidgetFormType() {
    const type = $('widget-type').value;
    $('gauge-range').hidden = !['gauge', 'bar', 'slider'].includes(type);
    $('widget-unit').closest('.field').hidden = ['toggle', 'button', 'indicator'].includes(type);
  }

  async function submitWidget(event) {
    event.preventDefault();
    const errorEl = $('widget-error');
    errorEl.textContent = '';
    const type = $('widget-type').value;
    const field = $('widget-field').value.trim();
    const payload = {
      deviceId: $('widget-device').value,
      type,
      field,
      title: $('widget-title-input').value.trim() || field,
      unit: $('widget-unit').value.trim(),
      min: Number($('widget-min').value),
      max: Number($('widget-max').value),
    };
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(field)) {
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
    renderGreeting();

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
