/* Stride + Supabase Client Config */
const SUPABASE_URL = 'https://trqrpoployvsuuitffji.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_H54WIGq4spz51QFkSjmR8w_ohdXdv90';
const AUTH_REDIRECT_URL = 'https://yousefughh.github.io/RUN/';
const supabaseReady = SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('YOUR_');
const db = supabaseReady ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const chatAvatarUrls = new Map();

const state = { user: null, profile: null, events: [], bookings: [], activeChatRun: null, authListener: false, loadingSessionUserId: null, clips: [], passwordRecovery: new URLSearchParams(location.hash.slice(1)).get('type') === 'recovery' };
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const isAdmin = () => ['admin', 'owner'].includes(state.profile?.role);
const isOwner = () => state.profile?.role === 'owner';

async function getPrivateAvatarUrl(path) {
  const { data, error } = await db.storage.from('runmate-avatars').createSignedUrl(path, 86400);
  if (error) {
    console.error('Profile photo unavailable:', error.statusCode || 'unknown');
    return '';
  }
  return data?.signedUrl || '';
}

async function getChatAvatarUrl(path) {
  if (!path) return '';
  const cached = chatAvatarUrls.get(path);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.url;
  const { data, error } = await db.storage.from('runmate-avatars').createSignedUrl(path, 3600);
  const url = error ? '' : data?.signedUrl || '';
  chatAvatarUrls.set(path, { url, expiresAt: Date.now() + (url ? 55 * 60_000 : 30_000) });
  return url;
}

async function renderChatMessages(messages, runId) {
  const box = $('chat-messages');
  if (!box || state.activeChatRun !== runId) return;
  const paths = [...new Set((messages || []).map(message => message.avatar_path).filter(Boolean))];
  const pathIndexes = new Map(paths.map((path, index) => [path, index]));
  box.innerHTML = messages?.length
    ? [...messages].reverse().map(message => {
      const name = message.sender_name || 'عضو في Stride';
      const initial = Array.from(name.trim())[0] || 'ع';
      const avatarIndex = pathIndexes.get(message.avatar_path);
      const avatar = avatarIndex === undefined
        ? `<span class="message-avatar message-avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`
        : `<span class="message-avatar message-avatar-fallback" data-avatar-index="${avatarIndex}" aria-hidden="true">${escapeHtml(initial)}</span>`;
      return `<div class="message"><div class="message-heading">${avatar}<b>${escapeHtml(name)}</b></div><p>${escapeHtml(message.body)}</p><small>${escapeHtml(formatDate(message.created_at))}</small></div>`;
    }).join('')
    : '<p class="empty-state">لا توجد رسائل بعد. ابدأوا المحادثة!</p>';
  box.scrollTop = box.scrollHeight;

  const urls = await Promise.all(paths.map(path => getChatAvatarUrl(path)));
  if (!box.isConnected || state.activeChatRun !== runId) return;
  urls.forEach((url, index) => {
    if (!url) return;
    box.querySelectorAll(`[data-avatar-index="${index}"]`).forEach(placeholder => {
      const image = document.createElement('img');
      image.className = 'message-avatar';
      image.src = url;
      image.alt = 'صورة صاحب الرسالة';
      placeholder.replaceWith(image);
    });
  });
}

function showMessage(message, target = 'auth-message') {
  const el = $(target);
  if (el) el.textContent = message;
}

function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('active');
  setTimeout(() => el.classList.remove('active'), 2600);
}

function setAuthTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');$('tab-register').classList.toggle('active', tab === 'register');
  $('form-login').style.display = tab === 'login' ? 'flex' : 'none';$('form-register').style.display = tab === 'register' ? 'flex' : 'none';
  showMessage('');
}
$('tab-login').addEventListener('click', () => setAuthTab('login'));$('tab-register').addEventListener('click', () => setAuthTab('register'));

function showPasswordRecovery() {
  state.passwordRecovery = true;
  $('auth-screen').style.display = 'flex';
  $('app-shell').classList.remove('authenticated');
  document.querySelector('.auth-tabs').hidden = true;
  $('form-login').hidden = true;
  $('form-register').hidden = true;
  $('resend-confirmation-btn').hidden = true;
  $('form-password-recovery').hidden = false;
  $('auth-screen').querySelector('.auth-note').textContent = 'استعادة كلمة السر';
  $('auth-message').textContent = 'اختار كلمة سر جديدة لا تقل عن 8 أحرف.';
}

$('form-password-recovery').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('recovery-password').value;
  if (password.length < 8) return showMessage('كلمة السر لازم تكون 8 أحرف على الأقل.');
  if (password !== $('recovery-password-confirm').value) return showMessage('كلمتا السر غير متطابقتين.');

  const button = $('form-password-recovery').querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage('جارٍ حفظ كلمة السر الجديدة...');
  const { error } = await db.auth.updateUser({ password });
  button.disabled = false;
  if (error) {
    console.error('Password recovery update failed:', error.code || 'unknown');
    return showMessage('تعذّر تغيير كلمة السر. افتح أحدث رابط استعادة وصلك عبر البريد ثم حاول مرة أخرى.');
  }

  state.passwordRecovery = false;
  $('recovery-password').value = '';
  $('recovery-password-confirm').value = '';
  $('form-password-recovery').hidden = true;
  $('auth-screen').style.display = 'none';
  const { data: { session } } = await db.auth.getSession();
  if (session) await loadSession(session);
  toast('تم تغيير كلمة السر بنجاح.');
});

