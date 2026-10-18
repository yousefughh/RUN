/* RUNMATE + Supabase Client Config */
const SUPABASE_URL = 'https://trqrpoployvsuuitffji.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_H54WIGq4spz51QFkSjmR8w_ohdXdv90';
const supabaseReady = SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('YOUR_');
const db = supabaseReady ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const state = { user: null, profile: null, events: [], bookings: [], activeChatRun: null };
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const isAdmin = () => state.profile?.role === 'admin';

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

/* إنشاء حساب جديد */
$('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  if (!db) return showMessage('أضف إعدادات Supabase أولاً.');

  const name = $('reg-name').value.trim();
  const email = $('reg-identity').value.trim();
  const phone = $('reg-phone')?.value.trim() || '';
  const password = $('reg-pass').value;

  showMessage('جارٍ إنشاء الحساب...');

  const { data, error } = await db.auth.signUp({
    email,
    password,
    options: { data: { display_name: name, phone } }
  });

  if (error) return showMessage(error.message);

  if (data.user) {
    const { error: profileError } = await db.from('profiles').upsert({
      id: data.user.id,
      display_name: name,
      phone: phone,
      role: 'member'
    }, { onConflict: 'id' });

    if (profileError) console.error('خطأ في حفظ البروفايل:', profileError.message);

    if (data.session) {
      await loadSession(data.session);
      toast('تم إنشاء الحساب بنجاح');
    } else {
      showMessage('راجع بريدك الإلكتروني لتأكيد الحساب، ثم سجّل الدخول.');
    }
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

  if (result.error) return showMessage(result.error.message);
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
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href,
  });
  if (error) return showMessage(error.message);
  toast('تم إرسال رابط إعادة تعيين كلمة السر إلى إيميلك');
});

/* تحميل الجلسة وتحميل البيانات */
async function loadSession(session) {
  state.user = session.user;
  let { data: profile, error } = await db.from('profiles').select('*').eq('id', state.user.id).single();

  if (error || !profile) {
    const fallbackName = state.user.user_metadata?.display_name || state.user.email?.split('@')[0] || 'مستخدم RUNMATE';
    const fallbackPhone = state.user.user_metadata?.phone || '';
    const { error: saveError } = await db.from('profiles').upsert({
      id: state.user.id, display_name: fallbackName, phone: fallbackPhone, role: 'member'
    }, { onConflict: 'id' });
    if (saveError) {
      showMessage('تعذر تحميل الملف الشخصي. راجع تنفيذ schema.sql وصلاحيات profiles في Supabase.');
      console.error('تعذر إنشاء الملف الشخصي:', saveError.message);
      return;
    }
    const retry = await db.from('profiles').select('*').eq('id', state.user.id).single();
    profile = retry.data;
    error = retry.error;
  }

  if (error || !profile) {
    showMessage('تعذر تحميل الملف الشخصي. راجع قواعد Supabase.');
    return;
  }

  state.profile = profile;
  $('auth-screen').style.display = 'none';$('app-shell').classList.add('authenticated');

  const name = profile.display_name || 'مستخدم RUNMATE';
  const email = state.user.email || '';
  const phone = profile.phone || '';
  const initial = Array.from(name)[0] || 'U';

  $('user-avatar-initials').textContent = initial;
  $('profile-avatar-large').textContent = initial;
  $('profile-name').textContent = name;
  $('profile-email').textContent = email;
  $('profile-phone').textContent = phone ? `الهاتف: ${phone}` : '';
  $('profile-role').textContent = isAdmin() ? 'حساب أدمن' : 'عضو RUNMATE';

  document.querySelectorAll('.admin-only').forEach(el => el.hidden = !isAdmin());

  await refreshData();
  navigateTo('home');

  db.auth.onAuthStateChange((event, currentSession) => {
    if (event === 'SIGNED_OUT' || !currentSession) location.reload();
  });
}

async function refreshData() {
  const [eventsRes, bookingsRes] = await Promise.all([
    db.from('runs').select('*').order('starts_at', { ascending: true }),
    db.from('bookings').select('run_id, runs(*)').eq('user_id', state.user.id)
  ]);

  if (eventsRes.error) return toast('تعذر تحميل الجريات: ' + eventsRes.error.message);

  state.events = eventsRes.data || [];
  state.bookings = (bookingsRes.data || []).map(row => row.runs).filter(Boolean);

  renderEvents();
  renderChatsList();
}

