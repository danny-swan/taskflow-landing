// TaskFlow — Личный кабинет (веб). Статический клиент к Supabase.
// Вход, просмотр подписки/платежей, отвязка карты, управление автопродлением.
// Использует те же Edge Functions, что и десктопное приложение
// (detach-payment-method, cancel-subscription, reactivate-subscription).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4';

const SUPABASE_URL = 'https://sejpmzrmtgcvevukggkx.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_EDGdl5gun3Ud60AQMymq9A_VWUFpS-a';

// Cloudflare Turnstile Site Key — публичный, тот же что в приложении.
// Supabase Attack Protection требует captchaToken при каждом signInWithPassword.
const TURNSTILE_SITE_KEY = '0x4AAAAAADvgC9hFLs0-TtzN';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ─── DOM helpers ───────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const authScreen = $('auth-screen');
const accountScreen = $('account-screen');
const navUser = $('nav-user');
const logoutBtn = $('logout-btn');

// ─── Turnstile captcha ─────────────────────────────────────────
let captchaToken = null;
let turnstileWidgetId = null;

function setLoginEnabled() {
  const submit = $('login-submit');
  if (submit) submit.disabled = !captchaToken;
}

// Вызывается скриптом Turnstile после загрузки (onload=onTurnstileReady).
window.onTurnstileReady = function () {
  if (!window.turnstile || turnstileWidgetId !== null) return;
  const el = $('turnstile-widget');
  if (!el) return;
  turnstileWidgetId = window.turnstile.render(el, {
    sitekey: TURNSTILE_SITE_KEY,
    theme: 'light',
    language: 'ru',
    callback: (token) => { captchaToken = token; setLoginEnabled(); },
    'expired-callback': () => { captchaToken = null; setLoginEnabled(); },
    'error-callback': () => { captchaToken = null; setLoginEnabled(); },
  });
  setLoginEnabled();
};

function resetCaptcha() {
  captchaToken = null;
  if (window.turnstile && turnstileWidgetId !== null) {
    try { window.turnstile.reset(turnstileWidgetId); } catch { /* noop */ }
  }
  setLoginEnabled();
}

const PLAN_LABELS = { free: 'Free', trial: 'Trial (пробный)', pro: 'Pro', lifetime: 'Lifetime' };
const PLAN_BADGE = { free: 'badge-free', trial: 'badge-trial', pro: 'badge-pro', lifetime: 'badge-lifetime' };

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch { return '—'; }
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}
function fmtAmount(value, currency) {
  if (value == null) return '—';
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (Number.isNaN(num)) return '—';
  const cur = (currency || 'RUB').toUpperCase();
  const sym = cur === 'RUB' ? '₽' : cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur;
  return `${num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym}`;
}

function showMsg(el, text, kind = 'info') {
  el.textContent = text;
  el.className = `msg msg-${kind}`;
  el.hidden = false;
}
function hideMsg(el) { el.hidden = true; }

// ─── Modal ─────────────────────────────────────────────────────
let modalResolve = null;
function confirmModal({ title, text, confirmLabel = 'Подтвердить', danger = true }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('modal-title').textContent = title;
    $('modal-text').textContent = text;
    const btn = $('modal-confirm');
    btn.textContent = confirmLabel;
    btn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    $('modal-overlay').classList.add('open');
  });
}
function closeModal(result) {
  $('modal-overlay').classList.remove('open');
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}
$('modal-cancel').addEventListener('click', () => closeModal(false));
$('modal-confirm').addEventListener('click', () => closeModal(true));
$('modal-overlay').addEventListener('click', (e) => { if (e.target === $('modal-overlay')) closeModal(false); });

// ─── Auth ──────────────────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMsg($('auth-msg'));
  const email = $('email').value.trim();
  const password = $('password').value;
  const submit = $('login-submit');
  if (!captchaToken) {
    showMsg($('auth-msg'), 'Подтвердите, что вы не робот, и повторите вход.', 'info');
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Вход…';
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: { captchaToken },
    });
    if (error) {
      const map = {
        'Invalid login credentials': 'Неверная почта или пароль.',
        'Email not confirmed': 'Электронная почта не подтверждена. Проверьте письмо.',
      };
      showMsg($('auth-msg'), map[error.message] || `Ошибка входа: ${error.message}`, 'error');
      resetCaptcha();
      return;
    }
    await renderAccount();
  } catch (err) {
    showMsg($('auth-msg'), `Не удалось войти: ${err.message || err}`, 'error');
    resetCaptcha();
  } finally {
    submit.textContent = 'Войти';
    setLoginEnabled();
  }
});

