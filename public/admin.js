// Admin page: every user, their devices and sends, and their limits. Admins only.
(() => {
  const $ = (id) => document.getElementById(id);
  const message = (text) => { $('admin-message').textContent = text; };

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }

  const number = (n) => Number(n || 0).toLocaleString('en-US');

  function row(u, defaultLimit) {
    const tr = document.createElement('tr');

    const who = document.createElement('td');
    who.textContent = `${u.name || '—'} · ${u.email}`;
    tr.appendChild(who);

    for (const v of [u.devices, u.today, u.month, u.total]) {
      const td = document.createElement('td');
      td.textContent = number(v);
      tr.appendChild(td);
    }

    const limitCell = document.createElement('td');
    const input = document.createElement('input');
    input.className = 'input admin-limit';
    input.type = 'number';
    input.min = '0';
    input.value = String(u.dailyLimit);
    input.setAttribute('aria-label', `Daily limit for ${u.email}`);
    limitCell.appendChild(input);
    if (!u.customLimit) {
      const note = document.createElement('div');
      note.className = 'admin-note';
      note.textContent = `default ${number(defaultLimit)}`;
      limitCell.appendChild(note);
    }
    tr.appendChild(limitCell);

    const actions = document.createElement('td');
    actions.className = 'admin-actions';

    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.textContent = 'Save limit';
    save.addEventListener('click', async () => {
      try {
        await api(`/api/admin/users/${u.id}/limit`, { method: 'PUT', body: JSON.stringify({ daily: Number(input.value) }) });
        message('');
        load();
      } catch (err) { message(err.message); }
    });

    const reset = document.createElement('button');
    reset.className = 'btn btn-ghost';
    reset.textContent = 'Reset today';
    reset.addEventListener('click', async () => {
      if (!confirm(`Reset today's count for ${u.email}? Monthly and total counts stay.`)) return;
      try {
        await api(`/api/admin/users/${u.id}/reset`, { method: 'POST' });
        message('');
        load();
      } catch (err) { message(err.message); }
    });

    const logs = document.createElement('button');
    logs.className = 'btn btn-ghost';
    logs.textContent = 'Reset logs';
    logs.addEventListener('click', async () => {
      if (!confirm(`Clear the activity log and stored readings for ${u.email}? Send counts stay.`)) return;
      try {
        await api(`/api/admin/users/${u.id}/logs/reset`, { method: 'POST' });
        message('');
        load();
      } catch (err) { message(err.message); }
    });

    const details = document.createElement('button');
    details.className = 'btn btn-ghost';
    details.textContent = 'Last 30 days';
    details.addEventListener('click', () => showDays(u));

    actions.append(save, reset, logs, details);
    tr.appendChild(actions);
    return tr;
  }

  async function showDays(u) {
    try {
      const { days } = await api(`/api/admin/users/${u.id}/days`);
      $('d-title').textContent = `${u.email}: last 30 days`;
      const rows = days.length
        ? days.map((d) => {
            const tr = document.createElement('tr');
            const day = document.createElement('td');
            day.textContent = d.day;
            const sends = document.createElement('td');
            sends.textContent = number(d.sends);
            tr.append(day, sends);
            return tr;
          })
        : [Object.assign(document.createElement('tr'), { innerHTML: '<td colspan="2">No sends yet</td>' })];
      $('d-rows').replaceChildren(...rows);
      $('a-detail').classList.remove('hidden');
    } catch (err) { message(err.message); }
  }

  async function load() {
    try {
      const data = await api('/api/admin/users');
      const users = data.users;
      $('a-users').textContent = number(users.length);
      $('a-devices').textContent = number(users.reduce((s, u) => s + Number(u.devices || 0), 0));
      $('a-today').textContent = number(users.reduce((s, u) => s + Number(u.today || 0), 0));
      $('a-month').textContent = number(users.reduce((s, u) => s + Number(u.month || 0), 0));
      $('a-default').textContent = `Default daily limit: ${number(data.defaultLimit)}`;
      $('a-rows').replaceChildren(...users.map((u) => row(u, data.defaultLimit)));
    } catch (err) {
      message(err.message === 'Admins only'
        ? 'Sign in with admin@iotdeck.org to see this page.'
        : err.message);
    }
  }

  $('d-close').addEventListener('click', () => $('a-detail').classList.add('hidden'));
  load();
})();
