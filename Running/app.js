/* Stride + Supabase Client Config */
const SUPABASE_URL = 'https://trqrpoployvsuuitffji.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_H54WIGq4spz51QFkSjmR8w_ohdXdv90';
const AUTH_REDIRECT_URL = 'https://yousefughh.github.io/RUN/';
const supabaseReady = SUPABASE_URL.startsWith('https://') && !SUPABASE_URL.includes('YOUR_');
const db = supabaseReady ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const chatAvatarUrls = new Map();
let activeChatChannel = null;
let chatRefreshJob = null;

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
      const name = message.sender_name || 'Stride member';
      const initial = Array.from(name.trim())[0] || 'U';
      const avatarIndex = pathIndexes.get(message.avatar_path);
      const avatar = avatarIndex === undefined
        ? `<span class="message-avatar message-avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`
        : `<span class="message-avatar message-avatar-fallback" data-avatar-index="${avatarIndex}" aria-hidden="true">${escapeHtml(initial)}</span>`;
      return `<div class="message"><div class="message-heading">${avatar}<b>${escapeHtml(name)}</b></div><p>${escapeHtml(message.body)}</p><small>${escapeHtml(formatDate(message.created_at))}</small></div>`;
    }).join('')
    : '<p class="empty-state">No messages yet. Start the conversation!</p>';
  box.scrollTop = box.scrollHeight;

  const urls = await Promise.all(paths.map(path => getChatAvatarUrl(path)));
  if (!box.isConnected || state.activeChatRun !== runId) return;
  urls.forEach((url, index) => {
    if (!url) return;
    box.querySelectorAll(`[data-avatar-index="${index}"]`).forEach(placeholder => {
      const image = document.createElement('img');
      image.className = 'message-avatar';
      image.src = url;
      image.alt = 'Message sender photo';
      placeholder.replaceWith(image);
    });
  });
}

async function stopChatRealtime() {
  const channel = activeChatChannel;
  activeChatChannel = null;
  chatRefreshJob = null;
  if (channel && db) await db.removeChannel(channel);
}

async function refreshChatMessages(runId, showError = false) {
  if (state.activeChatRun !== runId || !activeChatChannel) return false;
  if (chatRefreshJob?.runId === runId && chatRefreshJob.busy) {
    chatRefreshJob.pending = true;
    return true;
  }

  const job = { runId, busy: true, pending: false };
  chatRefreshJob = job;
  let succeeded = true;
  do {
    job.pending = false;
    const { data, error } = await db.rpc('get_run_chat_messages', { p_run_id: runId });
    if (error) {
      succeeded = false;
      if (showError && state.activeChatRun === runId) {
        const box = $('chat-messages');
        if (box) box.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
      } else {
        console.warn('Could not refresh chat messages:', error.message);
      }
      break;
    }
    if (state.activeChatRun === runId) await renderChatMessages(data || [], runId);
  } while (job.pending && state.activeChatRun === runId && activeChatChannel);
  if (chatRefreshJob === job) chatRefreshJob = null;
  return succeeded;
}