/* إنشاء حساب جديد */
$('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  if (!db) return showMessage('أضف إعدادات Supabase أولاً.');
  const form = $('form-register');
  if (form.dataset.submitting === 'true') return;

  const name = $('reg-name').value.trim();
  const email = $('reg-identity').value.trim();
  const password = $('reg-pass').value;
  const button = form.querySelector('button[type="submit"]');

  form.dataset.submitting = 'true';
  button.disabled = true;
  showMessage('جارٍ إنشاء الحساب...');

  try {
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: name },
        emailRedirectTo: AUTH_REDIRECT_URL
      }
    });

    if (error) {
      console.error('Signup failed:', error.code || 'unknown');
      if (error.status === 429 || /rate.?limit|too many requests/i.test(error.message || '')) {
        return showMessage('وصلنا للحد المؤقت لمحاولات التسجيل أو رسائل التأكيد. انتظر قليلًا ثم حاول مرة أخرى.');
      }
      return showMessage('تعذّر إنشاء الحساب. تحقق من البيانات وحاول مرة أخرى.');
    }

    if (data.user) {
      if (data.session) {
        await loadSession(data.session);
        toast('تم إنشاء الحساب بنجاح');
      } else {
        showMessage('افتح رسالة تأكيد البريد واضغط الرابط؛ سيعود بك إلى الموقع ويسجّل دخولك تلقائيًا.');
      }
    }
  } catch (error) {
    console.error('Signup request failed:', error?.name || 'unknown');
    showMessage('تعذّر الاتصال بخدمة التسجيل. تحقق من الإنترنت وحاول مرة أخرى بعد قليل.');
  } finally {
    form.dataset.submitting = 'false';
    button.disabled = false;
  }
});

/* تسجيل الدخول */
$('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  if (!db) return showMessage('أضف إعدادات Supabase أولاً.');

  const email = $('login-identity').value.trim();
  const password = $('login-pass').value;

  showMessage('جارٍ تسجيل الدخول...');
  const result = await db.auth.signInWithPassword({ email, password });

  if (result.error) { console.error('Login failed:', result.error.code || 'unknown'); return showMessage(result.error.code === 'email_not_confirmed' ? 'يجب تأكيد بريدك أولاً. أعد إرسال رسالة التأكيد من الزر أدناه.' : 'تعذّر تسجيل الدخول. تحقق من البريد وكلمة المرور.'); }
  await loadSession(result.data.session);
});

/* استعادة كلمة السر */
$('forgot-pass-btn').addEventListener('click', async () => {
  if (!db) return showMessage('إعدادات Supabase غير مكتملة.');
  const email = $('login-identity').value.trim();
  if (!email || !email.includes('@')) {
    return showMessage('يرجى إدخال البريد الإلكتروني في خانة تسجيل الدخول أولاً.');
  }
  showMessage('جارٍ إرسال رابط استعادة كلمة السر...');
  const button = $('forgot-pass-btn');
  button.disabled = true;
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: AUTH_REDIRECT_URL,
  });
  button.disabled = false;
  if (error) { console.error('Password reset request failed:', error.code || 'unknown'); return showMessage('تعذّر إرسال رابط إعادة التعيين. تأكد أن رابط الموقع مضاف في Supabase ثم حاول مجدداً.'); }
  showMessage('لو البريد مسجل في الموقع، هتوصلك رسالة استعادة. افتح أحدث رسالة واضغط الرابط خلال صلاحيته.');
});

$('profile-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('profile-new-password').value;
  const confirmPassword = $('profile-confirm-password').value;
  const status = $('profile-password-status');
  if (password.length < 8) return status.textContent = 'كلمة السر لازم تكون 8 أحرف على الأقل.';
  if (password !== confirmPassword) return status.textContent = 'كلمتا السر غير متطابقتين.';

  const button = $('profile-password-form').querySelector('button[type="submit"]');
  button.disabled = true;
  status.textContent = 'جارٍ تغيير كلمة السر...';
  const { error } = await db.auth.updateUser({ password });
  button.disabled = false;
  if (error) {
    console.error('Password change failed:', error.code || 'unknown');
    status.textContent = 'تعذّر تغيير كلمة السر. سجّل الدخول من جديد ثم حاول مرة أخرى.';
    return;
  }

  $('profile-password-form').reset();
  status.textContent = 'تم تغيير كلمة السر بنجاح.';
});

