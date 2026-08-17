(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    data: null,
    tab: 'action',
    search: '',
    category: 'all',
    stylist: 'all',
    location: 'all',
    selectedId: null,
    queue: [],
    queueIndex: 0,
    queueMode: false,
    drafts: loadDrafts(),
    busy: false,
  };

  const TAB_DEFS = [
    ['action', 'Action queue'], ['waiting', 'Sent / replies'], ['photos', 'Photos in'],
    ['completed', 'Completed'], ['all', 'All qualifying'], ['cancelled', 'Cancelled'],
  ];

  function loadDrafts() {
    try { return JSON.parse(localStorage.getItem('hera_preconsult_drafts_v1') || '{}'); }
    catch { return {}; }
  }
  function saveDrafts() {
    try { localStorage.setItem('hera_preconsult_drafts_v1', JSON.stringify(state.drafts)); } catch { /* no-op */ }
  }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function attr(value) { return esc(value).replace(/`/g, '&#96;'); }
  function now() { return new Date(); }
  function sgt(dateLike) {
    return new Intl.DateTimeFormat('en-SG', {
      timeZone: 'Asia/Singapore', weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date(dateLike));
  }
  function sgtDate(dateLike) {
    return new Intl.DateTimeFormat('en-SG', { timeZone:'Asia/Singapore', weekday:'short', day:'numeric', month:'short' }).format(new Date(dateLike));
  }
  function sgtTime(dateLike) {
    return new Intl.DateTimeFormat('en-SG', { timeZone:'Asia/Singapore', hour:'numeric', minute:'2-digit', hour12:true }).format(new Date(dateLike));
  }
  function hoursUntil(b) { return (new Date(b.appointment_at).getTime() - Date.now()) / 3600000; }
  function hoursSince(value) { return value ? (Date.now() - new Date(value).getTime()) / 3600000 : null; }
  function compactGap(hours) {
    if (!Number.isFinite(hours)) return '—';
    const past = hours < 0; const h = Math.abs(hours);
    let text;
    if (h < 1) text = `${Math.max(1, Math.round(h * 60))}m`;
    else if (h < 48) text = `${h.toFixed(h < 10 ? 1 : 0)}h`;
    else text = `${(h / 24).toFixed(h < 120 ? 1 : 0)}d`;
    return past ? `${text} ago` : `in ${text}`;
  }
  function firstName(full) {
    const cleaned = String(full || '').split('/')[0].replace(/\(.*?\)/g,'').trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    const titles = /^(mr|mrs|ms|miss|dr|prof|mdm|madam|sir)\.?$/i;
    if (!parts.length) return 'there';
    return titles.test(parts[0]) && parts[1] ? parts[1] : parts[0];
  }
  function shortLocation(value) {
    return String(value || '').replace(/^Hera Hair Beauty\s*/i,'').replace(/^@\s*/,'').trim() || 'Hera Hair Beauty';
  }
  function categoryLabel(cat) {
    const map = {
      colour:'Colour', highlights:'Highlights', balayage:'Balayage', colour_correction:'Colour correction',
      curly:'Curly', curly_haircut:'Curly haircut', curly_colour:'Curly colour',
      curly_highlights_balayage:'Curly highlights / balayage',
    };
    return map[cat] || String(cat || 'Qualifying').replace(/_/g,' ');
  }
  function services(b) { return b.booking_services?.length ? b.booking_services : [{ service_name:b.service_name, category:b.service_category, preconsult_required:true }]; }
  function serviceSummary(b) { return services(b).map((s) => s.service_name).join(' · '); }
  function isCurly(b) {
    return services(b).some((s) => String(s.category || '').includes('curly') || /\bcurly\b|curl-defining/i.test(s.service_name || ''));
  }
  function isColourDomain(b) {
    return services(b).some((s) => /colour|color|highlight|balayage|airtouch|bleach|blond|grey blend|gray blend/i.test(`${s.category || ''} ${s.service_name || ''}`));
  }
  function serviceFriendly(b) {
    const cat = String(b.service_category || '').toLowerCase();
    if (cat.includes('balayage')) return 'Balayage';
    if (cat.includes('highlight')) return 'Highlights';
    if (cat.includes('colour_correction')) return 'Colour Correction';
    if (cat.includes('colour')) return 'Colour';
    if (cat.includes('curly')) return 'Curly Hair';
    if (/balayage/i.test(b.service_name)) return 'Balayage';
    if (/highlight/i.test(b.service_name)) return 'Highlights';
    if (/colour|color/i.test(b.service_name)) return 'Colour';
    return 'Curly Hair';
  }
  function validWhatsapp(phone) { return /^\+[1-9]\d{7,14}$/.test(String(phone || '').replace(/[\s()-]/g,'')); }
  function waPhone(phone) { return String(phone || '').replace(/\D/g,''); }

  function priority(b) {
    const p = b.preconsult_status || {};
    const h = hoursUntil(b);
    if (b.booking_status === 'cancelled' || p.workflow_status === 'blocked_cancelled') return { code:'cancelled', label:'Cancelled', rank:90 };
    if (p.maintenance_confirmed) return { code:'completed', label:'Maintaining · no photos needed', rank:80 };
    if (p.workflow_status === 'completed') return { code:'completed', label:'Completed', rank:80 };
    if (p.workflow_status === 'skipped') return { code:'completed', label:'Skipped', rank:75 };
    if (p.current_photos_received || p.workflow_status === 'photos_received') return { code:'ready', label:'Photos received', rank:50 };
    if (p.whatsapp_sent_at) return { code:'waiting', label:'Sent · client action optional', rank:30 };
    if (h <= 0) return { code:'urgent', label:'Appointment passed', rank:2 };
    if (h <= 36) return { code:'urgent', label:'Urgent · unsent', rank:0 };
    if (h <= 60) return { code:'due', label:'Send now · 48h', rank:10 };
    return { code:'upcoming', label:'Upcoming', rank:40 + Math.min(h / 24, 20) };
  }

  function readiness(b) {
    const p = b.preconsult_status || {};
    if (b.booking_status === 'cancelled') return 0;
    let n = 1; // detected
    if (p.whatsapp_sent_at) n++;
    if (p.current_photos_received) n++;
    if (p.workflow_status === 'completed') n++;
    return n;
  }

  function smartTemplate(b) {
    const name = firstName(b.client_name);
    const stylist = b.stylist_name || 'your stylist';
    const date = sgtDate(b.appointment_at);
    const time = sgtTime(b.appointment_at).toLowerCase();
    const service = serviceFriendly(b);
    const colour = isColourDomain(b);

    if (colour) {
      return `Hi ${name} 😊, thank you for booking your ${service} appointment with ${stylist} on ${date} at ${time}.

To help your stylist prepare for your consultation, if you’re considering a change from your current or usual look, could you please WhatsApp us:

• 1–2 current photos of your hair worn down
• 1–2 inspiration photos showing the look you have in mind, if available

If you’re simply maintaining your usual look with us, there’s nothing further you need to send 😊

Your stylist will assess your hair condition, existing colour and suitability for the desired result properly during your consultation.

We look forward to seeing you at Hera ✨`;
    }

    return `Hi ${name} 😊, thank you for booking your Curly Haircut appointment with ${stylist} on ${date} at ${time}.

If you’re considering a change to your haircut, shape, length or overall curly look, you’re very welcome to WhatsApp us:

• 1–2 current photos of your curls worn down
• 1–2 inspiration photos, if available

If you’re simply maintaining your usual curly look with us, there’s nothing further you need to send 😊

For your appointment, please come with your hair fully dry, worn down in its natural curl pattern and free from tangles or matting. Please avoid ponytails, braids, clips or stretched styles. Light styling product is absolutely fine, but please avoid heavy oils, butters or heavy product buildup.

This allows your stylist to properly assess how your curls naturally sit and move.

We look forward to seeing you at Hera ✨`;
  }
  function getMessage(b) { return state.drafts[b.id] ?? smartTemplate(b); }
  function setMessage(b, value) { state.drafts[b.id] = value; saveDrafts(); }
  function restoreMessage(b) { delete state.drafts[b.id]; saveDrafts(); }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type':'application/json', ...(options.headers || {}) },
      credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) { showLogin(); throw new Error('Session expired.'); }
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
    return payload;
  }

  function showLogin() {
    $('app').hidden = true; $('loginShell').hidden = false; $('password').value = ''; $('password').focus();
  }
  function showApp() { $('loginShell').hidden = true; $('app').hidden = false; }
  function toast(message) {
    const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 2400);
  }
  function setBusy(button, busy, label) {
    if (!button) return;
    if (busy) { button.dataset.label = button.textContent; button.disabled = true; button.innerHTML = `<span class="spin"></span>${esc(label || 'Working…')}`; }
    else { button.disabled = false; button.textContent = button.dataset.label || label || 'Done'; }
  }

  async function login(event) {
    event.preventDefault(); $('loginError').textContent = '';
    const button = event.submitter; setBusy(button, true, 'Checking…');
    try {
      await api('/api/login', { method:'POST', body:JSON.stringify({ password:$('password').value }) });
      showApp(); await loadData();
    } catch (error) { $('loginError').textContent = error.message; }
    finally { setBusy(button, false); }
  }

  async function logout() {
    try { await api('/api/logout', { method:'POST' }); } catch { /* no-op */ }
    showLogin();
  }

  async function loadData(silent = false) {
    if (state.busy) return;
    state.busy = true;
    if (!silent) $('bookingList').innerHTML = '<div class="empty"><strong>Loading live bookings…</strong>Reading the Hera pre-consult database.</div>';
    try {
      state.data = await api('/api/dashboard');
      populateFilters(); renderAll(); showApp();
    } catch (error) {
      if (error.message !== 'Session expired.') {
        const message = error instanceof Error ? error.message : String(error);
        toast(message);
        $('bookingList').innerHTML = `<div class="empty"><strong>Could not load live bookings</strong>${esc(message)}<br><br><button class="btn soft" id="retryLoad">Retry</button></div>`;
        const retry = $('retryLoad');
        if (retry) retry.addEventListener('click', () => loadData());
      }
    } finally { state.busy = false; }
  }

  async function syncNow() {
    const btn = $('syncBtn'); setBusy(btn, true, 'Scanning Gmail…');
    try {
      const result = await api('/api/sync-now', { method:'POST' });
      const bits = Object.entries(result.summary || {}).map(([k,v]) => `${v} ${k.toLowerCase().replace('_',' ')}`);
      toast(bits.length ? `Gmail scan complete · ${bits.join(' · ')}` : 'Gmail scan complete');
      await loadData(true);
    } catch (error) { toast(`Scan failed: ${error.message}`); }
    finally { setBusy(btn, false); }
  }

  function bookings() { return state.data?.bookings || []; }
  function tabMatch(b, tab) {
    const p = b.preconsult_status || {}, h = hoursUntil(b);
    if (tab === 'cancelled') return b.booking_status === 'cancelled' || p.workflow_status === 'blocked_cancelled';
    if (b.booking_status === 'cancelled' || p.workflow_status === 'blocked_cancelled') return false;
    if (tab === 'all') return true;
    if (tab === 'action') return !p.whatsapp_sent_at && !['completed','skipped'].includes(p.workflow_status) && h > 0;
    if (tab === 'waiting') return !!p.whatsapp_sent_at && !p.current_photos_received && !p.maintenance_confirmed && !['completed','skipped'].includes(p.workflow_status);
    if (tab === 'photos') return !!p.current_photos_received && !['completed','skipped'].includes(p.workflow_status);
    if (tab === 'completed') return p.maintenance_confirmed || ['completed','skipped'].includes(p.workflow_status);
    return true;
  }
  function filtered(tab = state.tab) {
    const q = state.search.trim().toLowerCase();
    return bookings().filter((b) => {
      if (!tabMatch(b, tab)) return false;
      if (state.category !== 'all' && b.service_category !== state.category) return false;
      if (state.stylist !== 'all' && (b.stylist_name || '') !== state.stylist) return false;
      if (state.location !== 'all' && (b.location_name || '') !== state.location) return false;
      if (q) {
        const hay = `${b.client_name} ${b.client_mobile || ''} ${b.client_email || ''} ${serviceSummary(b)} ${b.stylist_name || ''} ${b.location_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a,b) => priority(a).rank - priority(b).rank || new Date(a.appointment_at) - new Date(b.appointment_at));
  }

  function populateFilters() {
    const values = (field) => [...new Set(bookings().map((b) => b[field]).filter(Boolean))].sort((a,b) => String(a).localeCompare(String(b)));
    const setOpts = (id, vals, current, labeler = (x) => x) => {
      const el = $(id), first = el.options[0]?.outerHTML || '';
      el.innerHTML = first + vals.map((v) => `<option value="${attr(v)}">${esc(labeler(v))}</option>`).join('');
      el.value = vals.includes(current) ? current : 'all';
    };
    setOpts('categoryFilter', values('service_category'), state.category, categoryLabel);
    setOpts('stylistFilter', values('stylist_name'), state.stylist);
    setOpts('locationFilter', values('location_name'), state.location, shortLocation);
  }

  function counts() {
    const active = bookings().filter((b) => b.booking_status !== 'cancelled');
    const action = active.filter((b) => tabMatch(b,'action'));
    const urgent = action.filter((b) => ['urgent','due'].includes(priority(b).code));
    const waiting = active.filter((b) => tabMatch(b,'waiting'));
    const photos = active.filter((b) => tabMatch(b,'photos'));
    const complete = active.filter((b) => tabMatch(b,'completed'));
    return { action, urgent, waiting, photos, complete };
  }

  function renderAll() {
    renderHeader(); renderKpis(); renderBriefing(); renderTabs(); renderBookings(); renderSystem(); updateClock();
  }
  function renderHeader() {
    const c = counts();
    const urgent = c.action.filter((b) => priority(b).code === 'urgent').length;
    $('heroTitle').textContent = urgent ? `${urgent} urgent pre-consult${urgent === 1 ? '' : 's'} need attention` : 'Your pre-consult queue is under control';
    $('heroText').textContent = c.urgent.length
      ? `${c.urgent.length} qualifying appointment${c.urgent.length === 1 ? '' : 's'} are inside the smart 48-hour contact window. The queue is automatically sorted by urgency.`
      : `${c.action.length} qualifying appointment${c.action.length === 1 ? '' : 's'} remain to contact. Nothing is sent automatically.`;
    $('queueBtn').textContent = c.action.length ? `Start smart queue · ${c.action.length}` : 'Queue clear';
    $('queueBtn').disabled = !c.action.length;
    $('generatedAt').textContent = `Updated ${relativeTime(state.data?.generatedAt)}`;
  }
  function renderKpis() {
    const c = counts();
    const urgent = c.action.filter((b) => priority(b).code === 'urgent').length;
    const cards = [
      ['Action queue', c.action.length, urgent ? `${urgent} urgent` : 'Unsent qualifying clients', urgent ? 'attn' : ''],
      ['48h window', c.urgent.length, 'Due / urgent to contact', c.urgent.length ? 'attn' : ''],
      ['Sent / replies', c.waiting.length, 'No chase required unless client responds', ''],
      ['Photos in', c.photos.length, 'Ready for staff review', c.photos.length ? 'good' : ''],
      ['Completed', c.complete.length, 'Pre-consults closed', 'good'],
    ];
    $('kpis').innerHTML = cards.map(([label,value,sub,cls]) => `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div><div class="sub">${esc(sub)}</div></div>`).join('');
  }
  function renderBriefing() {
    const c = counts();
    const urgent = c.action.filter((b) => priority(b).code === 'urgent');
    const missing = bookings().filter((b) => b.booking_status !== 'cancelled' && !validWhatsapp(b.client_mobile));
    const items = [];
    if (urgent.length) items.push(`<div class="brief-item urgent"><strong>${urgent.length} urgent unsent</strong>${esc(urgent.slice(0,2).map((b)=>b.client_name).join(', '))}${urgent.length>2?' + more':''}</div>`);
    if (c.photos.length) items.push(`<div class="brief-item good"><strong>${c.photos.length} ready for review</strong>Current photos have arrived and can be handed to the stylist.</div>`);
    if (missing.length) items.push(`<div class="brief-item"><strong>${missing.length} missing / invalid mobile</strong>WhatsApp is disabled until the client record is corrected.</div>`);
    if (!items.length) items.push(`<div class="brief-item good"><strong>No immediate exceptions</strong>The qualifying workflow is currently clean.</div>`);
    $('briefing').innerHTML = items.join('');
  }
  function renderSystem() {
    const syncAt = state.data?.lastSync?.value?.at || state.data?.lastSync?.updated_at;
    const age = syncAt ? hoursSince(syncAt) : null;
    const healthy = age != null && age < 26;
    const alerts = state.data?.alerts || [];
    const relevantAlerts = alerts.filter((a) => !['same_day_booking'].includes(a.alert_type));
    const pill = $('healthPill');
    pill.className = `health-pill ${healthy ? 'good' : age == null ? 'bad' : 'warn'}`;
    pill.innerHTML = `<i></i><span>${healthy ? `Gmail sync healthy · ${relativeTime(syncAt)}` : age == null ? 'No sync checkpoint' : `Sync stale · ${relativeTime(syncAt)}`}</span>`;
    const summary = state.data?.lastSync?.value?.summary || {};
    $('systemList').innerHTML = `
      <div class="system-row"><span><i class="system-dot"></i>Last Gmail scan</span><b>${syncAt ? relativeTime(syncAt) : 'Never'}</b></div>
      <div class="system-row"><span>Last scan processed</span><b>${summary.PROCESSED || 0}</b></div>
      <div class="system-row"><span>Duplicates safely skipped</span><b>${summary.DUPLICATE || 0}</b></div>
      <div class="system-row"><span>Open system alerts</span><b>${relevantAlerts.length}</b></div>`;
  }
  function relativeTime(value) {
    if (!value) return '—';
    const mins = Math.round((Date.now() - new Date(value).getTime()) / 60000);
    if (mins < 1) return 'just now'; if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60); if (hrs < 48) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }
  function renderTabs() {
    $('tabs').innerHTML = TAB_DEFS.map(([id,label]) => {
      const count = bookings().filter((b) => tabMatch(b,id)).length;
      return `<button class="tab ${state.tab===id?'active':''}" data-tab="${id}">${esc(label)}<span class="count">${count}</span></button>`;
    }).join('');
    $('tabs').querySelectorAll('[data-tab]').forEach((el) => el.addEventListener('click', () => { state.tab = el.dataset.tab; renderTabs(); renderBookings(); }));
  }
  function renderBookings() {
    const rows = filtered(); $('resultCount').textContent = `${rows.length} appointment${rows.length===1?'':'s'}`;
    if (!rows.length) {
      $('bookingList').innerHTML = `<div class="empty"><strong>Nothing in this view</strong>Try another tab or clear the filters.</div>`; return;
    }
    $('bookingList').innerHTML = rows.map((b) => {
      const p = priority(b), h = hoursUntil(b);
      return `<article class="booking-row" data-open="${b.id}">
        <div class="appt-date"><div class="date">${esc(sgtDate(b.appointment_at))}</div><div class="time">${esc(sgtTime(b.appointment_at).toLowerCase())}</div></div>
        <div class="client-block"><div class="client-name">${esc(b.client_name)}</div><div class="client-meta">${esc(b.client_mobile || 'No mobile')} · ${esc(compactGap(h))}</div></div>
        <div class="service-block"><div class="service-name">${esc(serviceSummary(b))}</div><div class="tags"><span class="tag ${attr(b.service_category || '')}">${esc(categoryLabel(b.service_category))}</span>${b.booking_status==='changed'?'<span class="tag">changed</span>':''}</div></div>
        <div class="who-block"><strong>${esc(b.stylist_name || '—')}</strong>${esc(shortLocation(b.location_name))}</div>
        <div class="priority"><span class="status-badge ${p.code}">${esc(p.label)}</span></div>
        <button class="row-open" data-open="${b.id}" aria-label="Open ${attr(b.client_name)}">›</button>
      </article>`;
    }).join('');
    $('bookingList').querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); openBooking(el.dataset.open); }));
  }

  function currentBooking() { return bookings().find((b) => b.id === state.selectedId) || null; }
  function openBooking(id, queueMode = false) {
    state.selectedId = id; state.queueMode = queueMode;
    renderDrawer(); $('drawerBackdrop').hidden = false; $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden','false');
  }
  function closeDrawer() {
    $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden','true'); $('drawerBackdrop').hidden = true; state.queueMode = false;
  }
  function startQueue() {
    state.queue = bookings().filter((b) => tabMatch(b,'action')).sort((a,b) => priority(a).rank - priority(b).rank || new Date(a.appointment_at)-new Date(b.appointment_at)).map((b) => b.id);
    if (!state.queue.length) return toast('The action queue is clear.');
    state.queueIndex = 0; openBooking(state.queue[0], true);
  }
  function queueMove(delta) {
    state.queueIndex = Math.max(0, Math.min(state.queue.length - 1, state.queueIndex + delta));
    state.selectedId = state.queue[state.queueIndex]; renderDrawer();
  }
  function queueAdvance() {
    if (!state.queueMode) return;
    const remaining = state.queue.filter((id) => {
      const b = bookings().find((x) => x.id === id); return b && tabMatch(b,'action');
    });
    state.queue = remaining;
    if (!state.queue.length) { closeDrawer(); toast('Smart queue complete.'); return; }
    state.queueIndex = Math.min(state.queueIndex, state.queue.length - 1); state.selectedId = state.queue[state.queueIndex]; renderDrawer();
  }

  function renderDrawer() {
    const b = currentBooking(); if (!b) return closeDrawer();
    const p = b.preconsult_status || {}, pri = priority(b), message = getMessage(b), steps = readiness(b);
    const mobileOk = validWhatsapp(b.client_mobile);
    const colour = isColourDomain(b), curly = isCurly(b);
    const queueNav = state.queueMode ? `<div class="queue-nav"><span class="qpos">Smart queue · ${state.queueIndex+1} of ${state.queue.length}</span><button data-q="prev" ${state.queueIndex===0?'disabled':''}>← Previous</button><button data-q="next" ${state.queueIndex>=state.queue.length-1?'disabled':''}>Next →</button></div>` : '';
    $('drawerContent').innerHTML = `
      <div class="drawer-head">
        <div class="drawer-top"><div><p class="eyebrow">${esc(categoryLabel(b.service_category))} · ${esc(compactGap(hoursUntil(b)))}</p><h2>${esc(b.client_name)}</h2><div class="drawer-sub"><span class="status-badge ${pri.code}">${esc(pri.label)}</span></div></div><button class="drawer-close" id="drawerClose">×</button></div>
        ${queueNav}
      </div>
      <div class="drawer-body">
        <div class="detail-grid">
          <div class="detail"><span>Appointment</span><strong>${esc(sgt(b.appointment_at))}</strong></div>
          <div class="detail"><span>Stylist</span><strong>${esc(b.stylist_name || '—')}</strong></div>
          <div class="detail"><span>Location</span><strong>${esc(shortLocation(b.location_name))}</strong></div>
          <div class="detail"><span>Mobile</span><strong>${esc(b.client_mobile || 'Missing')}</strong></div>
        </div>
        <div class="detail" style="margin-bottom:15px"><span>Booked service${services(b).length>1?'s':''}</span><strong>${esc(serviceSummary(b))}</strong></div>

        <div class="progress-card"><div class="progress-top"><strong>Pre-consult readiness</strong><span>${steps} of 4 stages</span></div><div class="steps">${[1,2,3,4].map((n)=>`<i class="step ${n<=steps?'on':''}"></i>`).join('')}</div></div>

        <section class="section-card">
          <div class="section-card-head"><strong>Smart WhatsApp composer</strong><button class="btn soft" id="restoreMessage">Restore template</button></div>
          <div class="section-card-body">
            ${!mobileOk?'<div class="mobile-warning">WhatsApp is disabled because this client does not have a valid international mobile number in the scanned booking.</div>':''}
            <div class="smart-checks">
              <span class="smart-chip">Personalised</span>
              <span class="smart-chip">Conditional photo request</span>
              <span class="smart-chip">Maintenance opt-out included</span>
              ${curly && !colour?'<span class="smart-chip">Curly prep included</span>':''}
            </div>
            <textarea class="message" id="messageText">${esc(message)}</textarea>
            <div class="message-meta"><span id="charCount">${message.length} characters</span><span>Editable before opening WhatsApp</span></div>
            <div class="message-actions">
              <button class="btn soft" id="copyMessage">Copy</button>
              <button class="btn dark" id="openWhatsapp" ${mobileOk?'':'disabled'}>Open WhatsApp ↗</button>
              ${p.whatsapp_sent_at ? `<span class="status-badge ready">Marked sent ${esc(relativeTime(p.whatsapp_sent_at))}</span>` : '<button class="btn primary" id="markSent">Mark sent'+(state.queueMode?' & next':'')+'</button>'}
            </div>
          </div>
        </section>

        <section class="section-card">
          <div class="section-card-head"><strong>Client response & consultation prep</strong><span class="tiny">Saved to Supabase</span></div>
          <div class="section-card-body">
            <div class="checklist">
              <label class="check-row"><input type="checkbox" id="maintenanceConfirmed" ${p.maintenance_confirmed?'checked':''}><span class="txt"><strong>Client is maintaining usual look</strong><span>No photos are needed; the in-salon consultation will handle the professional assessment.</span></span></label>
              <label class="check-row"><input type="checkbox" id="currentPhotos" ${p.current_photos_received?'checked':''} ${p.maintenance_confirmed?'disabled':''}><span class="txt"><strong>Current hair photos received</strong><span>Only needed when the client is considering a change.</span></span></label>
              <label class="check-row"><input type="checkbox" id="inspoPhotos" ${p.inspiration_photos_received?'checked':''} ${p.maintenance_confirmed?'disabled':''}><span class="txt"><strong>Inspiration photos received</strong><span>Optional when the client wants a new or different look.</span></span></label>
            </div>
            <div class="complete-row">
              ${p.workflow_status === 'completed' ? '<button class="btn soft" id="reopenBtn">Reopen</button>' : '<button class="btn primary" id="completeBtn">Complete pre-consult</button>'}
              ${p.workflow_status !== 'skipped' && p.workflow_status !== 'completed' ? '<button class="btn soft" id="skipBtn">Skip / not needed</button>' : ''}
            </div>
          </div>
        </section>

        <section class="section-card">
          <div class="section-card-head"><strong>Staff notes</strong><span class="tiny">Internal only</span></div>
          <div class="section-card-body"><textarea class="notes" id="staffNotes" placeholder="Add anything the stylist or front desk should know…">${esc(p.staff_notes || '')}</textarea><div class="message-actions"><button class="btn soft" id="saveNotes">Save notes</button></div></div>
        </section>
      </div>`;

    $('drawerClose').onclick = closeDrawer;
    $('drawerContent').querySelectorAll('[data-q]').forEach((el) => el.onclick = () => queueMove(el.dataset.q === 'prev' ? -1 : 1));
    $('messageText').oninput = (e) => { setMessage(b, e.target.value); $('charCount').textContent = `${e.target.value.length} characters`; };
    $('restoreMessage').onclick = () => { restoreMessage(b); renderDrawer(); };
    $('copyMessage').onclick = async () => { await navigator.clipboard.writeText($('messageText').value); toast('Message copied.'); };
    $('openWhatsapp').onclick = () => openWhatsapp(b, $('messageText').value);
    if ($('markSent')) $('markSent').onclick = () => workflow(b, 'mark_sent', { messageText:$('messageText').value }, true);
    $('maintenanceConfirmed').onchange = (e) => workflow(b, 'set_maintenance', { value:e.target.checked }, e.target.checked);
    $('currentPhotos').onchange = (e) => workflow(b, 'set_current_photos', { value:e.target.checked });
    $('inspoPhotos').onchange = (e) => workflow(b, 'set_inspiration_photos', { value:e.target.checked });
    if ($('completeBtn')) $('completeBtn').onclick = () => workflow(b, 'complete', {}, true);
    if ($('skipBtn')) $('skipBtn').onclick = () => workflow(b, 'skip', {}, true);
    if ($('reopenBtn')) $('reopenBtn').onclick = () => workflow(b, 'reopen');
    $('saveNotes').onclick = () => workflow(b, 'save_notes', { notes:$('staffNotes').value });
  }

  function openWhatsapp(b, text) {
    if (!validWhatsapp(b.client_mobile)) return toast('Client mobile is not valid for WhatsApp.');
    const url = `https://wa.me/${waPhone(b.client_mobile)}?text=${encodeURIComponent(text)}`;
    window.open(url, 'hera-preconsult-whatsapp');
  }

  async function workflow(b, action, extra = {}, advance = false) {
    const clicked = document.activeElement?.tagName === 'BUTTON' ? document.activeElement : null;
    if (clicked) setBusy(clicked, true, 'Saving…');
    try {
      await api('/api/workflow', { method:'POST', body:JSON.stringify({ bookingId:b.id, action, ...extra }) });
      await loadData(true);
      if (advance && state.queueMode) queueAdvance();
      else if (state.selectedId) renderDrawer();
      toast('Saved to Hera workflow.');
    } catch (error) { toast(error.message); if (state.selectedId) renderDrawer(); }
  }

  function updateClock() {
    const d = new Date();
    $('nowDate').textContent = new Intl.DateTimeFormat('en-SG',{timeZone:'Asia/Singapore',weekday:'short',day:'numeric',month:'short'}).format(d);
    $('nowTime').textContent = new Intl.DateTimeFormat('en-SG',{timeZone:'Asia/Singapore',hour:'numeric',minute:'2-digit',hour12:true}).format(d).toLowerCase();
  }

  $('loginForm').addEventListener('submit', login);
  $('logoutBtn').addEventListener('click', logout);
  $('refreshBtn').addEventListener('click', () => loadData());
  $('syncBtn').addEventListener('click', syncNow);
  $('queueBtn').addEventListener('click', startQueue);
  $('drawerBackdrop').addEventListener('click', closeDrawer);
  $('searchInput').addEventListener('input', (e) => { state.search = e.target.value; renderBookings(); });
  $('categoryFilter').addEventListener('change', (e) => { state.category = e.target.value; renderBookings(); });
  $('stylistFilter').addEventListener('change', (e) => { state.stylist = e.target.value; renderBookings(); });
  $('locationFilter').addEventListener('change', (e) => { state.location = e.target.value; renderBookings(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('drawer').classList.contains('open')) closeDrawer(); });
  setInterval(updateClock, 30000); updateClock();

  loadData(true).catch(showLogin);
})();