$('forgot-link').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = $('email').value.trim();
  if (!email) { showMsg($('auth-msg'), 'Введите электронную почту в поле выше, затем нажмите «Забыли пароль?».', 'info'); return; }
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'https://yourtaskflow.app/account/',
      captchaToken: captchaToken || undefined,
    });
    if (error) throw error;
    showMsg($('auth-msg'), 'Письмо для сброса пароля отправлено, если аккаунт с такой почтой существует.', 'success');
  } catch (err) {
    showMsg($('auth-msg'), `Не удалось отправить письмо: ${err.message || err}`, 'error');
  }
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.reload();
});

// ─── Screen switching ──────────────────────────────────────────
function showAuth() {
  authScreen.hidden = false;
  accountScreen.hidden = true;
  navUser.hidden = true;
  logoutBtn.hidden = true;
}
function showAccount(email) {
  authScreen.hidden = true;
  accountScreen.hidden = false;
  navUser.textContent = email;
  navUser.hidden = false;
  logoutBtn.hidden = false;
}

// ─── Render account ────────────────────────────────────────────
async function renderAccount() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { showAuth(); return; }
  showAccount(user.email);

  // Account info
  $('acc-email').textContent = user.email || '—';
  $('acc-id').textContent = user.id;
  $('acc-created').textContent = fmtDate(user.created_at);

  await Promise.all([
    renderSubscription(user.id),
    renderPaymentMethod(user.id),
    renderPayments(user.id),
  ]);
}

// ─── Subscription ──────────────────────────────────────────────
async function renderSubscription(userId) {
  const { data, error } = await supabase
    .from('user_entitlements')
    .select('plan, valid_until, auto_renew, cancel_at_period_end, next_renewal_at, payment_method_id')
    .eq('user_id', userId)
    .maybeSingle();

  const planEl = $('sub-plan');
  const actions = $('sub-actions');
  const hint = $('sub-hint');
  actions.innerHTML = '';
  hint.textContent = '';

  if (error || !data) {
    planEl.innerHTML = '<span class="badge badge-free"><span class="dot"></span>Free</span>';
    $('sub-until-row').hidden = true;
    $('sub-autorenew-row').hidden = true;
    $('sub-next-row').hidden = true;
    hint.textContent = 'Активной подписки нет.';
    return;
  }

  const plan = data.plan || 'free';
  planEl.innerHTML = `<span class="badge ${PLAN_BADGE[plan] || 'badge-free'}"><span class="dot"></span>${PLAN_LABELS[plan] || plan}</span>`;

  const isLifetime = plan === 'lifetime';
  const isPaid = plan === 'pro' || plan === 'trial';

  // valid_until
  if (isLifetime) {
    $('sub-until-row').hidden = false;
    $('sub-until').textContent = 'Бессрочно';
  } else if (data.valid_until) {
    $('sub-until-row').hidden = false;
    $('sub-until').textContent = fmtDate(data.valid_until);
  } else {
    $('sub-until-row').hidden = true;
  }

  // auto_renew
  if (isLifetime) {
    $('sub-autorenew-row').hidden = true;
  } else {
    $('sub-autorenew-row').hidden = false;
    const cancel = data.cancel_at_period_end === true;
    const on = data.auto_renew === true && !cancel;
    $('sub-autorenew').innerHTML = on
      ? '<span class="badge badge-on"><span class="dot"></span>Включено</span>'
      : '<span class="badge badge-off"><span class="dot"></span>Отключено</span>';
  }

  // next renewal
  if (!isLifetime && data.auto_renew && !data.cancel_at_period_end && data.next_renewal_at) {
    $('sub-next-row').hidden = false;
    $('sub-next').textContent = fmtDate(data.next_renewal_at);
  } else {
    $('sub-next-row').hidden = true;
  }

  // Actions for auto-renew management
  if (plan === 'pro' && data.payment_method_id) {
    if (data.cancel_at_period_end || !data.auto_renew) {
      const btn = mkBtn('Возобновить автопродление', 'btn btn-primary btn-sm', async () => {
        await handleReactivate(userId);
      });
      actions.appendChild(btn);
      hint.innerHTML = 'Автопродление отключено. Доступ сохранится до <span class="hint-strong">' + fmtDate(data.valid_until) + '</span>, после чего тариф станет Free.';
    } else {
      const btn = mkBtn('Отменить автопродление', 'btn btn-ghost btn-sm', async () => {
        await handleCancel(userId);
      });
      actions.appendChild(btn);
      hint.innerHTML = 'При активном автопродлении оплата за следующий период спишется автоматически с привязанной карты.';
    }
  } else if (plan === 'free') {
    const btn = mkBtn('Оформить Pro', 'btn btn-primary btn-sm', () => { window.location.href = '/#pricing'; });
    actions.appendChild(btn);
  }
}