/* تحميل الجلسة وتحميل البيانات */
async function loadSession(session) {
  if (!session?.user?.id || state.loadingSessionUserId === session.user.id || state.profile?.id === session.user.id) return;
  state.loadingSessionUserId = session.user.id;
  state.user = session.user;
  let { data: profile, error } = await db.from('profiles').select('id,display_name,avatar_path,role,created_at').eq('id', state.user.id).single();

  if (error || !profile) {
    showMessage('تعذّر العثور على ملف الحساب. طبّق supabase-migration.sql في مشروع Supabase ثم سجّل الدخول مجدداً.');
    console.error('Profile lookup failed:', error?.code || 'profile missing');
    state.loadingSessionUserId = null;
    return;
  }

  state.profile = profile;
  $('auth-screen').style.display = 'none';$('app-shell').classList.add('authenticated');

  const name = profile.display_name || 'مستخدم Stride';
  const email = state.user.email || '';
  const initial = Array.from(name)[0] || 'U';

  const avatarUrl = profile.avatar_path ? await getPrivateAvatarUrl(profile.avatar_path) : '';
  const avatarMarkup = avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="صورة ${escapeHtml(name)}">` : escapeHtml(initial);
  $('user-avatar-initials').innerHTML = avatarMarkup;
  $('profile-avatar-large').innerHTML = avatarMarkup;
  $('profile-name').textContent = name;
  $('profile-email').textContent = email;
  $('profile-role').textContent = state.profile.role === 'owner' ? 'مالك Stride' : isAdmin() ? 'حساب أدمن' : 'عضو Stride';

  document.querySelectorAll('.admin-only').forEach(el => el.hidden = !isAdmin());

  await refreshData();
  navigateTo('home');
  state.loadingSessionUserId = null;
}

async function refreshData() {
  const [eventsRes, bookingsRes] = await Promise.all([
    db.from('runs').select('id,title,starts_at,location,distance_km,seats_total,seats_booked,run_status,duration_minutes,price,image_url,admin_only_chat,created_at').order('starts_at', { ascending: true }),
    db.from('bookings').select('run_id, runs(id,title,starts_at,location,distance_km,seats_total,seats_booked,run_status,duration_minutes,price,image_url,admin_only_chat,created_at)').eq('user_id', state.user.id)
  ]);

  if (eventsRes.error) return toast('تعذر تحميل الجريات: ' + eventsRes.error.message);

  state.events = eventsRes.data || [];
  state.bookings = (bookingsRes.data || []).map(row => row.runs).filter(Boolean);

  renderEvents();
  renderChatsList();
}

function navigateTo(pageId) {
  if ((pageId === 'organizer' || pageId === 'admin') && !isAdmin()) {
    toast('إنشاء الجريات متاح للأدمن فقط');
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${pageId}`));
  document.querySelectorAll('[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === pageId));
  
  const names = { clips: 'Clips', admin: 'Admin', home: 'الرئيسية', tickets: 'حجوزاتي', chats: 'المحادثات', profile: 'الملف الشخصي', organizer: 'إدارة الجريات' };
  $('crumb-active').textContent = names[pageId] || 'Stride';

  if (pageId === 'chats') renderChatsList();
  if (pageId === 'clips') loadClips();
  if (pageId === 'admin') loadAdminPanel();
}

document.addEventListener('click', e => {
  const pageBtn = e.target.closest('[data-page]');
  if (pageBtn) {
    e.preventDefault();
    navigateTo(pageBtn.dataset.page);
  }
  if (e.target.closest('#user-avatar-initials')) navigateTo('profile');
  const openBtn = e.target.closest('[data-event]');
  if (openBtn) openModal(openBtn.dataset.event);
  const chatBtn = e.target.closest('[data-chat-run]');
  if (chatBtn) openChat(chatBtn.dataset.chatRun);
});

function formatDate(value) {
  if (!value) return 'موعد يحدد لاحقًا';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' });
}

function createRunCard(run) {
  const seats = Math.max(0, Number(run.seats_total || 0) - Number(run.seats_booked || 0));
  const seatText = seats === 0 ? 'التذاكر انتهت' : `${seats} تذكرة متاحة`;
  return `<article class="run-card">
    <div class="run-image"><img loading="lazy" decoding="async" src="${escapeHtml(run.image_url || 'https://images.unsplash.com/photo-1476480862126-209bfaa8edc8?w=600&auto=format&fit=crop&q=80')}" alt=""><span class="run-badge ${seats === 0 ? 'sold-out' : ''}">${seatText}</span></div>
    <div class="run-info"><div class="run-org">✦ منظّم من Stride</div>
    <h3>${escapeHtml(run.title)}</h3><div class="run-detail"><span>◷ ${escapeHtml(formatDate(run.starts_at))}</span><span>⌖ ${escapeHtml(run.location)} · ${escapeHtml(run.distance_km)} كم</span></div>
    <div class="run-foot"><div class="run-price">${escapeHtml(run.price || 'مجانية')}</div><button class="run-open" data-event="${escapeHtml(run.id)}">التفاصيل ↙</button></div></div></article>`;
}

function renderEvents() {
  const query = ($('search')?.value || '').trim().toLowerCase();
  const list = state.events.filter(run => `${run.title} ${run.location}`.toLowerCase().includes(query));
  const groups = { upcoming: [], current: [], previous: [] };
  list.forEach(run => {
    groups[getRunCategory(run)].push(run);
  });
  const sections = [
    ['upcoming-runs', groups.upcoming, 'لا توجد جريات قادمة تطابق بحثك.'],
    ['current-runs', groups.current, 'لا توجد جريات حالية اليوم.'],
    ['previous-runs', groups.previous, 'لا توجد جريات سابقة تطابق بحثك.']
  ];
  sections.forEach(([id, runs, emptyMessage]) => {
    $(id).innerHTML = runs.length ? runs.map(createRunCard).join('') : `<p class="empty-state">${emptyMessage}</p>`;
  });
  $('ticket-count').textContent = state.bookings.length;
  $('ticket-list').innerHTML = state.bookings.length ? state.bookings.map(run => `<div class="ticket-card"><div class="ticket-body"><h3>${escapeHtml(run.title)}</h3><p class="muted-text">${escapeHtml(formatDate(run.starts_at))} · ${escapeHtml(run.location)}</p><button class="primary-btn" data-chat-run="${escapeHtml(run.id)}" data-page="chats">افتح المحادثة</button></div></div>`).join('') : '<p class="empty-state">لم تحجز أي جَرية حتى الآن.</p>';
}
if ($('search'))$('search').addEventListener('input', renderEvents);

