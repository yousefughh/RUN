/* RUNMATE + Supabase Client Config */
const SUPABASE_URL = 'https://trqrpoployvsuuitffji.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_H54WIGq4spz51QFkSjmR8w_ohdXdv90';
const supabaseReady = SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('YOUR_');
const db = supabaseReady ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const state = { user: null, profile: null, events: [], bookings: [], activeChatRun: null, authListener: false, clips: [] };
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
  const rawPhone = $('reg-phone')?.value.trim() || '';
  const phone = rawPhone.replace(/[()\s-]/g, '');
  if (rawPhone && !/^\+?[1-9]\d{6,14}$/.test(phone)) return showMessage('أدخل رقم هاتف صحيحاً بصيغة دولية، أو اترك الحقل فارغاً.');
  const password = $('reg-pass').value;

  showMessage('جارٍ إنشاء الحساب...');

  const { data, error } = await db.auth.signUp({
    email,
    password,
    options: { data: { display_name: name, phone } }
  });

  if (error) { console.error('Signup failed:', error.code || 'unknown'); return showMessage('تعذّر إنشاء الحساب. تحقق من البيانات وحاول مجدداً.'); }

  if (data.user) {
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
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href,
  });
  if (error) { console.error('Password reset request failed:', error.code || 'unknown'); return showMessage('تعذّر إرسال رابط إعادة التعيين. حاول مجدداً لاحقاً.'); }
  toast('تم إرسال رابط إعادة تعيين كلمة السر إلى بريدك الإلكتروني.');
});

