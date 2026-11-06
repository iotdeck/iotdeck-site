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
  const verifyBox = document.getElementById('verify-box');
  const verifyText = document.getElementById('verify-text');
  const verifyError = document.getElementById('verify-error');
  const resendBtn = document.getElementById('verify-resend');
  let pendingEmail = '';
  let pendingKey = 'verify_sent';

  function showVerify(email, key) {
    pendingEmail = email;
    pendingKey = key;
    verifyText.textContent = t(key, { email });
    verifyError.textContent = '';
    form.hidden = true;
    document.querySelector('.tabs').hidden = true;
    document.getElementById('google').hidden = true;
    document.querySelector('.divider').hidden = true;
    verifyBox.hidden = false;
  }

  function hideVerify() {
    verifyBox.hidden = true;
    form.hidden = false;
    document.querySelector('.tabs').hidden = false;
    document.getElementById('google').hidden = false;
    document.querySelector('.divider').hidden = false;
  }

  document.getElementById('verify-back').addEventListener('click', hideVerify);
  resendBtn.addEventListener('click', async () => {
    resendBtn.disabled = true;
    verifyError.textContent = '';
    try {
      const res = await fetch('/api/auth/resend', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: pendingEmail }),
      });
      const body = await res.json().catch(() => ({}));
      verifyError.textContent = res.ok ? t('verify_resent') : body.error || t('err_generic');
    } catch {
      verifyError.textContent = t('err_network');
    } finally {
      setTimeout(() => { resendBtn.disabled = false; }, 15000);
    }
  });

  // Coming back from an expired or already-used confirmation link
  if (new URLSearchParams(location.search).get('verify') === 'invalid') {
    errorEl.textContent = t('verify_invalid');
  }

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
  document.addEventListener('langchange', () => {
    setMode(mode);
    if (!verifyBox.hidden) verifyText.textContent = t(pendingKey, { email: pendingEmail });
  });

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
      if (res.status === 403 && body.code === 'email_not_verified') {
        showVerify(email, 'verify_needed');
        return;
      }
      if (!res.ok) {
        errorEl.textContent = body.error || t('err_generic');
        return;
      }
      if (body.needsVerification) {
        showVerify(body.email || email, 'verify_sent');
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