async function handleCancel(userId) {
  const ok = await confirmModal({
    title: 'Отменить автопродление?',
    text: 'Автоматическое списание за следующий период будет отключено. Доступ к Pro сохранится до конца оплаченного периода.',
    confirmLabel: 'Отменить автопродление',
    danger: true,
  });
  if (!ok) return;
  try {
    const { data, error } = await supabase.functions.invoke('cancel-subscription', { body: {} });
    if (error || !data || data.ok !== true) throw new Error(error?.message || data?.error || 'Ошибка');
    showMsg($('account-msg'), 'Автопродление отключено. Доступ сохранён до конца периода.', 'success');
    await renderSubscription(userId);
    await renderPaymentMethod(userId);
  } catch (err) {
    showMsg($('account-msg'), `Не удалось отменить автопродление: ${err.message || err}`, 'error');
  }
}

async function handleReactivate(userId) {
  const ok = await confirmModal({
    title: 'Возобновить автопродление?',
    text: 'Подписка снова будет продлеваться автоматически с привязанной карты.',
    confirmLabel: 'Возобновить',
    danger: false,
  });
  if (!ok) return;
  try {
    const { data, error } = await supabase.functions.invoke('reactivate-subscription', { body: {} });
    if (error || !data || data.ok !== true) throw new Error(error?.message || data?.error || 'Ошибка');
    showMsg($('account-msg'), 'Автопродление снова включено.', 'success');
    await renderSubscription(userId);
    await renderPaymentMethod(userId);
  } catch (err) {
    showMsg($('account-msg'), `Не удалось возобновить автопродление: ${err.message || err}`, 'error');
  }
}

// ─── Payment method ────────────────────────────────────────────
function brandLabel(row) {
  return row.card_type || row.card_brand || (row.method_type && row.method_type !== 'bank_card'
    ? ({ sber_pay: 'SberPay', sbp: 'СБП', t_pay: 'T-Pay', yoo_money: 'ЮMoney' }[row.method_type] || row.method_type)
    : 'Банковская карта');
}

async function renderPaymentMethod(userId) {
  const content = $('pm-content');
  const actions = $('pm-actions');
  actions.innerHTML = '';
  content.innerHTML = '<div class="skel skel-row" style="width:60%"></div>';

  const { data, error } = await supabase
    .from('payment_methods')
    .select('id, card_type, card_brand, card_last4, card_first6, card_expiry_month, card_expiry_year, method_type, is_active, saved_at')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('saved_at', { ascending: false });

  if (error) {
    content.innerHTML = '<div class="pm-empty">Не удалось загрузить способ оплаты.</div>';
    return;
  }

  const cards = data || [];
  if (cards.length === 0) {
    content.innerHTML = '<div class="pm-empty">Сохранённых способов оплаты нет. Карта не привязана к аккаунту.</div>';
    return;
  }

  const c = cards[0];
  const last4 = c.card_last4 || '••••';
  const exp = (c.card_expiry_month && c.card_expiry_year)
    ? `${String(c.card_expiry_month).padStart(2, '0')}/${String(c.card_expiry_year).slice(-2)}`
    : '';
  content.innerHTML = `
    <div class="pm-card">
      <div class="pm-brand-row">
        <span class="pm-brand">${brandLabel(c)}</span>
        <span class="pm-chip" aria-hidden="true"></span>
      </div>
      <div class="pm-number">•••• •••• •••• ${last4}</div>
      <div class="pm-meta">
        <span>${c.method_type === 'bank_card' || !c.method_type ? 'Карта' : 'Способ оплаты'}</span>
        <span>${exp ? 'до ' + exp : ''}</span>
      </div>
    </div>`;

  const detachBtn = mkBtn('Отвязать карту', 'btn btn-danger', async () => {
    await handleDetach(userId);
  });
  detachBtn.id = 'detach-btn';
  actions.appendChild(detachBtn);
}