/* تحميل الجلسة وتحميل البيانات */
async function loadSession(session) {
  state.user = session.user;
  let { data: profile, error } = await db.from('profiles').select('*').eq('id', state.user.id).single();

  if (error || !profile) {
    showMessage('تعذّر العثور على ملف الحساب. طبّق supabase-migration.sql في مشروع Supabase ثم سجّل الدخول مجدداً.');
    console.error('Profile lookup failed:', error?.code || 'profile missing');
    return;
  }

  state.profile = profile;
  $('auth-screen').style.display = 'none';$('app-shell').classList.add('authenticated');

  const name = profile.display_name || 'مستخدم RUNMATE';
  const email = state.user.email || '';
  const phone = profile.phone || '';
  const initial = Array.from(name)[0] || 'U';

  const avatarUrl = profile.avatar_path ? db.storage.from('runmate-avatars').getPublicUrl(profile.avatar_path).data.publicUrl : '';
  const avatarMarkup = avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="صورة ${escapeHtml(name)}">` : escapeHtml(initial);
  $('user-avatar-initials').innerHTML = avatarMarkup;
  $('profile-avatar-large').innerHTML = avatarMarkup;
  $('profile-name').textContent = name;
  $('profile-email').textContent = email;
  $('profile-phone').textContent = phone ? `الهاتف: ${phone}` : '';
  $('profile-role').textContent = isAdmin() ? 'حساب أدمن' : 'عضو RUNMATE';

  document.querySelectorAll('.admin-only').forEach(el => el.hidden = !isAdmin());

  await refreshData();
  navigateTo('home');

  if (!state.authListener) {
    state.authListener = true;
    db.auth.onAuthStateChange((event, currentSession) => {
      if (event === 'SIGNED_OUT' || !currentSession) location.reload();
    });
  }
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
  if ((pageId === 'organizer' || pageId === 'admin') && !isAdmin()) {
    toast('إنشاء الجريات متاح للأدمن فقط');
    return;
  }
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${pageId}`));
  document.querySelectorAll('[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === pageId));
  
  const names = { clips: 'Clips', admin: 'Admin', home: 'الرئيسية', tickets: 'حجوزاتي', chats: 'المحادثات', profile: 'حسابي', organizer: 'إدارة الجريات' };
  $('crumb-active').textContent = names[pageId] || 'RUNMATE';

  if (pageId === 'chats') renderChatsList();
  if (pageId === 'clips') loadClips();
  if (pageId === 'admin') loadAdminPanel();
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
    <div class="run-image"><img loading="lazy" decoding="async" src="${escapeHtml(run.image_url || 'https://images.unsplash.com/photo-1476480862126-209bfaa8edc8?w=600&auto=format&fit=crop&q=80')}" alt=""><span class="run-badge">${seats} مقعد متاح</span></div>
    <div class="run-info"><div class="run-org">✦ ${escapeHtml(run.organizer_name || 'RUNMATE')}</div>
    <h3>${escapeHtml(run.title)}</h3><div class="run-detail"><span>◷ ${escapeHtml(formatDate(run.starts_at))}</span><span>⌖ ${escapeHtml(run.location)} · ${escapeHtml(run.distance_km)} كم</span></div>
    <div class="run-foot"><div class="run-price">${escapeHtml(run.price || 'مجانية')}</div><button class="run-open" data-event="${escapeHtml(run.id)}">التفاصيل ↙</button></div></div></article>`;
}

function renderEvents() {
  const query = ($('search')?.value || '').trim().toLowerCase();
  const list = state.events.filter(run => `${run.title} ${run.location}`.toLowerCase().includes(query));

  $('home-runs').innerHTML = list.length ? list.map(createRunCard).join('') : '<p class="empty-state">لا توجد جريات تطابق بحثك.</p>';
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
    admin_only_chat: $('org-admin-only').checked,
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

async function loadClips() {
  const box = $('clips-list');
  if (!box || !state.user) return;
  box.innerHTML = '<p class="empty-state">جارٍ تحميل Clips...</p>';
  const { data, error } = await db.from('clips').select('id,user_id,storage_path,caption,media_type,status,created_at').order('created_at', { ascending: false }).limit(60);
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
    : `<img src="${escapeHtml(clip.signedUrl)}" alt="مقطع من مجتمع RUNMATE" loading="lazy">`) : '<div class="empty-state">تعذّر تحميل الملف</div>';
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

  const { data: updatedProfile, error: updateError } = await db.from('profiles').update({ avatar_path: path }).eq('id', state.user.id).select('*').single();
  if (updateError) {
    const { error: cleanupError } = await db.storage.from('runmate-avatars').remove([path]);
    status.textContent = 'تعذّر حفظ صورة الحساب. حاول مجدداً.';
    console.error('Profile photo update failed:', updateError.code || 'unknown', cleanupError ? 'Storage cleanup failed' : '');
    return;
  }

  state.profile = updatedProfile;
  const publicUrl = db.storage.from('runmate-avatars').getPublicUrl(path).data.publicUrl;
  const name = state.profile.display_name || 'مستخدم RUNMATE';
  const markup = `<img src="${escapeHtml(publicUrl)}" alt="صورة ${escapeHtml(name)}">`;
  $('user-avatar-initials').innerHTML = markup;
  $('profile-avatar-large').innerHTML = markup;
  if (oldPath) {
    const { error: removeError } = await db.storage.from('runmate-avatars').remove([oldPath]);
    if (removeError) console.error('Old profile photo cleanup failed:', removeError.statusCode || 'unknown');
  }
  event.target.reset();
  status.textContent = 'تم تحديث صورة الحساب.';
});

async function loadAdminPanel() {
  if (!isAdmin()) return;
  const pendingBox = $('admin-pending-clips');
  const usersBox = $('admin-users');
  pendingBox.innerHTML = '<p class="empty-state">جارٍ التحميل...</p>';
  usersBox.innerHTML = '<p class="empty-state">جارٍ التحميل...</p>';
  const [clipsResult, usersResult] = await Promise.all([
    db.from('clips').select('id,user_id,storage_path,caption,media_type,status,created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(100),
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
    usersBox.innerHTML = users.length ? `<table><thead><tr><th>الاسم</th><th>الدور</th><th>تاريخ الإنشاء</th></tr></thead><tbody>${users.map(user => `<tr><td>${escapeHtml(user.display_name || 'عضو')}</td><td>${user.role === 'admin' ? 'مدير' : 'عضو'}</td><td>${escapeHtml(formatDate(user.created_at))}</td></tr>`).join('')}</tbody></table>` : '<p class="empty-state">لا يوجد مستخدمون.</p>';
  }
}

document.addEventListener('click', async event => {
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
  const { error } = await db.auth.resend({ type: 'signup', email });
  if (error) {
    console.error('Confirmation resend failed:', error.code || 'unknown');
    return showMessage('تعذّر إرسال رسالة التأكيد. تحقق من البريد وحاول مجدداً لاحقاً.');
  }
  showMessage('إذا كان الحساب بحاجة إلى التأكيد، ستصلك رسالة على بريدك الإلكتروني.');
});