function getRunCategory(run, now = Date.now()) {
  if (run.run_status === 'previous') return 'previous';
  const startsAt = new Date(run.starts_at).getTime();
  if (!Number.isFinite(startsAt)) return ['upcoming', 'current'].includes(run.run_status) ? run.run_status : 'upcoming';
  if (Number.isFinite(startsAt) && now >= startsAt) return 'previous';
  if (['upcoming', 'current'].includes(run.run_status)) return run.run_status;
  return 'upcoming';
}

function isBookingClosed(run, now = Date.now()) {
  const startsAt = new Date(run.starts_at).getTime();
  return run.run_status === 'previous' || !Number.isFinite(startsAt) || now >= startsAt - 30 * 60_000;
}
setInterval(() => { if (state.events.length) renderEvents(); }, 10_000);

function openModal(id) {
  const run = state.events.find(item => item.id === id);
  if (!run) return;
  const booked = state.bookings.some(b => b.id === run.id);
  const remaining = Math.max(0, Number(run.seats_total || 0) - Number(run.seats_booked || 0));
  const bookingClosed = isBookingClosed(run);
  const ticketText = remaining === 0 ? 'التذاكر انتهت' : bookingClosed && !booked ? 'انتهى التسجيل قبل موعد الجَرية بنصف ساعة' : `المقاعد المتبقية: ${remaining}`;

  $('modal-content').innerHTML = `
    <div class="modal-body">
      <h2>${escapeHtml(run.title)}</h2>
      <p class="muted-text">منظّم الجَرية: Stride</p>
      <p>◷ الموعد: ${escapeHtml(formatDate(run.starts_at))}</p>
      <p>⌖ التجمع: ${escapeHtml(run.location)}</p>
      <p>المسافة: ${escapeHtml(run.distance_km)} كم</p>
      <p>${ticketText}</p>
      <p>السعر: ${escapeHtml(run.price || 'مجانية')}</p>
      <button class="primary-btn" id="book-now-btn" ${!booked && (remaining < 1 || bookingClosed) ? 'disabled' : ''}>${booked ? 'إلغاء الحجز' : remaining < 1 ? 'التذاكر انتهت' : bookingClosed ? 'انتهى التسجيل' : 'حجز مكان الآن'}</button>
      ${isAdmin() ? `<label class="run-status-control">حالة الجَرية
        <select id="run-status-choice">
          <option value="automatic" ${run.run_status === 'automatic' ? 'selected' : ''}>تلقائي حسب الموعد</option>
          <option value="upcoming" ${run.run_status === 'upcoming' ? 'selected' : ''}>قادمة يدويًا</option>
          <option value="current" ${run.run_status === 'current' ? 'selected' : ''}>حالية يدويًا</option>
          <option value="previous" ${run.run_status === 'previous' ? 'selected' : ''}>سابقة يدويًا</option>
        </select>
      </label><button class="secondary-btn" id="save-run-settings">حفظ حالة الجَرية</button>
        <button class="danger-btn" id="delete-run-btn" type="button">حذف الجَرية نهائيًا</button>` : ''}
    </div>`;

  $('book-now-btn').onclick = () => toggleBooking(run, booked);
  if (isAdmin()) {
    $('save-run-settings').onclick = () => saveRunSettings(run);
    $('delete-run-btn').onclick = event => deleteRun(run, event.currentTarget);
  }
  $('modal').classList.add('active');
}

async function toggleBooking(run, booked) {
  if (booked) {
    const { error } = await db.from('bookings').delete().eq('run_id', run.id).eq('user_id', state.user.id);
    if (error) return toast(error.code === '23505' ? 'أنت مسجل بالفعل في هذه الجَرية.' : 'تعذّر إلغاء الحجز. حاول مرة أخرى.');
    if (state.activeChatRun === run.id) {
      state.activeChatRun = null;
      $('chat-panel').innerHTML = '<p class="empty-state">ألغيت حجزك؛ لم تعد عضوًا في محادثة الجَرية.</p>';
    }
    toast('تم إلغاء الحجز');
  } else {
    if (isBookingClosed(run)) return toast('انتهى التسجيل قبل موعد الجَرية بنصف ساعة.');
    const { error } = await db.from('bookings').insert({ run_id: run.id, user_id: state.user.id });
    if (error) return toast(error.message?.includes('full') ? 'التذاكر انتهت.' : error.code === '23505' ? 'أنت مسجل بالفعل في هذه الجَرية.' : 'تعذّر إتمام الحجز. حاول مرة أخرى.');
    toast('تم الحجز بنجاح');
  }
  $('modal').classList.remove('active');
  await refreshData();
}