function navigateTo(pageId) {
  if (pageId === 'organizer' && !isAdmin()) {
    toast('إنشاء الجريات متاح للأدمن فقط');
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${pageId}`));
  document.querySelectorAll('[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === pageId));
  
  const names = { home: 'الرئيسية', explore: 'اكتشف', tickets: 'حجوزاتي', chats: 'المحادثات', profile: 'حسابي', organizer: 'إدارة الجريات' };
  $('crumb-active').textContent = names[pageId] || 'RUNMATE';

  if (pageId === 'chats') renderChatsList();
}

document.addEventListener('click', e => {
  const pageBtn = e.target.closest('[data-page]');
  if (pageBtn) { e.preventDefault(); navigateTo(pageBtn.dataset.page); }
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
  return `<article class="run-card">
    <div class="run-image"><img src="${escapeHtml(run.image_url || 'https://images.unsplash.com/photo-1476480862126-209bfaa8edc8?w=600&auto=format&fit=crop&q=80')}" alt=""><span class="run-badge">${seats} مقعد متاح</span></div>
    <div class="run-info"><div class="run-org">✦ ${escapeHtml(run.organizer_name || 'RUNMATE')}</div>
    <h3>${escapeHtml(run.title)}</h3><div class="run-detail"><span>◷ ${escapeHtml(formatDate(run.starts_at))}</span><span>⌖ ${escapeHtml(run.location)} · ${escapeHtml(run.distance_km)} كم</span></div>
    <div class="run-foot"><div class="run-price">${escapeHtml(run.price || 'مجانية')}</div><button class="run-open" data-event="${escapeHtml(run.id)}">التفاصيل ↙</button></div></div></article>`;
}

function renderEvents() {
  const query = ($('search')?.value || '').trim().toLowerCase();
  const list = state.events.filter(run => `${run.title} ${run.location}`.toLowerCase().includes(query));

  $('home-runs').innerHTML = state.events.length ? state.events.map(createRunCard).join('') : '<p class="empty-state">لا توجد جريات قادمة حاليًا.</p>';
  $('explore-runs').innerHTML = list.length ? list.map(createRunCard).join('') : '<p class="empty-state">لا توجد جريات تطابق بحثك.</p>';
  $('ticket-count').textContent = state.bookings.length;
  $('ticket-list').innerHTML = state.bookings.length ? state.bookings.map(run => `<div class="ticket-card"><div class="ticket-body"><h3>${escapeHtml(run.title)}</h3><p class="muted-text">${escapeHtml(formatDate(run.starts_at))} · ${escapeHtml(run.location)}</p><button class="primary-btn" data-chat-run="${escapeHtml(run.id)}" data-page="chats">افتح المحادثة</button></div></div>`).join('') : '<p class="empty-state">لم تحجز أي جَرية حتى الآن.</p>';
}
if ($('search'))$('search').addEventListener('input', renderEvents);

function openModal(id) {
  const run = state.events.find(item => item.id === id);
  if (!run) return;
  const booked = state.bookings.some(b => b.id === run.id);
  const remaining = Math.max(0, Number(run.seats_total || 0) - Number(run.seats_booked || 0));

  $('modal-content').innerHTML = `
    <div class="modal-body">
      <h2>${escapeHtml(run.title)}</h2>
      <p class="muted-text">منظم الجَرية: ${escapeHtml(run.organizer_name || 'RUNMATE')}</p>
      <p>◷ الموعد: ${escapeHtml(formatDate(run.starts_at))}</p>
      <p>⌖ التجمع: ${escapeHtml(run.location)}</p>
      <p>المسافة: ${escapeHtml(run.distance_km)} كم</p>
      <p>المقاعد المتبقية: ${remaining}</p>
      <p>السعر: ${escapeHtml(run.price || 'مجانية')}</p>
      <button class="primary-btn" id="book-now-btn" ${!booked && remaining < 1 ? 'disabled' : ''}>${booked ? 'إلغاء الحجز' : 'حجز مكان الآن'}</button>
      ${isAdmin() ? `<button class="secondary-btn" id="toggle-readonly">${run.admin_only_chat ? 'السماح للأعضاء بالكتابة في الشات' : 'جعل الشات للقراءة فقط'}</button>` : ''}
    </div>`;

  $('book-now-btn').onclick = () => toggleBooking(run, booked);
  if (isAdmin()) $('toggle-readonly').onclick = () => toggleReadOnly(run);$('modal').classList.add('active');
}

async function toggleBooking(run, booked) {
  if (booked) {
    const { error } = await db.from('bookings').delete().eq('run_id', run.id).eq('user_id', state.user.id);
    if (error) return toast(error.message);
    toast('تم إلغاء الحجز');
  } else {
    const { error } = await db.from('bookings').insert({ run_id: run.id, user_id: state.user.id });
    if (error) return toast(error.message);
    toast('تم الحجز بنجاح');
  }
  $('modal').classList.remove('active');
  await refreshData();
}

async function toggleReadOnly(run) {
  const { error } = await db.from('runs').update({ admin_only_chat: !run.admin_only_chat }).eq('id', run.id);
  if (error) return toast(error.message);
  toast('تم تحديث إعداد المحادثة');
  $('modal').classList.remove('active');
  await refreshData();
}

$('modal-close').addEventListener('click', () =>$('modal').classList.remove('active'));

/* إنشاء جَرية جديدة (للأدمن فقط) */
$('organizer-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return toast('هذه العملية متاحة للأدمن فقط');

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
    image_url: $('org-image').value.trim() || null,
    admin_only_chat: $('org-admin-only').checked,
    organizer_name: state.profile.display_name,
    created_by: state.user.id
  };

  const { error } = await db.from('runs').insert(row);
  if (error) return toast('لم يتم إنشاء الجَرية: ' + error.message);

  $('organizer-form').reset();
  await refreshData();
  navigateTo('explore');
  toast('تم إنشاء الجَرية بنجاح');
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
  const run = state.bookings.find(item => item.id === runId);
  if (!run && !isAdmin()) return toast('المحادثة متاحة للمشاركين الذين حجزوا فقط');

  navigateTo('chats');
  await renderChatsList();

  $('chat-panel').innerHTML = '<div class="chat-messages" id="chat-messages"><p class="empty-state">جارٍ تحميل الرسائل...</p></div><form id="chat-form" class="chat-form"><input id="chat-text" maxlength="2000" placeholder="اكتب رسالة..." required><button class="primary-btn" type="submit">إرسال</button></form>';

  const { data, error } = await db.from('messages').select('id,body,created_at,user_id,profiles(display_name)').eq('run_id', runId).order('created_at', { ascending: true });
  if (error) { $('chat-messages').innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`; return; }

  const isReadOnly = !!run?.admin_only_chat && !isAdmin();
  $('chat-form').hidden = isReadOnly;
  
  if (isReadOnly) {
    $('chat-panel').insertAdjacentHTML('afterbegin', '<p class="readonly-note">المحادثة للقراءة فقط؛ إرسال الرسائل متاح للأدمن والمنظمين فقط.</p>');
  }

  $('chat-messages').innerHTML = data?.length 
    ? data.map(msg => `<div class="message ${msg.user_id === state.user.id ? 'mine' : ''}"><b>${escapeHtml(msg.profiles?.display_name || 'مستخدم')}</b><p>${escapeHtml(msg.body)}</p><small>${escapeHtml(formatDate(msg.created_at))}</small></div>`).join('') 
    : '<p class="empty-state">لا توجد رسائل بعد. ابدأوا المحادثة!</p>';

  $('chat-messages').scrollTop =$('chat-messages').scrollHeight;

  $('chat-form').onsubmit = async e => {
    e.preventDefault();
    const body = $('chat-text').value.trim();
    if (!body) return;

    const { error: sendError } = await db.from('messages').insert({ run_id: runId, user_id: state.user.id, body });
    if (sendError) return toast('تعذر إرسال الرسالة: ' + sendError.message);
    await openChat(runId);
  };
}

$('logout-btn').addEventListener('click', async () => {
  if (db) await db.auth.signOut();
  location.reload();
});

async function startApp() {
  if (!db) {
    $('auth-screen').style.display = 'flex';$('app-shell').classList.remove('authenticated');
    return;
  }
  const { data: { session } } = await db.auth.getSession();
  if (session) await loadSession(session);
}
startApp();