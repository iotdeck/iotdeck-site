// Sign-in and sign-up page
(() => {
  const t = (key) => (window.i18n ? window.i18n.t(key) : key);

  const form = document.getElementById('form');
  const errorEl = document.getElementById('error');
  const submitBtn = document.getElementById('submit');
  const nameField = document.getElementById('name-field');
  const title = document.getElementById('auth-title');
  const password = document.getElementById('password');
  let mode = 'signin';

  // If already signed in, go straight to the dashboard
  fetch('/api/me', { credentials: 'same-origin' })
    .then((r) => { if (r.ok) location.replace('/dashboard'); })
    .catch(() => {});

  function setMode(next) {
    mode = next;
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
    });
    const signup = mode === 'signup';
    nameField.hidden = !signup;
    title.textContent = signup ? t('create_title') : t('welcome_back');
    submitBtn.textContent = signup ? t('submit_signup') : t('submit_signin');
    password.autocomplete = signup ? 'new-password' : 'current-password';
    errorEl.textContent = '';
  }

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  });

  // Re-apply the mode texts when the language changes
  document.addEventListener('langchange', () => setMode(mode));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const data = Object.fromEntries(new FormData(form));
    const email = String(data.email || '').trim();
    if (!email || !data.password) {
      errorEl.textContent = t('err_fill');
      return;
    }
    if (mode === 'signup' && data.password.length < 10) {
      errorEl.textContent = t('err_pw_short');
      return;
    }

    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = t('please_wait');
    try {
      const res = await fetch(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password: data.password, name: data.name || '' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        errorEl.textContent = body.error || t('err_generic');
        return;
      }
      location.replace('/dashboard');
    } catch {
      errorEl.textContent = t('err_network');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  });
})();