async function saveRunSettings(run) {
  const { error } = await db.from('runs').update({ run_status: $('run-status-choice').value }).eq('id', run.id);
  if (error) return toast('تعذّر حفظ حالة الجَرية.');
  $('modal').classList.remove('active');
  await refreshData();
  toast('تم تحديث حالة الجَرية.');
}

async function deleteRun(run, button) {
  if (!isAdmin()) return toast('حذف الجريات متاح للأدمن فقط.');
  if (!window.confirm(`هل تريد حذف جَرية «${run.title}» نهائيًا؟ سيتم حذف الحجوزات ومحادثتها أيضًا.`)) return;
  button.disabled = true;
  const { error } = await db.from('runs').delete().eq('id', run.id);
  if (error) {
    button.disabled = false;
    console.error('Run deletion failed:', error.code || 'unknown');
    return toast('تعذّر حذف الجَرية. حاول مرة أخرى.');
  }

  let imageCleanupFailed = false;
  if (run.image_url) {
    try {
      const imageUrl = new URL(run.image_url);
      const objectPrefix = '/storage/v1/object/public/runmate-run-images/';
      const marker = imageUrl.pathname.indexOf(objectPrefix);
      if (imageUrl.origin === new URL(SUPABASE_URL).origin && marker >= 0) {
        const imagePath = decodeURIComponent(imageUrl.pathname.slice(marker + objectPrefix.length));
        if (imagePath) {
          const { error: cleanupError } = await db.storage.from('runmate-run-images').remove([imagePath]);
          imageCleanupFailed = !!cleanupError;
        }
      }
    } catch (cleanupError) {
      imageCleanupFailed = true;
      console.error('Run image cleanup failed:', cleanupError?.statusCode || 'unknown');
    }
  }

  $('modal').classList.remove('active');
  await refreshData();
  toast(imageCleanupFailed ? 'حُذفت الجَرية والحجوزات والمحادثة، لكن تعذّر حذف صورتها.' : 'تم حذف الجَرية وحجوزاتها ومحادثتها.');
}

async function toggleReadOnly(run) {
  const { error } = await db.from('runs').update({ admin_only_chat: !run.admin_only_chat }).eq('id', run.id);
  if (error) return toast('تعذّر تحديث صلاحية الكتابة في الشات.');
  toast('تم تحديث إعداد المحادثة');
  $('modal').classList.remove('active');
  await refreshData();
  if ($('page-chats').classList.contains('active')) await openChat(run.id);
}

$('modal-close').addEventListener('click', () =>$('modal').classList.remove('active'));

/* إنشاء جَرية جديدة (للأدمن فقط) */
$('organizer-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return toast('هذه العملية متاحة للأدمن فقط');

  const imageFile = $('org-image-file').files?.[0];
  const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (imageFile && !acceptedImageTypes.includes(imageFile.type)) return toast('اختر صورة JPG أو PNG أو WebP.');
  if (imageFile && imageFile.size > 5 * 1024 * 1024) return toast('يجب ألا يتجاوز حجم الصورة 5 ميغابايت.');

  let uploadedImagePath = null;
  let imageUrl = $('org-image').value.trim() || null;
  if (imageFile) {
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[imageFile.type];
    uploadedImagePath = `${state.user.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await db.storage.from('runmate-run-images').upload(uploadedImagePath, imageFile, { contentType: imageFile.type, upsert: false });
    if (uploadError) {
      console.error('Run image upload failed:', uploadError.statusCode || 'unknown');
      return toast('تعذّر رفع صورة الجَرية. حاول مجدداً.');
    }
    imageUrl = db.storage.from('runmate-run-images').getPublicUrl(uploadedImagePath).data.publicUrl;
  }

  const date = $('org-date').value;
  const time = $('org-time').value;
  const startsAt = new Date(`${date}T${time}`).toISOString();

  const row = {
    title: $('org-title').value.trim(),
    starts_at: startsAt,
    location: $('org-location').value.trim(),
    distance_km: Number($('org-distance').value),
    seats_total: Number($('org-seats').value),
    price: $('org-price').value.trim(),
    image_url: imageUrl,
    admin_only_chat: false,
    run_status: $('org-status').value,
    organizer_name: state.profile.display_name,
    created_by: state.user.id
  };

  const { error } = await db.from('runs').insert(row);
  if (error) {
    if (uploadedImagePath) {
      const { error: cleanupError } = await db.storage.from('runmate-run-images').remove([uploadedImagePath]);
      if (cleanupError) console.error('Run image cleanup failed:', cleanupError.statusCode || 'unknown');
    }
    return toast('لم يتم إنشاء الجَرية: ' + error.message);
  }

  $('organizer-form').reset();
  await refreshData();
  navigateTo('home');
  toast('تم إنشاء الجَرية وتسجيلك فيها تلقائيًا. الشات جاهز لك.');
});

/* المحادثات */
async function renderChatsList() {
  if (!state.user) return;
  const { data, error } = await db.from('bookings').select('run_id, runs(id,title,admin_only_chat)').eq('user_id', state.user.id);
  if (error) { $('chat-runs').innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`; return; }

  const runs = (data || []).map(row => row.runs).filter(Boolean);
  $('chat-runs').innerHTML = runs.length 
    ? runs.map(run => `<button class="chat-run-btn ${state.activeChatRun === run.id ? 'active' : ''}" data-chat-run="${escapeHtml(run.id)}"><b>${escapeHtml(run.title)}</b><small>${run.admin_only_chat ? 'رسائل الأدمن فقط' : 'محادثة المشاركين'}</small></button>`).join('') 
    : '<p class="empty-state">احجز في جَرية أولًا لتظهر محادثتها هنا.</p>';
}