function subscribeToRunChat(runId) {
  const channel = db.channel(`run-chat:${runId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages', filter: `run_id=eq.${runId}`
    }, () => { void refreshChatMessages(runId); })
    .subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`Realtime chat subscription ${status.toLowerCase()} for run ${runId}`);
      }
    });
  activeChatChannel = channel;
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
  $('auth-screen').querySelector('.auth-note').textContent = 'Password recovery';
  $('auth-message').textContent = 'Choose a new password with at least 8 characters.';
}

$('form-password-recovery').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('recovery-password').value;
  if (password.length < 8) return showMessage('Password must be at least 8 characters.');
  if (password !== $('recovery-password-confirm').value) return showMessage('Passwords do not match.');

  const button = $('form-password-recovery').querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage('Saving your new password...');
  const { error } = await db.auth.updateUser({ password });
  button.disabled = false;
  if (error) {
    console.error('Password recovery update failed:', error.code || 'unknown');
    return showMessage('Could not change the password. Open the latest password reset link in your email and try again.');
  }

  state.passwordRecovery = false;
  $('recovery-password').value = '';
  $('recovery-password-confirm').value = '';
  $('form-password-recovery').hidden = true;
  $('auth-screen').style.display = 'none';
  const { data: { session } } = await db.auth.getSession();
  if (session) await loadSession(session);
  toast('Password changed successfully.');
});

/* Create a new account */
$('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  if (!db) return showMessage('Add your Supabase settings first.');
  const form = $('form-register');
  if (form.dataset.submitting === 'true') return;

  const name = $('reg-name').value.trim();
  const email = $('reg-identity').value.trim();
  const password = $('reg-pass').value;
  const button = form.querySelector('button[type="submit"]');

  form.dataset.submitting = 'true';
  button.disabled = true;
  showMessage('Creating your account...');

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
        return showMessage('You have reached the temporary limit for sign-ups or confirmation emails. Please wait and try again.');
      }
      return showMessage('Could not create your account. Check your details and try again.');
    }

    if (data.user) {
      if (data.session) {
        await loadSession(data.session);
        toast('Account created successfully');
      } else {
        showMessage('Open the confirmation email and click the link. You will return to the site and be signed in automatically.');
      }
    }
  } catch (error) {
    console.error('Signup request failed:', error?.name || 'unknown');
    showMessage('Could not connect to the sign-up service. Check your internet connection and try again shortly.');
  } finally {
    form.dataset.submitting = 'false';
    button.disabled = false;
  }
});

/* Sign in */
$('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  if (!db) return showMessage('Add your Supabase settings first.');

  const email = $('login-identity').value.trim();
  const password = $('login-pass').value;

  showMessage('Signing in...');
  const result = await db.auth.signInWithPassword({ email, password });

  if (result.error) { console.error('Login failed:', result.error.code || 'unknown'); return showMessage(result.error.code === 'email_not_confirmed' ? 'Please confirm your email first. Resend the confirmation email using the button below.' : 'Could not sign in. Check your email and password.'); }
  await loadSession(result.data.session);
});

/* Password recovery */
$('forgot-pass-btn').addEventListener('click', async () => {
  if (!db) return showMessage('Supabase settings are incomplete.');
  const email = $('login-identity').value.trim();
  if (!email || !email.includes('@')) {
    return showMessage('Enter your email in the sign-in form first.');
  }
  showMessage('Sending password reset link...');
  const button = $('forgot-pass-btn');
  button.disabled = true;
  const { error } = await db.auth.resetPasswordForEmail(email, {
    redirectTo: AUTH_REDIRECT_URL,
  });
  button.disabled = false;
  if (error) { console.error('Password reset request failed:', error.code || 'unknown'); return showMessage('Could not send the reset link. Make sure the site URL is configured in Supabase and try again.'); }
  showMessage('If this email is registered, a reset message will arrive. Open the latest email and use the link before it expires.');
});

$('profile-password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('profile-new-password').value;
  const confirmPassword = $('profile-confirm-password').value;
  const status = $('profile-password-status');
  if (password.length < 8) return status.textContent = 'Password must be at least 8 characters.';
  if (password !== confirmPassword) return status.textContent = 'Passwords do not match.';

  const button = $('profile-password-form').querySelector('button[type="submit"]');
  button.disabled = true;
  status.textContent = 'Changing password...';
  const { error } = await db.auth.updateUser({ password });
  button.disabled = false;
  if (error) {
    console.error('Password change failed:', error.code || 'unknown');
    status.textContent = 'Could not change the password. Sign in again and try once more.';
    return;
  }

  $('profile-password-form').reset();
  status.textContent = 'Password changed successfully.';
});

/* Load session and data */
async function loadSession(session) {
  if (!session?.user?.id || state.loadingSessionUserId === session.user.id || state.profile?.id === session.user.id) return;
  state.loadingSessionUserId = session.user.id;
  state.user = session.user;
  let { data: profile, error } = await db.from('profiles').select('id,display_name,avatar_path,role,created_at').eq('id', state.user.id).single();

  if (error || !profile) {
    showMessage('Could not find your profile. Run supabase-migration.sql in your Supabase project, then sign in again.');
    console.error('Profile lookup failed:', error?.code || 'profile missing');
    state.loadingSessionUserId = null;
    return;
  }

  state.profile = profile;
  $('auth-screen').style.display = 'none';$('app-shell').classList.add('authenticated');

  const name = profile.display_name || 'Stride user';
  const email = state.user.email || '';
  const initial = Array.from(name)[0] || 'U';

  const avatarUrl = profile.avatar_path ? await getPrivateAvatarUrl(profile.avatar_path) : '';
  const avatarMarkup = avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="Photo of ${escapeHtml(name)}">` : escapeHtml(initial);
  $('user-avatar-initials').innerHTML = avatarMarkup;
  $('profile-avatar-large').innerHTML = avatarMarkup;
  $('profile-name').textContent = name;
  $('profile-email').textContent = email;
  $('profile-role').textContent = state.profile.role === 'owner' ? 'Stride Owner' : isAdmin() ? 'Admin' : 'Stride Member';

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

  if (eventsRes.error) return toast('Could not load runs: ' + eventsRes.error.message);

  state.events = eventsRes.data || [];
  state.bookings = (bookingsRes.data || []).map(row => row.runs).filter(Boolean);

  renderEvents();
  renderChatsList();
}

function navigateTo(pageId) {
  if ((pageId === 'organizer' || pageId === 'admin') && !isAdmin()) {
    toast('Only admins can create runs');
    return;
  }
  if (pageId !== 'chats' && activeChatChannel) void stopChatRealtime();
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === `page-${pageId}`));
  document.querySelectorAll('[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === pageId));
  
  const names = { clips: 'Clips', admin: 'Admin', home: 'Home', tickets: 'My Runs', chats: 'Chats', profile: 'Profile', organizer: 'Manage Runs' };
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
  if (!value) return 'Time to be announced';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function createRunCard(run) {
  const seats = Math.max(0, Number(run.seats_total || 0) - Number(run.seats_booked || 0));
  const seatText = seats === 0 ? 'Sold out' : `${seats} spots available`;
  return `<article class="run-card">
    <div class="run-image"><img loading="lazy" decoding="async" src="${escapeHtml(run.image_url || 'https://images.unsplash.com/photo-1476480862126-209bfaa8edc8?w=600&auto=format&fit=crop&q=80')}" alt=""><span class="run-badge ${seats === 0 ? 'sold-out' : ''}">${seatText}</span></div>
    <div class="run-info"><div class="run-org">✦ Organized by Stride</div>
    <h3>${escapeHtml(run.title)}</h3><div class="run-detail"><span>◷ ${escapeHtml(formatDate(run.starts_at))}</span><span>⌖ ${escapeHtml(run.location)} · ${escapeHtml(run.distance_km)} km</span></div>
    <div class="run-foot"><div class="run-price">${escapeHtml(run.price || 'Free')}</div><button class="run-open" data-event="${escapeHtml(run.id)}">Details ↙</button></div></div></article>`;
}

function renderEvents() {
  const query = ($('search')?.value || '').trim().toLowerCase();
  const list = state.events.filter(run => `${run.title} ${run.location}`.toLowerCase().includes(query));
  const groups = { upcoming: [], current: [], previous: [] };
  list.forEach(run => {
    groups[getRunCategory(run)].push(run);
  });
  const sections = [
    ['upcoming-runs', groups.upcoming, 'No upcoming runs match your search.'],
    ['current-runs', groups.current, 'No current runs today.'],
    ['previous-runs', groups.previous, 'No past runs match your search.']
  ];
  sections.forEach(([id, runs, emptyMessage]) => {
    $(id).innerHTML = runs.length ? runs.map(createRunCard).join('') : `<p class="empty-state">${emptyMessage}</p>`;
  });
  $('ticket-count').textContent = state.bookings.length;
  $('ticket-list').innerHTML = state.bookings.length ? state.bookings.map(run => `<div class="ticket-card"><div class="ticket-body"><h3>${escapeHtml(run.title)}</h3><p class="muted-text">${escapeHtml(formatDate(run.starts_at))} · ${escapeHtml(run.location)}</p><button class="primary-btn" data-chat-run="${escapeHtml(run.id)}" data-page="chats">Open Chat</button></div></div>`).join('') : '<p class="empty-state">You have not booked any runs yet.</p>';
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
  const ticketText = remaining === 0 ? 'Sold out' : bookingClosed && !booked ? 'Booking closed 30 minutes before the run' : `${remaining} spots remaining`;

  $('modal-content').innerHTML = `
    <div class="modal-body">
      <h2>${escapeHtml(run.title)}</h2>
      <p class="muted-text">Run organizer: Stride</p>
      <p>◷ Date: ${escapeHtml(formatDate(run.starts_at))}</p>
      <p>⌖ Meeting point: ${escapeHtml(run.location)}</p>
      <p>Distance: ${escapeHtml(run.distance_km)} km</p>
      <p>${ticketText}</p>
      <p>Price: ${escapeHtml(run.price || 'Free')}</p>
      <button class="primary-btn" id="book-now-btn" ${!booked && (remaining < 1 || bookingClosed) ? 'disabled' : ''}>${booked ? 'Cancel Booking' : remaining < 1 ? 'Sold out' : bookingClosed ? 'Booking closed' : 'Book a Spot'}</button>
      ${isAdmin() ? `<label class="run-status-control">Run status
        <select id="run-status-choice">
          <option value="automatic" ${run.run_status === 'automatic' ? 'selected' : ''}>Automatic based on time</option>
          <option value="upcoming" ${run.run_status === 'upcoming' ? 'selected' : ''}>Upcoming (manual)</option>
          <option value="current" ${run.run_status === 'current' ? 'selected' : ''}>Current (manual)</option>
          <option value="previous" ${run.run_status === 'previous' ? 'selected' : ''}>Past (manual)</option>
        </select>
      </label><button class="secondary-btn" id="save-run-settings">Save Run Status</button>
        <button class="danger-btn" id="delete-run-btn" type="button">Permanently Delete Run</button>` : ''}
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
    if (error) return toast(error.code === '23505' ? 'You are already booked for this run.' : 'Could not cancel your booking. Please try again.');
    if (state.activeChatRun === run.id) {
      await stopChatRealtime();
      state.activeChatRun = null;
      $('chat-panel').innerHTML = '<p class="empty-state">Your booking was cancelled. You are no longer in this run chat.</p>';
    }
    toast('Booking cancelled');
  } else {
    if (isBookingClosed(run)) return toast('Booking closed 30 minutes before the run.');
    const { error } = await db.from('bookings').insert({ run_id: run.id, user_id: state.user.id });
    if (error) return toast(error.message?.includes('full') ? 'Sold out.' : error.code === '23505' ? 'You are already booked for this run.' : 'Could not complete your booking. Please try again.');
    toast('You are booked!');
  }
  $('modal').classList.remove('active');
  await refreshData();
}

async function saveRunSettings(run) {
  const { error } = await db.from('runs').update({ run_status: $('run-status-choice').value }).eq('id', run.id);
  if (error) return toast('Could not save the run status.');
  $('modal').classList.remove('active');
  await refreshData();
  toast('Run status updated.');
}

async function deleteRun(run, button) {
  if (!isAdmin()) return toast('Only admins can delete runs.');
  if (!window.confirm(`Permanently delete the run “${run.title}”? Its bookings and chat will also be deleted.`)) return;
  button.disabled = true;
  const { error } = await db.from('runs').delete().eq('id', run.id);
  if (error) {
    button.disabled = false;
    console.error('Run deletion failed:', error.code || 'unknown');
    return toast('Could not delete the run. Please try again.');
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
  toast(imageCleanupFailed ? 'The run, bookings, and chat were deleted, but its image could not be removed.' : 'The run, bookings, and chat were deleted.');
}

async function toggleReadOnly(run) {
  const { error } = await db.from('runs').update({ admin_only_chat: !run.admin_only_chat }).eq('id', run.id);
  if (error) return toast('Could not update chat permissions.');
  toast('Chat settings updated');
  $('modal').classList.remove('active');
  await refreshData();
  if ($('page-chats').classList.contains('active')) await openChat(run.id);
}

$('modal-close').addEventListener('click', () =>$('modal').classList.remove('active'));

/* Create a new run (admins only) */
$('organizer-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!isAdmin()) return toast('This action is available to admins only');

  const imageFile = $('org-image-file').files?.[0];
  const acceptedImageTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (imageFile && !acceptedImageTypes.includes(imageFile.type)) return toast('Choose a JPG, PNG, or WebP image.');
  if (imageFile && imageFile.size > 5 * 1024 * 1024) return toast('The image must be no larger than 5 MB.');

  let uploadedImagePath = null;
  let imageUrl = $('org-image').value.trim() || null;
  if (imageFile) {
    const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[imageFile.type];
    uploadedImagePath = `${state.user.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await db.storage.from('runmate-run-images').upload(uploadedImagePath, imageFile, { contentType: imageFile.type, upsert: false });
    if (uploadError) {
      console.error('Run image upload failed:', uploadError.statusCode || 'unknown');
      return toast('Could not upload the run image. Please try again.');
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
    return toast('Could not create the run: ' + error.message);
  }

  $('organizer-form').reset();
  await refreshData();
  navigateTo('home');
  toast('Run created and you are automatically booked. The chat is ready.');
});

/* Chats */
async function renderChatsList() {
  if (!state.user) return;
  const { data, error } = await db.from('bookings').select('run_id, runs(id,title,admin_only_chat)').eq('user_id', state.user.id);
  if (error) { $('chat-runs').innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`; return; }

  const runs = (data || []).map(row => row.runs).filter(Boolean);
  $('chat-runs').innerHTML = runs.length 
    ? runs.map(run => `<button class="chat-run-btn ${state.activeChatRun === run.id ? 'active' : ''}" data-chat-run="${escapeHtml(run.id)}"><b>${escapeHtml(run.title)}</b><small>${run.admin_only_chat ? 'Admins only' : 'Participant chat'}</small></button>`).join('') 
    : '<p class="empty-state">Book a run to see its chat here.</p>';
}

async function openChat(runId) {
  const run = state.bookings.find(item => item.id === runId) || state.events.find(item => item.id === runId);
  if (!run && !isAdmin()) return toast('Only booked participants can access this chat');

  await stopChatRealtime();
  state.activeChatRun = runId;

  navigateTo('chats');
  await renderChatsList();

  $('chat-panel').innerHTML = `<header class="chat-header"><div><h3>${escapeHtml(run?.title || 'Run chat')}</h3><p class="muted-text">${run?.admin_only_chat ? 'Only admins and organizers can post' : 'Participants can post'}</p></div>${isAdmin() ? `<button class="secondary-btn" id="toggle-readonly" type="button">${run?.admin_only_chat ? 'Allow participants to post' : 'Limit posting to admins and organizers'}</button>` : ''}</header><div class="chat-messages" id="chat-messages"><p class="empty-state">Loading messages...</p></div><form id="chat-form" class="chat-form"><input id="chat-text" maxlength="2000" placeholder="Write a message..." required><button class="primary-btn" type="submit">Send</button></form>`;
  if (isAdmin()) $('toggle-readonly').onclick = () => toggleReadOnly(run);

  subscribeToRunChat(runId);
  const loaded = await refreshChatMessages(runId, true);
  if (!loaded) return;

  const isReadOnly = !!run?.admin_only_chat && !isAdmin();
  $('chat-form').hidden = isReadOnly;
  
  if (isReadOnly) {
    $('chat-panel').insertAdjacentHTML('afterbegin', '<p class="readonly-note">This chat is read-only. Only admins and organizers can send messages.</p>');
  }

  $('chat-form').onsubmit = async e => {
    e.preventDefault();
    const body = $('chat-text').value.trim();
    if (!body) return;

    const { error: sendError } = await db.from('messages').insert({ run_id: runId, user_id: state.user.id, body });
    if (sendError) return toast('Could not send the message: ' + sendError.message);
    $('chat-text').value = '';
    if (!await refreshChatMessages(runId)) toast('Message sent, but the chat could not be refreshed.');
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
  box.innerHTML = '<p class="empty-state">Loading clips...</p>';
  const { data, error } = await db.from('clips').select('id,storage_path,caption,media_type,status,created_at').order('created_at', { ascending: false }).limit(60);
  if (error) {
    box.innerHTML = '<p class="empty-state">Could not load clips. Please try again later.</p>';
    console.error('Clips query failed:', error.code || 'unknown');
    return;
  }
  state.clips = data || [];
  const signed = await Promise.all(state.clips.map(async clip => {
    const { data: urlData, error: urlError } = await db.storage.from('runmate-clips').createSignedUrl(clip.storage_path, 900);
    if (urlError) console.error('Clip URL unavailable:', urlError.statusCode || 'unknown');
    return { ...clip, signedUrl: urlData?.signedUrl || '' };
  }));
  box.innerHTML = signed.length ? signed.map(clip => clipCard(clip, false)).join('') : '<p class="empty-state">No clips yet. Share your first running moment!</p>';
}

function clipCard(clip, reviewMode) {
  const media = clip.signedUrl ? (clip.media_type === 'video'
    ? `<video src="${escapeHtml(clip.signedUrl)}" controls preload="metadata" playsinline></video>`
    : `<img src="${escapeHtml(clip.signedUrl)}" alt="Clip from the Stride community" loading="lazy">`) : '<div class="empty-state">Could not load file</div>';
  const status = `<span class="clip-status ${escapeHtml(clip.status)}">${clip.status === 'pending' ? 'Pending review' : clip.status === 'approved' ? 'Approved' : 'Rejected'}</span>`;
  const actions = reviewMode && clip.status === 'pending' ? `<div class="clip-actions"><button class="primary-btn" data-review-clip="${escapeHtml(clip.id)}" data-status="approved">Approve</button><button class="secondary-btn" data-review-clip="${escapeHtml(clip.id)}" data-status="rejected">Reject</button></div>` : '';
  return `<article class="clip-card">${media}<div class="clip-card-body">${status}<p>${escapeHtml(clip.caption || '')}</p><small>${escapeHtml(formatDate(clip.created_at))}</small>${actions}</div></article>`;
}

$('clip-upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('clip-file').files?.[0];
  const status = $('clip-upload-status');
  const accepted = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm', 'video/quicktime'];
  if (!file || !accepted.includes(file.type)) return status.textContent = 'Choose a JPG, PNG, or WebP image, or an MP4, WebM, or MOV video.';
  if (file.size > 50 * 1024 * 1024) return status.textContent = 'The file must be no larger than 50 MB.';
  const mediaType = file.type.startsWith('video/') ? 'video' : 'image';
  const path = `${state.user.id}/${crypto.randomUUID()}.${file.name.split('.').pop().toLowerCase()}`;
  const caption = $('clip-caption').value.trim();
  status.textContent = 'Uploading file...';
  const { error: uploadError } = await db.storage.from('runmate-clips').upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) {
    status.textContent = 'Could not upload the file. Check your Supabase settings and try again.';
    console.error('Clip upload failed:', uploadError.statusCode || 'unknown');
    return;
  }
  const { error: insertError } = await db.from('clips').insert({ user_id: state.user.id, storage_path: path, caption, media_type: mediaType, status: 'pending' });
  if (insertError) {
    const { error: cleanupError } = await db.storage.from('runmate-clips').remove([path]);
    status.textContent = 'Could not submit the file for review. The upload was cancelled.';
    console.error('Clip record insert failed:', insertError.code || 'unknown', cleanupError ? 'Storage cleanup failed' : '');
    return;
  }
  event.target.reset();
  status.textContent = 'Submitted. Your clip will appear after admin review.';
  await loadClips();
});

$('profile-photo-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('profile-photo-file').files?.[0];
  const status = $('profile-photo-status');
  const accepted = ['image/jpeg', 'image/png', 'image/webp'];
  if (!file || !accepted.includes(file.type)) return status.textContent = 'Choose a JPG, PNG, or WebP image.';
  if (file.size > 5 * 1024 * 1024) return status.textContent = 'The image must be no larger than 5 MB.';

  const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' })[file.type];
  const path = `${state.user.id}/${crypto.randomUUID()}.${extension}`;
  const oldPath = state.profile?.avatar_path;
  status.textContent = 'Uploading profile photo...';
  const { error: uploadError } = await db.storage.from('runmate-avatars').upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) {
    status.textContent = 'Could not upload the photo. Please try again.';
    console.error('Profile photo upload failed:', uploadError.statusCode || 'unknown');
    return;
  }

  const { data: updatedProfile, error: updateError } = await db.from('profiles').update({ avatar_path: path }).eq('id', state.user.id).select('id,display_name,avatar_path,role,created_at').single();
  if (updateError) {
    const { error: cleanupError } = await db.storage.from('runmate-avatars').remove([path]);
    status.textContent = 'Could not save your profile photo. Please try again.';
    console.error('Profile photo update failed:', updateError.code || 'unknown', cleanupError ? 'Storage cleanup failed' : '');
    return;
  }

  state.profile = updatedProfile;
  const privateUrl = await getPrivateAvatarUrl(path);
  if (!privateUrl) {
    await db.from('profiles').update({ avatar_path: oldPath || null }).eq('id', state.user.id);
    return status.textContent = 'Photo uploaded, but a secure viewing link could not be created. Please try again.';
  }
  const name = state.profile.display_name || 'Stride user';
  const markup = `<img src="${escapeHtml(privateUrl)}" alt="Photo of ${escapeHtml(name)}">`;
  $('user-avatar-initials').innerHTML = markup;
  $('profile-avatar-large').innerHTML = markup;
  if (oldPath) {
    const { error: removeError } = await db.storage.from('runmate-avatars').remove([oldPath]);
    if (removeError) console.error('Old profile photo cleanup failed:', removeError.statusCode || 'unknown');
  }
  event.target.reset();
  status.textContent = 'Profile photo updated.';
});

$('profile-logout-btn').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Signing out...';
  const { error } = await db.auth.signOut();
  if (error) {
    button.disabled = false;
    button.textContent = 'Sign out';
    return toast('Could not sign out. Please try again.');
  }
  location.reload();
});

async function loadAdminPanel() {
  if (!isAdmin()) return;
  const pendingBox = $('admin-pending-clips');
  const usersBox = $('admin-users');
  pendingBox.innerHTML = '<p class="empty-state">Loading...</p>';
  usersBox.innerHTML = '<p class="empty-state">Loading...</p>';
  const [clipsResult, usersResult] = await Promise.all([
    db.from('clips').select('id,storage_path,caption,media_type,status,created_at').eq('status', 'pending').order('created_at', { ascending: true }).limit(100),
    db.from('profiles').select('id,display_name,role,created_at').order('created_at', { ascending: false }).limit(100)
  ]);
  if (clipsResult.error) {
    pendingBox.innerHTML = '<p class="empty-state">Could not load the review queue.</p>';
    console.error('Admin clips query failed:', clipsResult.error.code || 'unknown');
  } else {
    const reviewClips = await Promise.all((clipsResult.data || []).map(async clip => {
      const { data } = await db.storage.from('runmate-clips').createSignedUrl(clip.storage_path, 900);
      return { ...clip, signedUrl: data?.signedUrl || '' };
    }));
    pendingBox.innerHTML = reviewClips.length ? reviewClips.map(clip => clipCard(clip, true)).join('') : '<p class="empty-state">No clips pending review.</p>';
  }
  if (usersResult.error) {
    usersBox.innerHTML = '<p class="empty-state">Could not load users.</p>';
    console.error('Admin users query failed:', usersResult.error.code || 'unknown');
  } else {
    const users = usersResult.data || [];
    usersBox.innerHTML = users.length ? `<table><thead><tr><th>Name</th><th>Role</th><th>Created</th>${isOwner() ? '<th>Manage Role</th>' : ''}</tr></thead><tbody>${users.map(user => `<tr><td>${escapeHtml(user.display_name || 'Member')}</td><td>${user.role === 'owner' ? 'Owner' : user.role === 'admin' ? 'Admin' : 'Member'}</td><td>${escapeHtml(formatDate(user.created_at))}</td>${isOwner() ? `<td><select data-role-choice="${escapeHtml(user.id)}" aria-label="Role for ${escapeHtml(user.display_name || 'Member')}"><option value="member" ${user.role === 'member' ? 'selected' : ''}>Member</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option><option value="owner" ${user.role === 'owner' ? 'selected' : ''}>Owner</option></select><button class="secondary-btn role-save-btn" type="button" data-save-role="${escapeHtml(user.id)}">Save Role</button></td>` : ''}</tr>`).join('')}</tbody></table>` : '<p class="empty-state">No users found.</p>';
  }
}

document.addEventListener('click', async event => {
  const roleButton = event.target.closest('[data-save-role]');
  if (roleButton) {
    if (!isOwner()) return toast('Only the owner can manage roles.');
    const role = roleButton.closest('tr')?.querySelector('[data-role-choice]')?.value;
    if (!role) return toast('Choose a valid role.');
    roleButton.disabled = true;
    const { error } = await db.rpc('set_profile_role', { target_profile_id: roleButton.dataset.saveRole, requested_role: role });
    if (error) {
      roleButton.disabled = false;
      toast(error.message?.includes('last owner') ? 'The last owner role cannot be removed.' : 'Could not update the role.');
      console.error('Role update failed:', error.code || 'unknown', error.message || '');
      return;
    }
    toast('Role updated.');
    await loadAdminPanel();
    return;
  }
  const button = event.target.closest('[data-review-clip]');
  if (!button || !isAdmin()) return;
  button.disabled = true;
  const { error } = await db.from('clips').update({ status: button.dataset.status, reviewed_at: new Date().toISOString(), reviewed_by: state.user.id }).eq('id', button.dataset.reviewClip).eq('status', 'pending');
  if (error) {
    button.disabled = false;
    toast('Could not update clip status.');
    console.error('Clip review failed:', error.code || 'unknown');
    return;
  }
  toast(button.dataset.status === 'approved' ? 'Clip approved.' : 'Clip rejected.');
  await loadAdminPanel();
});


$('resend-confirmation-btn').addEventListener('click', async () => {
  if (!db) return showMessage('Supabase settings are incomplete.');
  const email = $('reg-identity').value.trim() || $('login-identity').value.trim();
  if (!email || !email.includes('@')) return showMessage('Enter your email in the sign-in or registration form first.');
  showMessage('Sending confirmation email...');
  const { error } = await db.auth.resend({ type: 'signup', email, options: { emailRedirectTo: AUTH_REDIRECT_URL } });
  if (error) {
    console.error('Confirmation resend failed:', error.code || 'unknown');
    return showMessage('Could not send the confirmation email. Check the email address and try again later.');
  }
  showMessage('If your account needs confirmation, you will receive an email.');
});