async function handleDetach(userId) {
  const ok = await confirmModal({
    title: 'Отвязать карту?',
    text: 'Данные карты будут деактивированы в системе, автопродление отключится. Доступ к Pro сохранится до конца оплаченного периода. Это действие можно выполнить самостоятельно в любой момент.',
    confirmLabel: 'Отвязать карту',
    danger: true,
  });
  if (!ok) return;
  const btn = $('detach-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Отвязываем…'; }
  try {
    const { data, error } = await supabase.functions.invoke('detach-payment-method', { body: {} });
    if (error || !data || data.ok !== true) throw new Error(error?.message || data?.error || 'Ошибка');
    showMsg($('account-msg'), 'Карта отвязана. Данные карты удалены из системы, автопродление отключено.', 'success');
    await renderPaymentMethod(userId);
    await renderSubscription(userId);
  } catch (err) {
    showMsg($('account-msg'), `Не удалось отвязать карту: ${err.message || err}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Отвязать карту'; }
  }
}

// ─── Payments history ──────────────────────────────────────────
async function renderPayments(userId) {
  const content = $('pay-content');

  const { data, error } = await supabase
    .from('payment_events')
    .select('id, provider, external_id, raw_payload, processed_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    content.innerHTML = '<div class="empty-state">Не удалось загрузить историю платежей.</div>';
    return;
  }

  const events = (data || []).filter((e) => {
    const p = e.raw_payload || {};
    const status = (p.object?.status || p.status || '').toLowerCase();
    return status === 'succeeded' || status === 'canceled' || status === 'waiting_for_capture' || p.object?.paid != null;
  });

  if (events.length === 0) {
    content.innerHTML = '<div class="empty-state">Платежей пока нет.</div>';
    return;
  }

  const rows = events.map((e) => {
    const p = e.raw_payload || {};
    const obj = p.object || p;
    const status = (obj.status || '').toLowerCase();
    const paid = obj.paid === true || status === 'succeeded';
    const amountVal = obj.amount?.value ?? obj.amount ?? null;
    const currency = obj.amount?.currency ?? 'RUB';
    const date = obj.captured_at || obj.created_at || e.processed_at || e.created_at;
    const statusLabel = paid ? 'Оплачено' : status === 'canceled' ? 'Отменён' : status || '—';
    const cls = paid ? 'ok' : 'fail';
    const icon = paid
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const desc = obj.description || (e.provider === 'yookassa' ? 'ЮKassa' : e.provider || '');
    return `<tr>
      <td>${fmtDateTime(date)}</td>
      <td class="pay-amount">${fmtAmount(amountVal, currency)}</td>
      <td>${desc}</td>
      <td><span class="pay-status ${cls}">${icon}${statusLabel}</span></td>
    </tr>`;
  }).join('');

  content.innerHTML = `
    <table class="pay-table">
      <thead><tr><th>Дата</th><th>Сумма</th><th>Описание</th><th>Статус</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─── util ──────────────────────────────────────────────────────
function mkBtn(label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

// ─── Boot ──────────────────────────────────────────────────────
(async function boot() {
  setLoginEnabled(); // кнопка входа заблокирована, пока Turnstile не выдал токен
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    await renderAccount();
  } else {
    showAuth();
  }
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showAuth();
  });
})();