async function openChat(runId) {
  state.activeChatRun = runId;
  const run = state.bookings.find(item => item.id === runId) || state.events.find(item => item.id === runId);
  if (!run && !isAdmin()) return toast('المحادثة متاحة للمشاركين الذين حجزوا فقط');

  navigateTo('chats');
  await renderChatsList();

  $('chat-panel').innerHTML = `<header class="chat-header"><div><h3>${escapeHtml(run?.title || 'محادثة الجَرية')}</h3><p class="muted-text">${run?.admin_only_chat ? 'الكتابة للأدمن والمنظّم فقط' : 'المشاركون يستطيعون الكتابة'}</p></div>${isAdmin() ? `<button class="secondary-btn" id="toggle-readonly" type="button">${run?.admin_only_chat ? 'السماح للمشاركين بالكتابة' : 'قصر الكتابة على الأدمن والمنظّم'}</button>` : ''}</header><div class="chat-messages" id="chat-messages"><p class="empty-state">جارٍ تحميل الرسائل...</p></div><form id="chat-form" class="chat-form"><input id="chat-text" maxlength="2000" placeholder="اكتب رسالة..." required><button class="primary-btn" type="submit">إرسال</button></form>`;
  if (isAdmin()) $('toggle-readonly').onclick = () => toggleReadOnly(run);

  const { data, error } = await db.rpc('get_run_chat_messages', { p_run_id: runId });
  if (error) { $('chat-messages').innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`; return; }

  const isReadOnly = !!run?.admin_only_chat && !isAdmin();
  $('chat-form').hidden = isReadOnly;
  
  if (isReadOnly) {
    $('chat-panel').insertAdjacentHTML('afterbegin', '<p class="readonly-note">المحادثة للقراءة فقط؛ إرسال الرسائل متاح للأدمن والمنظمين فقط.</p>');
  }

  await renderChatMessages(data || [], runId);

  $('chat-form').onsubmit = async e => {
    e.preventDefault();
    const body = $('chat-text').value.trim();
    if (!body) return;

    const { error: sendError } = await db.from('messages').insert({ run_id: runId, user_id: state.user.id, body });
    if (sendError) return toast('تعذر إرسال الرسالة: ' + sendError.message);
    $('chat-text').value = '';
    const { data: latestMessages, error: messagesError } = await db.rpc('get_run_chat_messages', { p_run_id: runId });
    if (messagesError) return toast('تم إرسال الرسالة، لكن تعذر تحديث المحادثة. أعد فتحها لاحقًا.');
    await renderChatMessages(latestMessages || [], runId);
  };
}

async function startApp() {
  if (!db) {
    $('auth-screen').style.display = 'flex';$('app-shell').classList.remove('authenticated');
    return;
  }
  if (!state.authListener) {
    state.authListener = true;
    db.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') showPasswordRecovery();
      if (event === 'SIGNED_IN' && session && !state.passwordRecovery) setTimeout(() => loadSession(session), 0);
      if (event === 'SIGNED_OUT') location.reload();
    });
  }
  const { data: { session } } = await db.auth.getSession();
  if (state.passwordRecovery) showPasswordRecovery();
  else if (session) await loadSession(session);
}
startApp();

async function loadClips() {
  const box = $('clips-list');
  if (!box || !state.user) return;
  box.innerHTML = '<p class="empty-state">جارٍ تحميل Clips...</p>';
  const { data, error } = await db.from('clips').select('id,storage_path,caption,media_type,status,created_at').order('created_at', { ascending: false }).limit(60);
  if (error) {
    box.innerHTML = '<p class="empty-state">تعذّر تحميل المقاطع. حاول مجدداً لاحقاً.</p>';
    console.error('Clips query failed:', error.code || 'unknown');
    return;
  }
  state.clips = data || [];
  const signed = await Promise.all(state.clips.map(async clip => {
    const { data: urlData, error: urlError } = await db.storage.from('runmate-clips').createSignedUrl(clip.storage_path, 900);
    if (urlError) console.error('Clip URL unavailable:', urlError.statusCode || 'unknown');
    return { ...clip, signedUrl: urlData?.signedUrl || '' };
  }));
  box.innerHTML = signed.length ? signed.map(clip => clipCard(clip, false)).join('') : '<p class="empty-state">لا توجد مقاطع بعد. شارك أول لحظة جري!</p>';
}

function clipCard(clip, reviewMode) {
  const media = clip.signedUrl ? (clip.media_type === 'video'
    ? `<video src="${escapeHtml(clip.signedUrl)}" controls preload="metadata" playsinline></video>`
    : `<img src="${escapeHtml(clip.signedUrl)}" alt="مقطع من مجتمع Stride" loading="lazy">`) : '<div class="empty-state">تعذّر تحميل الملف</div>';
  const status = `<span class="clip-status ${escapeHtml(clip.status)}">${clip.status === 'pending' ? 'قيد المراجعة' : clip.status === 'approved' ? 'مقبول' : 'مرفوض'}</span>`;
  const actions = reviewMode && clip.status === 'pending' ? `<div class="clip-actions"><button class="primary-btn" data-review-clip="${escapeHtml(clip.id)}" data-status="approved">قبول</button><button class="secondary-btn" data-review-clip="${escapeHtml(clip.id)}" data-status="rejected">رفض</button></div>` : '';
  return `<article class="clip-card">${media}<div class="clip-card-body">${status}<p>${escapeHtml(clip.caption || '')}</p><small>${escapeHtml(formatDate(clip.created_at))}</small>${actions}</div></article>`;
}

$('clip-upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('clip-file').files?.[0];
  const status = $('clip-upload-status');
  const accepted = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
  if (!file || !accepted.includes(file.type)) return status.textContent = 'اختر صورة JPG أو PNG أو WebP، أو فيديو MP4 أو WebM أو MOV.';
  if (file.size > 50 * 1024 * 1024) return status.textContent = 'يجب ألا يتجاوز حجم الملف 50 ميغابايت.';
  const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
  const path = `${state.user.id}/${crypto.randomUUID()}.${file.name.split('.').pop().toLowerCase()}`;
  const caption = $('clip-caption').value.trim();
  status.textContent = 'جارٍ رفع الملف...';
  const { error: uploadError } = await db.storage.from('runmate-clips').upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) {
    status.textContent = 'تعذّر رفع الملف. تحقق من إعداد Supabase وحاول مجدداً.';
    console.error('Clip upload failed:', uploadError.statusCode || 'unknown');
    return;
  }
  const { error: insertError } = await db.from('clips').insert({ user_id: state.user.id, storage_path: path, caption, media_type: mediaType, status: 'pending' });
  if (insertError) {
    const { error: cleanupError } = await db.storage.from('runmate-clips').remove([path]);
    status.textContent = 'تعذّر إرسال الملف للمراجعة. أُلغيت عملية الرفع.';
    console.error('Clip record insert failed:', insertError.code || 'unknown', cleanupError ? 'Storage cleanup failed' : '');
    return;
  }
  event.target.reset();
  status.textContent = 'تم الإرسال. سيظهر المقطع بعد مراجعة الإدارة.';
  await loadClips();
});

$('profile-photo-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('profile-photo-file').files?.[0];
  const status = $('profile-photo-status');
  const accepted = ['image/jpeg', 'image/png', 'image/webp'];
  if (!file || !accepted.includes(file.type)) return status.textContent = 'اختر صورة JPG أو PNG أو WebP.';
  if (file.size > 5 * 1024 * 1024) return status.textContent = 'يجب ألا يتجاوز حجم الصورة 5 ميغابايت.';

  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[file.type];
  const path = `${state.user.id}/${crypto.randomUUID()}.${extension}`;
  const oldPath = state.profile?.avatar_path;
  status.textContent = 'جارٍ رفع صورة الحساب...';
  const { error: uploadError } = await db.storage.from('runmate-avatars').upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) {
    status.textContent = 'تعذّر رفع الصورة. حاول مجدداً.';
    console.error('Profile photo upload failed:', uploadError.statusCode || 'unknown');
    return;
  }

  const { data: updatedProfile, error: updateError } = await db.from('profiles').update({ avatar_path: path }).eq('id', state.user.id).select('id,display_name,avatar_path,role,created_at').single();
  if (updateError) {
    const { error: cleanupError } = await db.storage.from('runmate-avatars').remove([path]);
    status.textContent = 'تعذّر حفظ صورة الحساب. حاول مجدداً.';
    console.error('Profile photo update failed:', updateError.code || 'unknown', cleanupError ? 'Storage cleanup failed' : '');
    return;
  }

  state.profile = updatedProfile;
  const privateUrl = await getPrivateAvatarUrl(path);
  if (!privateUrl) {
    await db.from('profiles').update({ avatar_path: oldPath || null }).eq('id', state.user.id);
    return status.textContent = 'تم رفع الصورة لكن تعذّر إنشاء رابط عرض آمن. حاول مجدداً.';
  }
  const name = state.profile.display_name || 'مستخدم Stride';
  const markup = `<img src="${escapeHtml(privateUrl)}" alt="صورة ${escapeHtml(name)}">`;
  $('user-avatar-initials').innerHTML = markup;
  $('profile-avatar-large').innerHTML = markup;
  if (oldPath) {
    const { error: removeError } = await db.storage.from('runmate-avatars').remove([oldPath]);
    if (removeError) console.error('Old profile photo cleanup failed:', removeError.statusCode || 'unknown');
  }
  event.target.reset();
  status.textContent = 'تم تحديث صورة الحساب.';
});

$('profile-logout-btn').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'جارٍ تسجيل الخروج...';
  const { error } = await db.auth.signOut();
  if (error) {
    button.disabled = false;
    button.textContent = 'تسجيل الخروج';
    return toast('تعذّر تسجيل الخروج. حاول مرة أخرى.');
  }
  location.reload();
});

async function loadAdminPanel() {
  if (!isAdmin()) return;
  const pendingBox = $('admin-pending-clips');
  const usersBox = $('admin-users');
  pendingBox.innerHTML = '<p class="empty-state">جارٍ التحميل...</p>';
  usersBox.innerHTML = '<p class="empty-state">جارٍ التحميل...</p>';
  const [clipsResult, usersResult] = await Promise.all([
    db.from('clips').select('id,storage_path,caption,media_type,status,created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(100),
    db.from('profiles').select('id,display_name,role,created_at').order('created_at', { ascending: false }).limit(100)
  ]);
  if (clipsResult.error) {
    pendingBox.innerHTML = '<p class="empty-state">تعذّر تحميل قائمة المراجعة.</p>';
    console.error('Admin clips query failed:', clipsResult.error.code || 'unknown');
  } else {
    const reviewClips = await Promise.all((clipsResult.data || []).map(async clip => {
      const { data } = await db.storage.from('runmate-clips').createSignedUrl(clip.storage_path, 900);
      return { ...clip, signedUrl: data?.signedUrl || '' };
    }));
    pendingBox.innerHTML = reviewClips.length ? reviewClips.map(clip => clipCard(clip, true)).join('') : '<p class="empty-state">لا توجد مقاطع معلّقة.</p>';
  }
  if (usersResult.error) {
    usersBox.innerHTML = '<p class="empty-state">تعذّر تحميل المستخدمين.</p>';
    console.error('Admin users query failed:', usersResult.error.code || 'unknown');
  } else {
    const users = usersResult.data || [];
    usersBox.innerHTML = users.length ? `<table><thead><tr><th>الاسم</th><th>الدور</th><th>تاريخ الإنشاء</th>${isOwner() ? '<th>إدارة الدور</th>' : ''}</tr></thead><tbody>${users.map(user => `<tr><td>${escapeHtml(user.display_name || 'عضو')}</td><td>${user.role === 'owner' ? 'مالك' : user.role === 'admin' ? 'مدير' : 'عضو'}</td><td>${escapeHtml(formatDate(user.created_at))}</td>${isOwner() ? `<td><select data-role-choice="${escapeHtml(user.id)}" aria-label="دور ${escapeHtml(user.display_name || 'عضو')}"><option value="member" ${user.role === 'member' ? 'selected' : ''}>عضو</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>أدمن</option><option value="owner" ${user.role === 'owner' ? 'selected' : ''}>مالك</option></select><button class="secondary-btn role-save-btn" type="button" data-save-role="${escapeHtml(user.id)}">حفظ الدور</button></td>` : ''}</tr>`).join('')}</tbody></table>` : '<p class="empty-state">لا يوجد مستخدمون.</p>';
  }
}

document.addEventListener('click', async event => {
  const roleButton = event.target.closest('[data-save-role]');
  if (roleButton) {
    if (!isOwner()) return toast('إدارة الأدوار متاحة للمالك فقط.');
    const role = roleButton.closest('tr')?.querySelector('[data-role-choice]')?.value;
    if (!role) return toast('اختر دورًا صالحًا.');
    roleButton.disabled = true;
    const { error } = await db.rpc('set_profile_role', { target_profile_id: roleButton.dataset.saveRole, requested_role: role });
    if (error) {
      roleButton.disabled = false;
      toast(error.message?.includes('last owner') ? 'لا يمكن إزالة دور آخر مالك.' : 'تعذّر تحديث الدور.');
      console.error('Role update failed:', error.code || 'unknown', error.message || '');
      return;
    }
    toast('تم تحديث الدور.');
    await loadAdminPanel();
    return;
  }
  const button = event.target.closest('[data-review-clip]');
  if (!button || !isAdmin()) return;
  button.disabled = true;
  const { error } = await db.from('clips').update({ status: button.dataset.status, reviewed_at: new Date().toISOString(), reviewed_by: state.user.id }).eq('id', button.dataset.reviewClip).eq('status', 'pending');
  if (error) {
    button.disabled = false;
    toast('تعذّر تحديث حالة المقطع.');
    console.error('Clip review failed:', error.code || 'unknown');
    return;
  }
  toast(button.dataset.status === 'approved' ? 'تم قبول المقطع.' : 'تم رفض المقطع.');
  await loadAdminPanel();
});


$('resend-confirmation-btn').addEventListener('click', async () => {
  if (!db) return showMessage('إعدادات Supabase غير مكتملة.');
  const email = $('reg-identity').value.trim() || $('login-identity').value.trim();
  if (!email || !email.includes('@')) return showMessage('أدخل بريدك الإلكتروني في نموذج التسجيل أو الدخول أولاً.');
  showMessage('جارٍ إرسال رسالة التأكيد...');
  const { error } = await db.auth.resend({ type: 'signup', email, options: { emailRedirectTo: AUTH_REDIRECT_URL } });
  if (error) {
    console.error('Confirmation resend failed:', error.code || 'unknown');
    return showMessage('تعذّر إرسال رسالة التأكيد. تحقق من البريد وحاول مجدداً لاحقاً.');
  }
  showMessage('إذا كان الحساب بحاجة إلى التأكيد، ستصلك رسالة على بريدك الإلكتروني.');
});






