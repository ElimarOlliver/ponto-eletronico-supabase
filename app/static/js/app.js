/* Ponto Eletrônico — frontend (login só e-mail + senha)
 * - Sem innerHTML com dados do servidor (anti-XSS: só textContent/createElement).
 * - Tenant resolvido 100% no backend via /api/me; o cliente nunca define empresa.
 */
(function () {
  'use strict';

  let supa = null;
  const $ = (sel) => document.querySelector(sel);

  let els = {};
  let map = null;
  let markersLayer = null;

  // Empresa ativa selecionada pelo gestor multi-empresa (persistida localmente).
  let activeCompanyId = null;
  try {
    activeCompanyId = localStorage.getItem('pe_active_company') || null;
  } catch (e) { /* storage indisponível */ }

  const MANAGER_ROLES = new Set(['manager', 'company_admin', 'system_admin', 'admin']);
  const COMPANY_ADMIN_ROLES = new Set(['company_admin', 'system_admin', 'admin']);
  const VALID_PUNCH_TYPES = new Set(['in', 'out', 'break_start', 'break_end']);

  // Rótulos das ações de marcação (exigência de negócio do Operador).
  const PUNCH_LABELS = {
    in: 'Entrada',
    break_start: 'Saída Almoço / Intervalo',
    break_end: 'Retorno Almoço / Intervalo',
    out: 'Saída Final',
  };
  const punchLabel = (t) => PUNCH_LABELS[t] || String(t);

  const fmtBR = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium',
  });
  const fmtTimeBR = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
  });
  // Dia em AAAA-MM-DD (fuso de Brasília) para agrupar batidas.
  const fmtDayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const fmtDayLabel = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
  const dayKeyOf = (iso) => {
    try {
      return fmtDayKey.format(new Date(iso));
    } catch {
      return '';
    }
  };

  // ---------- DOM helpers (XSS-safe) ----------
  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function liText(text, className) {
    const li = document.createElement('li');
    if (className) li.className = className;
    li.textContent = text;
    return li;
  }

  function showLoginError(msg) {
    els.loginError.textContent = msg || '';
    els.loginError.classList.toggle('hidden', !msg);
  }

  function showForgotMsg(msg, isError) {
    els.forgotMsg.textContent = msg || '';
    els.forgotMsg.classList.toggle('hidden', !msg);
    els.forgotMsg.className = 'text-sm ' + (isError ? 'text-rose-600' : 'text-slate-700');
  }

  // ---------- Supabase ----------
  function initSupabase() {
    const url = window.__SUPABASE_URL__;
    const key = window.__SUPABASE_ANON_KEY__;
    if (!url || !key || url.includes('{{')) {
      showLoginError('Configuração ausente: SUPABASE_URL/ANON_KEY não injetadas.');
      throw new Error('missing supabase env');
    }
    supa = window.supabase.createClient(url, key);
  }

  async function authFetch(path, { method = 'GET', body, session } = {}) {
    const headers = { Authorization: 'Bearer ' + session.access_token };
    if (activeCompanyId) headers['X-Company-ID'] = activeCompanyId;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  async function readError(res) {
    try {
      const j = await res.json();
      // GoTrue usa {msg}, PostgREST/FastAPI usam {detail|message|error}
      const m = j.detail || j.message || j.error || j.msg || j.error_description;
      return (m && String(m)) || 'Erro (' + res.status + ')';
    } catch {
      return 'Erro (' + res.status + ')';
    }
  }

  // Extrai identificação da empresa do profile (sempre vinda do backend).
  function profileCompanyCNPJ(profile) {
    if (!profile || typeof profile !== 'object') return '';
    const raw =
      profile.company_cnpj ||
      profile.cnpj ||
      (profile.company && profile.company.cnpj) ||
      (profile.companies && profile.companies.cnpj) ||
      '';
    return String(raw || '').replace(/\D/g, '');
  }

  function formatCNPJ14(digits) {
    const d = String(digits || '').replace(/\D/g, '');
    if (d.length !== 14) return d;
    return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }

  function profileCompanyLabel(profile) {
    if (!profile || typeof profile !== 'object') return '—';
    const name =
      (profile.company && profile.company.nome) ||
      (profile.company && profile.company.name) ||
      profile.company_nome ||
      '';
    const cnpj = profileCompanyCNPJ(profile);
    const disp = cnpj ? formatCNPJ14(cnpj) : '';
    if (name && disp) return name + ' (' + disp + ')';
    return name || disp || '—';
  }

  // ---------- Design system: utilitários visuais (sem quebrar lógica) ----------
  function avatarInitials(name) {
    const s = String(name || '').trim();
    if (!s) return '';
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Minutos com sinal (ex.: "-1h30" para saldo negativo).
  const fmtSignedMin = (min) => {
    const m = Math.round(Number(min) || 0);
    const sign = m < 0 ? '-' : '';
    const abs = Math.abs(m);
    return sign + Math.floor(abs / 60) + 'h' + String(abs % 60).padStart(2, '0');
  };

  const punchDotColor = (type) => ({
    in: 'bg-amber-400',
    break_start: 'bg-blue-500',
    break_end: 'bg-blue-300',
    out: 'bg-slate-500',
  }[type] || 'bg-slate-300');

  function statusBadge(status) {
    const s = String(status || 'pending');
    const cls = {
      approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      rejected: 'bg-rose-50 text-rose-700 border-rose-200',
      pending: 'bg-amber-50 text-amber-700 border-amber-200',
    }[s] || 'bg-slate-50 text-slate-600 border-slate-200';
    const span = document.createElement('span');
    span.className = 'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ' + cls;
    span.textContent = s;
    return span;
  }

  // Status do espelho de ponto (valores vindos do backend: ok/incomplete/absent/holiday/weekend).
  function dayStatusBadge(d) {
    const span = document.createElement('span');
    const base = 'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide';
    if (d.pending) {
      span.className = base + ' border-amber-200 bg-amber-50 text-amber-700';
      span.textContent = 'Pendente';
    } else if (d.holiday) {
      span.className = base + ' border-indigo-200 bg-indigo-50 text-indigo-700';
      span.textContent = 'Feriado';
    } else {
      const map = {
        weekend: ['Folga', 'border-slate-200 bg-slate-50 text-slate-600'],
        absent: ['Falta', 'border-rose-200 bg-rose-50 text-rose-700'],
        incomplete: ['Incompleto', 'border-amber-200 bg-amber-50 text-amber-700'],
        ok: ['OK', 'border-emerald-200 bg-emerald-50 text-emerald-700'],
      };
      const cfg = map[String(d.status || '')] || ['—', 'border-slate-200 bg-slate-50 text-slate-600'];
      span.className = base + ' ' + cfg[1];
      span.textContent = cfg[0];
    }
    return span;
  }

  // Resumo do dia: deriva o status pela última batida (sem chamada extra).
  const DAY_STATUS_MAP = [
    ['in', 'Em serviço', 'bg-emerald-400'],
    ['break_start', 'Em intervalo', 'bg-amber-400'],
    ['break_end', 'Retornou do intervalo', 'bg-blue-400'],
    ['out', 'Jornada encerrada', 'bg-slate-400'],
  ];

  function renderDaySummary(dayPunches) {
    if (!els.dayStatus || !els.dayStatusDot || !els.dayStatusText || !els.dayCount) return;
    const list = Array.isArray(dayPunches)
      ? dayPunches.slice().sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))
      : [];
    els.dayCount.textContent = list.length
      ? list.length + ' batida' + (list.length > 1 ? 's' : '') + ' registrada' + (list.length > 1 ? 's' : '') + ' hoje'
      : 'Nenhuma batida hoje';
    if (!list.length) {
      els.dayStatusDot.className = 'h-2 w-2 rounded-full bg-slate-300';
      els.dayStatusText.textContent = 'Aguardando entrada';
      return;
    }
    const last = list[list.length - 1];
    const cfg = DAY_STATUS_MAP.find(([t]) => t === last.p_type);
    if (cfg) {
      els.dayStatusDot.className = 'h-2 w-2 rounded-full ' + cfg[2] + (cfg[0] === 'in' ? ' animate-pulse' : '');
      els.dayStatusText.textContent = cfg[1];
    }
  }

  // Métricas da semana (usa /api/timesheet, que o próprio colaborador pode chamar).
  function mondayISO() {
    const now = new Date();
    const dow = (now.getDay() + 6) % 7; // segunda = 0
    const mon = new Date(now);
    mon.setDate(now.getDate() - dow);
    const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return { start: iso(mon), end: iso(now) };
  }

  async function refreshWeekMetrics(session) {
    if (!els.metricWorked || !els.metricBalance || !els.metricOvertime) return;
    els.metricWorked.textContent = '—';
    els.metricBalance.textContent = '—';
    els.metricBalance.className = 'mt-2 text-3xl font-bold tracking-tight text-slate-900';
    els.metricOvertime.textContent = '—';
    try {
      const rng = mondayISO();
      const url = '/api/timesheet?start=' + rng.start + '&end=' + rng.end + '&expected_daily_min=480';
      const res = await authFetch(url, { session });
      if (!res.ok) return;
      const data = await res.json();
      const t = (data && data.totals) || {};
      els.metricWorked.textContent = fmtSignedMin(t.worked_min);
      els.metricBalance.textContent = fmtSignedMin(t.balance_min);
      els.metricBalance.className = 'mt-2 text-3xl font-bold tracking-tight ' +
        (Number(t.balance_min) < 0 ? 'text-rose-600' : 'text-slate-900');
      els.metricOvertime.textContent = fmtSignedMin(t.overtime_min);
    } catch (e) {
      console.error(e);
    }
  }

  // Relógio digital em tempo real (Brasília).
  function startClock() {
    if (!els.liveClock || !els.liveDate || startClock.done) return;
    startClock.done = true;
    const tick = () => {
      const n = new Date();
      els.liveClock.textContent = n.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });
      els.liveDate.textContent = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      }).format(n);
    };
    tick();
    setInterval(tick, 1000);
  }

  // ---------- Auth (só e-mail + senha; tenant resolvido no backend) ----------
  async function signIn(email, password) {
    email = String(email || '').trim();
    if (!email || !password) {
      showLoginError('Informe e-mail e senha.');
      return;
    }
    showLoginError('');
    els.btnDoLogin.disabled = true;
    try {
      const { data, error } = await supa.auth.signInWithPassword({ email, password });
      if (error) {
        // 500 = Auth fora do ar (nunca é "senha errada"): mensagem orientadora.
        const status = Number((error && (error.status || error.code)) || 0);
        if (status >= 500) {
          showLoginError('Servidor de autenticação indisponível no momento. Tente novamente em instantes.');
          return;
        }
        const msg = error && error.message ? String(error.message) : '';
        showLoginError(msg || 'Falha no login. Confira e-mail/senha e tente novamente.');
        return;
      }
      if (!data.session) {
        showLoginError('Login sem sessão. Tente novamente.');
        return;
      }
      // Valida vínculo/empresa no backend (403 p/ sem empresa ou inativa).
      const meRes = await authFetch('/api/me', { session: data.session });
      if (!meRes.ok) {
        await supa.auth.signOut();
        showLoginError(await readError(meRes));
        return;
      }
      await renderAuth();
    } finally {
      els.btnDoLogin.disabled = false;
    }
  }

  async function signOut() {
    try {
      await supa.auth.signOut();
    } finally {
      await renderAuth();
    }
  }

  function showLogin() {
    if (els.loginSection) els.loginSection.classList.remove('hidden');
    els.loginCard.classList.remove('hidden');
    els.forgotCard.classList.add('hidden');
    showForgotMsg('');
  }

  function showForgot() {
    if (els.loginSection) els.loginSection.classList.remove('hidden');
    els.loginCard.classList.add('hidden');
    els.forgotCard.classList.remove('hidden');
    showLoginError('');
    showForgotMsg('');
  }

  async function forgotPassword(email) {
    email = String(email || '').trim();
    if (!email) {
      showForgotMsg('Informe o e-mail cadastrado.', true);
      return;
    }
    showForgotMsg('');
    els.btnForgotSend.disabled = true;
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showForgotMsg((data && (data.detail || data.message)) || 'Falha ao enviar. Tente novamente.', true);
        return;
      }
      showForgotMsg('Se o e-mail estiver cadastrado, você receberá o link de redefinição.', false);
      els.forgotEmail.value = '';
    } finally {
      els.btnForgotSend.disabled = false;
    }
  }

  // ---------- Render ----------
  function renderCompanySelector(me) {
    const comps = Array.isArray(me && me.companies) ? me.companies : [];
    clear(els.companySelect);
    if (comps.length > 1) {
      els.companySelect.classList.remove('hidden');
      comps.forEach((c) => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = (c.nome || 'Empresa') + (c.cnpj ? ' — ' + formatCNPJ14(c.cnpj) : '');
        els.companySelect.appendChild(o);
      });
      els.companySelect.value = (me && me.company_id) || comps[0].id;
    } else {
      els.companySelect.classList.add('hidden');
    }
  }

  async function renderAuth() {
    const { data: { session } } = await supa.auth.getSession();
    const logged = !!session;
    els.loginCard.classList.toggle('hidden', logged);
    els.btnLogout.classList.toggle('hidden', !logged);
    els.userInfo.classList.toggle('hidden', !logged);
    els.punchesCard.classList.toggle('hidden', !logged);
    if (!logged) {
      els.teamCard.classList.add('hidden');
      els.holidaysCard.classList.add('hidden');
      els.payrollCard.classList.add('hidden');
      els.mapCard.classList.add('hidden');
      els.companyBadge.classList.add('hidden');
      els.companySelect.classList.add('hidden');
      try { localStorage.removeItem('pe_active_company'); } catch (e) { /* noop */ }
      clear(els.punchesToday);
      clear(els.punchesWeek);
      clear(els.teamPunchesUl);
      clear(els.teamMembersDiv);
      clear(els.teamUserSelect);
      showLoginError('');
      return;
    }
    if (els.loginSection) els.loginSection.classList.add('hidden');
    let me = null;
    try {
      const meRes = await authFetch('/api/me', { session });
      if (!meRes.ok) {
        // Conta sem vínculo ou empresa desativada: derruba a sessão local.
        await supa.auth.signOut();
        els.loginCard.classList.remove('hidden');
        els.btnLogout.classList.add('hidden');
        els.userInfo.classList.add('hidden');
        els.punchesCard.classList.add('hidden');
        els.teamCard.classList.add('hidden');
        els.holidaysCard.classList.add('hidden');
        els.payrollCard.classList.add('hidden');
        els.mapCard.classList.add('hidden');
        els.companyBadge.classList.add('hidden');
        els.companySelect.classList.add('hidden');
        showLogin();
        showLoginError(await readError(meRes));
        return;
      }
      me = await meRes.json();
    } catch (e) {
      console.error(e);
    }
    els.userFullName.textContent = (me && me.full_name) || (session.user && session.user.email) || session.user.id;
    els.userRole.textContent = (me && me.role) || '—';
    els.userCompany.textContent = profileCompanyLabel(me);
    if (els.userAvatar) {
      els.userAvatar.textContent =
        avatarInitials(me && me.full_name) || avatarInitials(session.user && session.user.email) || '--';
    }
    renderCompanySelector(me);
    const badge = profileCompanyLabel(me);
    if (me && (me.company_nome || profileCompanyCNPJ(me))) {
      els.companyBadge.textContent = badge;
      els.companyBadge.classList.remove('hidden');
    } else {
      els.companyBadge.classList.add('hidden');
    }
    // Operador (employee): interface estritamente mínima — só registro do dia.
    const isLeader = !!me && MANAGER_ROLES.has(me.role);
    els.mapCard.classList.toggle('hidden', !isLeader);

    await refreshPunches(session);
    await refreshWeekMetrics(session);
    if (isLeader) {
      await refreshManager(session, me);
      await refreshHolidays(session, me);
      await refreshPayroll(session, me);
      initMap();
    } else {
      els.teamCard.classList.add('hidden');
      els.holidaysCard.classList.add('hidden');
      els.payrollCard.classList.add('hidden');
    }
  }

  function renderPunchList(ul, list) {
    clear(ul);
    if (!list || !list.length) {
      ul.appendChild(liText('Nenhuma batida.', 'text-sm text-slate-400'));
      return;
    }
    list.slice().sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1)).forEach((p) => {
      let txt = fmtTimeBR.format(new Date(p.occurred_at)) + ' — ' + punchLabel(p.p_type);
      if (p.note) txt += ' · Nota: ' + String(p.note);
      const li = liText(txt, 'flex items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-700');
      const dot = document.createElement('span');
      dot.className = 'h-2 w-2 shrink-0 rounded-full ' + punchDotColor(p.p_type);
      li.prepend(dot);
      ul.appendChild(li);
    });
  }

  function renderWeekHistory(ul, punches) {
    clear(ul);
    const byDay = new Map();
    (Array.isArray(punches) ? punches : []).forEach((p) => {
      const k = dayKeyOf(p.occurred_at);
      if (!k) return;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(p);
    });
    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const k = fmtDayKey.format(d);
      const arr = (byDay.get(k) || []).slice().sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
      const head = document.createElement('li');
      head.className = 'flex items-center gap-2 pt-3 text-xs font-bold uppercase tracking-wide text-slate-500';
      if (i === 6) head.className += ' pt-0';
      head.textContent = fmtDayLabel.format(d) + (arr.length ? ' · ' + arr.length + ' batida' + (arr.length > 1 ? 's' : '') : '');
      ul.appendChild(head);
      if (!arr.length) {
        ul.appendChild(liText('Sem batidas.', 'pl-4 text-xs text-slate-400'));
      } else {
        arr.forEach((p) => {
          const li = liText(fmtTimeBR.format(new Date(p.occurred_at)) + ' — ' + punchLabel(p.p_type),
            'flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-slate-600');
          const dot = document.createElement('span');
          dot.className = 'h-1.5 w-1.5 shrink-0 rounded-full ' + punchDotColor(p.p_type);
          li.prepend(dot);
          ul.appendChild(li);
        });
      }
    }
  }

  async function refreshPunches(session) {
    try {
      const res = await authFetch('/api/my-punches?limit=100', { session });
      if (!res.ok) {
        console.error(await readError(res));
        return;
      }
      const data = await res.json();
      const punches = Array.isArray(data) ? data : [];

      const todayKey = dayKeyOf(new Date().toISOString());
      const byDay = new Map();
      punches.forEach((p) => {
        const k = dayKeyOf(p.occurred_at);
        if (!k) return;
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(p);
      });
      renderPunchList(els.punchesToday, byDay.get(todayKey) || []);
      renderWeekHistory(els.punchesWeek, punches);
      renderDaySummary(byDay.get(todayKey) || []);

      if (map && punches.length && markersLayer) {
        markersLayer.clearLayers();
        punches.slice(0, 10).forEach((p) => {
          const lat = Number(p.latitude);
          const lon = Number(p.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const marker = window.L.marker([lat, lon])
              .bindPopup(punchLabel(p.p_type) + ' — ' + fmtBR.format(new Date(p.occurred_at)));
            markersLayer.addLayer(marker);
          }
        });
        const first = punches.find((p) => Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)));
        if (first) map.setView([Number(first.latitude), Number(first.longitude)], 13);
      }
    } catch (e) {
      console.error(e);
    }
  }

  function initMap() {
    if (map || !window.L) return;
    map = window.L.map('map').setView([-23.55, -46.63], 10);
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    markersLayer = window.L.layerGroup().addTo(map);
  }

  let punchInFlight = false;

  async function doPunch(type) {
    if (!VALID_PUNCH_TYPES.has(type)) return;
    if (punchInFlight) return; // trava contra duplo-clique / retry concorrente
    const { data: { session } } = await supa.auth.getSession();
    if (!session) {
      showLoginError('Faça login primeiro.');
      return;
    }
    punchInFlight = true;
    document.querySelectorAll('.btn-punch').forEach((b) => { b.disabled = true; });
    try {
      const position = await new Promise((resolve) => {
        try {
          if (!navigator.geolocation) return resolve(null);
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve(pos),
            () => resolve(null),
            { enableHighAccuracy: true, timeout: 5000 },
          );
        } catch {
          resolve(null);
        }
      });
      const lat = position && position.coords ? position.coords.latitude : null;
      const lon = position && position.coords ? position.coords.longitude : null;
      const accuracy = position && position.coords ? position.coords.accuracy : null;

      // Validação básica client-side (backend deve revalidar).
      if (lat !== null && (typeof lat !== 'number' || lat < -90 || lat > 90)) {
        alert('Localização inválida.');
        return;
      }
      if (lon !== null && (typeof lon !== 'number' || lon < -180 || lon > 180)) {
        alert('Localização inválida.');
        return;
      }

      const res = await authFetch('/api/clock', {
        method: 'POST',
        session,
        body: { type, lat, lon, accuracy },
      });
      if (!res.ok) {
        alert(await readError(res));
        return;
      }
      await refreshPunches(session);
    } finally {
      punchInFlight = false;
      document.querySelectorAll('.btn-punch').forEach((b) => { b.disabled = false; });
    }
  }

  // ---------- Área do gestor ----------
  function canSeeTeam(me) {
    return !!me && MANAGER_ROLES.has(me.role);
  }

  async function refreshManager(session, me) {
    try {
      if (!me) {
        const meRes = await authFetch('/api/me', { session });
        if (!meRes.ok) {
          els.teamCard.classList.add('hidden');
          return;
        }
        me = await meRes.json();
      }
      if (!canSeeTeam(me)) {
        els.teamCard.classList.add('hidden');
        return;
      }
      els.teamCard.classList.remove('hidden');

      const tRes = await authFetch('/api/team', { session });
      if (!tRes.ok) {
        els.teamPunchesUl.textContent = '';
        els.teamPunchesUl.appendChild(liText('Falha ao carregar equipe.', 'text-rose-600'));
        return;
      }
      const team = await tRes.json();

      clear(els.teamUserSelect);
      clear(els.teamMembersDiv);
      const members = Array.isArray(team) ? team : [];
      members.forEach((member) => {
        const opt = document.createElement('option');
        opt.value = member.id;
        opt.textContent = (member.full_name || member.id) + ' (' + member.role + ')';
        els.teamUserSelect.appendChild(opt);

        const chip = document.createElement('span');
        const roleCls = {
          company_admin: 'border-blue-200 bg-blue-50 text-blue-700',
          system_admin: 'border-blue-200 bg-blue-50 text-blue-700',
          admin: 'border-blue-200 bg-blue-50 text-blue-700',
          manager: 'border-indigo-200 bg-indigo-50 text-indigo-700',
        }[member.role] || 'border-slate-200 bg-slate-50 text-slate-600';
        chip.className = 'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ' + roleCls;
        chip.textContent = (member.full_name || member.id) + ' · ' + member.role;
        els.teamMembersDiv.appendChild(chip);
      });
      if (els.statTeam) {
        els.statTeam.textContent = members.length + ' colaborador' + (members.length !== 1 ? 'es' : '');
      }

      els.teamUserSelect.onchange = async () => {
        await loadTeamPunches(session, els.teamUserSelect.value);
      };
      els.btnApplyFilter.onclick = async () => {
        await loadTeamPunches(session, els.teamUserSelect.value);
      };

      if (Array.isArray(team) && team.length) {
        els.teamUserSelect.value = team[0].id;
        await loadTeamPunches(session, team[0].id);
      } else {
        clear(els.teamPunchesUl);
        els.teamPunchesUl.appendChild(liText('Nenhum colaborador encontrado.', 'text-gray-500'));
      }
    } catch (e) {
      console.error(e);
      els.teamCard.classList.add('hidden');
    }
  }

  function punchRow(p, session, userId) {
    const li = document.createElement('li');
    li.className = 'rounded-2xl border border-slate-100 bg-white p-3 shadow-sm';

    const head = document.createElement('div');
    head.className = 'flex flex-wrap items-center gap-2';
    const when = fmtBR.format(new Date(p.occurred_at));

    const ttl = document.createElement('span');
    ttl.className = 'text-sm font-semibold text-slate-800';
    ttl.textContent = punchLabel(p.p_type) + ' · ' + when;
    head.appendChild(ttl);

    head.appendChild(statusBadge(p.approval_status || 'pending'));

    if (p.latitude && p.longitude) {
      const geo = document.createElement('span');
      geo.className = 'text-[11px] text-slate-400';
      geo.textContent = '(' + p.latitude + ', ' + p.longitude + ')';
      head.appendChild(geo);
    }
    if (p.note) {
      const note = document.createElement('span');
      note.className = 'rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500';
      note.textContent = 'Nota: ' + String(p.note);
      head.appendChild(note);
    }
    li.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'mt-2 flex flex-wrap gap-1.5';

    const pending = (p.approval_status || 'pending') === 'pending';
    const baseCls = 'rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition active:scale-95 ';
    const makeBtn = (label, kind, cls) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = baseCls + cls;
      b.textContent = label;
      b.addEventListener('click', async () => {
        if (kind === 'approve' || kind === 'reject') {
          const up = await authFetch('/api/punch-approve', {
            method: 'POST', session, body: { id: p.id, decision: kind === 'approve' ? 'approved' : 'rejected' },
          });
          if (!up.ok) { alert(await readError(up)); return; }
        } else if (kind === 'note') {
          const note = prompt('Nova nota (vazio apaga):', '');
          if (note === null) return;
          const up = await authFetch('/api/punch-update', {
            method: 'POST', session, body: { id: p.id, note: note === '' ? null : note },
          });
          if (!up.ok) { alert(await readError(up)); return; }
        } else {
          const cur = new Date(p.occurred_at);
          const pad = (n) => String(n).padStart(2, '0');
          const currentLocal =
            cur.getFullYear() + '-' + pad(cur.getMonth() + 1) + '-' + pad(cur.getDate()) +
            'T' + pad(cur.getHours()) + ':' + pad(cur.getMinutes());
          const val = prompt('Novo horário (AAAA-MM-DDTHH:MM, horário local):', currentLocal);
          if (!val) return;
          const dt = new Date(val);
          if (Number.isNaN(dt.getTime())) { alert('Data/hora inválida.'); return; }
          const up = await authFetch('/api/punch-update', {
            method: 'POST', session, body: { id: p.id, occurred_at: dt.toISOString() },
          });
          if (!up.ok) { alert(await readError(up)); return; }
        }
        await loadTeamPunches(session, userId);
      });
      actions.appendChild(b);
    };

    if (pending) {
      makeBtn('Aprovar', 'approve', 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100');
      makeBtn('Rejeitar', 'reject', 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100');
    }
    makeBtn('editar nota', 'note', 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50');
    makeBtn('editar horário', 'time', 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50');

    li.appendChild(actions);
    return li;
  }

  async function loadTeamPunches(session, userId) {
    clear(els.teamPunchesUl);
    els.teamPunchesUl.appendChild(liText('Carregando...'));
    try {
      if (!userId) {
        clear(els.teamPunchesUl);
        els.teamPunchesUl.appendChild(liText('Selecione um colaborador.', 'text-gray-500'));
        return;
      }
      const start = els.inputStart.value ? new Date(els.inputStart.value).toISOString() : '';
      const end = els.inputEnd.value ? new Date(els.inputEnd.value).toISOString() : '';

      const url = new URL('/api/team-punches', window.location.origin);
      url.searchParams.set('user_id', userId);
      url.searchParams.set('limit', '50');
      if (start) url.searchParams.set('start', start);
      if (end) url.searchParams.set('end', end);

      const res = await authFetch(url.pathname + url.search, { session });
      const data = await res.json();
      clear(els.teamPunchesUl);

      if (!res.ok) {
        els.teamPunchesUl.appendChild(liText((data && (data.detail || data.message)) || 'Erro ao carregar.', 'text-rose-600'));
        return;
      }
      if (!Array.isArray(data) || !data.length) {
        els.teamPunchesUl.appendChild(liText('Sem registros.', 'text-slate-400'));
        return;
      }
      data.forEach((p) => {
        els.teamPunchesUl.appendChild(punchRow(p, session, userId));
      });
    } catch (e) {
      console.error(e);
      clear(els.teamPunchesUl);
      els.teamPunchesUl.appendChild(liText('Erro ao carregar pontos.', 'text-rose-600'));
    }
  }

  // ---------- Feriados (BrasilAPI + locais) ----------
  const fmtDateBR = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' });

  async function refreshHolidays(session, me) {
    els.holidaysCard.classList.remove('hidden');
    const isAdmin = !!me && COMPANY_ADMIN_ROLES.has(me.role);
    els.btnHolidaysSync.classList.toggle('hidden', !isAdmin);
    els.holidayForm.classList.toggle('hidden', !isAdmin);
    await loadHolidays(session);
  }

  async function loadHolidays(session) {
    clear(els.holidaysList);
    els.holidaysList.appendChild(liText('Carregando...'));
    try {
      const year = parseInt(els.holidayYear.value, 10) || new Date().getFullYear();
      const res = await authFetch('/api/holidays?year=' + encodeURIComponent(String(year)), { session });
      const data = await res.json();
      clear(els.holidaysList);
      if (!res.ok) {
        els.holidaysList.appendChild(liText((data && (data.detail || data.message)) || 'Erro ao carregar.', 'text-rose-600'));
        return;
      }
      if (!Array.isArray(data) || !data.length) {
        els.holidaysList.appendChild(liText('Sem feriados para ' + year + '. Admin: clique em Sincronizar BrasilAPI.', 'text-gray-500'));
        return;
      }
      data.forEach((h) => {
        const li = document.createElement('li');
        li.className = 'flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2';
        const label = document.createElement('span');
        let d = String(h.h_date || '');
        try { d = fmtDateBR.format(new Date(d + 'T12:00:00')); } catch { /* mantém */ }
        label.textContent = d + ' · ' + String(h.name);
        label.className = 'text-sm text-slate-700';
        li.appendChild(label);

        const local = !!(h.company_id);
        const kind = document.createElement('span');
        kind.className = 'shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ' +
          (local ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-500');
        kind.textContent = local ? 'Local' : 'Nacional';
        li.appendChild(kind);
        els.holidaysList.appendChild(li);
      });
      if (els.statHolidays) {
        els.statHolidays.textContent = data.length + ' feriado' + (data.length !== 1 ? 's' : '');
      }
    } catch (e) {
      console.error(e);
      clear(els.holidaysList);
      els.holidaysList.appendChild(liText('Erro ao carregar feriados.', 'text-rose-600'));
    }
  }

  // ---------- Folha (espelho + fechamento, anti-XSS) ----------
  function fmtMin(min) {
    const m = Math.max(0, Math.round(Number(min) || 0));
    const h = Math.floor(m / 60);
    const r = String(m % 60).padStart(2, '0');
    return h + 'h' + r;
  }

  function firstDayOfMonthISO() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-01';
  }

  function todayISO() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }

  async function refreshPayroll(session, me) {
    els.payrollCard.classList.remove('hidden');
    if (els.statCompany) {
      els.statCompany.textContent = profileCompanyLabel(me) || '—';
    }
    const isManager = !!me && MANAGER_ROLES.has(me.role);
    const isAdmin = !!me && COMPANY_ADMIN_ROLES.has(me.role);
    els.closeWrap.classList.toggle('hidden', !isAdmin);

    // Espelho: próprio por padrão; gestor pode escolher colaborador da equipe.
    clear(els.mirrorUserSelect);
    const selfOpt = document.createElement('option');
    selfOpt.value = '';
    selfOpt.textContent = 'Meu espelho';
    els.mirrorUserSelect.appendChild(selfOpt);
    if (isManager) {
      try {
        const tRes = await authFetch('/api/team', { session });
        if (tRes.ok) {
          const team = await tRes.json();
          (Array.isArray(team) ? team : []).forEach((member) => {
            const opt = document.createElement('option');
            opt.value = member.id;
            opt.textContent = 'Espelho: ' + (member.full_name || member.id);
            els.mirrorUserSelect.appendChild(opt);
          });
        }
      } catch (e) {
        console.error(e);
      }
    }
    els.mirrorUserWrap.classList.toggle('hidden', !isManager);

    if (!els.mirrorStart.value) els.mirrorStart.value = firstDayOfMonthISO();
    if (!els.mirrorEnd.value) els.mirrorEnd.value = todayISO();
    if (!els.closeStart.value) els.closeStart.value = firstDayOfMonthISO();
    if (!els.closeEnd.value) els.closeEnd.value = todayISO();

    await loadMirror(session);
    if (isManager) await loadClosings(session);
    else clear(els.closingsList);
  }

  function mirrorCell(text, extra) {
    const td = document.createElement('td');
    td.className = 'px-3 py-2.5 text-slate-600' + (extra ? ' ' + extra : '');
    td.textContent = text;
    return td;
  }

  async function loadMirror(session) {
    clear(els.mirrorTableBody);
    els.mirrorTotals.textContent = 'Carregando...';
    try {
      const userId = els.mirrorUserSelect.value || '';
      const url = new URL('/api/timesheet', window.location.origin);
      if (userId) url.searchParams.set('user_id', userId);
      url.searchParams.set('start', els.mirrorStart.value);
      url.searchParams.set('end', els.mirrorEnd.value);
      url.searchParams.set('expected_daily_min', els.mirrorExpected.value || '480');

      const res = await authFetch(url.pathname + url.search, { session });
      const data = await res.json();
      clear(els.mirrorTableBody);
      if (!res.ok) {
        els.mirrorTotals.textContent = (data && (data.detail || data.message)) || 'Erro ao gerar espelho.';
        return;
      }
      const t = data.totals || {};
      let tot = 'Total: trabalhado ' + fmtMin(t.worked_min) + ' / previsto ' + fmtMin(t.expected_min) +
        ' · saldo ' + fmtMin(t.balance_min) + (Number(t.balance_min) < 0 ? ' negativo' : '') +
        ' · extra ' + fmtMin(t.overtime_min) + ' · falta ' + fmtMin(t.deficit_min);
      if (t.has_pending) tot += ' · ATENÇÃO: há pontos pendentes de aprovação';
      if (t.has_incomplete) tot += ' · há dias incompletos para revisão';
      els.mirrorTotals.textContent = tot;

      (Array.isArray(data.days) ? data.days : []).forEach((d) => {
        const tr = document.createElement('tr');
        tr.className = 'border-b border-slate-100 odd:bg-white even:bg-slate-50/60 hover:bg-blue-50/40';
        let dateTxt = String(d.date || '');
        try { dateTxt = fmtDateBR.format(new Date(dateTxt + 'T12:00:00')); } catch { /* mantém */ }
        tr.appendChild(mirrorCell(dateTxt, 'font-semibold text-slate-800'));

        const tdStatus = document.createElement('td');
        tdStatus.className = 'px-3 py-2.5';
        tdStatus.appendChild(dayStatusBadge(d));
        tr.appendChild(tdStatus);

        tr.appendChild(mirrorCell(fmtMin(d.expected_min)));
        tr.appendChild(mirrorCell(fmtMin(d.worked_min)));
        tr.appendChild(mirrorCell(fmtMin(d.overtime_min), 'text-emerald-600'));
        tr.appendChild(mirrorCell(fmtMin(d.deficit_min), 'text-rose-600'));
        tr.appendChild(mirrorCell(String(d.punches || 0), d.pending ? 'font-bold text-amber-700' : ''));
        els.mirrorTableBody.appendChild(tr);
      });
      if (!els.mirrorTableBody.firstChild) {
        const tr = document.createElement('tr');
        tr.appendChild(mirrorCell('Sem dias no período.'));
        els.mirrorTableBody.appendChild(tr);
      }
    } catch (e) {
      console.error(e);
      els.mirrorTotals.textContent = 'Erro ao gerar espelho.';
    }
  }

  async function loadClosings(session) {
    clear(els.closingsList);
    try {
      const res = await authFetch('/api/payroll/closings', { session });
      const data = await res.json();
      if (!res.ok) {
        els.closingsList.appendChild(liText((data && (data.detail || data.message)) || 'Erro.', 'text-rose-600'));
        return;
      }
      if (!Array.isArray(data) || !data.length) {
        els.closingsList.appendChild(liText('Nenhum fechamento.', 'text-gray-500'));
        return;
      }
      data.forEach((c) => {
        els.closingsList.appendChild(liText(
          String(c.period_start) + ' → ' + String(c.period_end) + ' · ' + String(c.status),
          'rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-sm text-slate-600',
        ));
      });
    } catch (e) {
      console.error(e);
    }
  }

  // ---------- Boot ----------
  function wire() {
    els.btnMirror.addEventListener('click', async () => {
      const { data: { session } } = await supa.auth.getSession();
      if (session) await loadMirror(session);
    });
    els.mirrorUserSelect.addEventListener('change', async () => {
      const { data: { session } } = await supa.auth.getSession();
      if (session) await loadMirror(session);
    });
    els.closeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { data: { session } } = await supa.auth.getSession();
      if (!session) return;
      const res = await authFetch('/api/payroll/close', {
        method: 'POST', session,
        body: { period_start: els.closeStart.value, period_end: els.closeEnd.value },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert((data && (data.detail || data.message)) || 'Falha ao fechar folha');
        return;
      }
      alert('Folha fechada para o período.');
      await loadClosings(session);
    });
    els.btnHolidaysReload.addEventListener('click', async () => {
      const { data: { session } } = await supa.auth.getSession();
      if (session) await loadHolidays(session);
    });
    els.btnHolidaysSync.addEventListener('click', async () => {
      const { data: { session } } = await supa.auth.getSession();
      if (!session) return;
      const year = parseInt(els.holidayYear.value, 10) || new Date().getFullYear();
      els.btnHolidaysSync.disabled = true;
      try {
        const res = await authFetch('/api/holidays/sync?year=' + encodeURIComponent(String(year)), { method: 'POST', session });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert((data && (data.detail || data.message)) || 'Falha ao sincronizar');
          return;
        }
        alert('Sincronizado: +' + (data.created || 0) + ' novos, ' + (data.updated || 0) + ' atualizados.');
        await loadHolidays(session);
      } finally {
        els.btnHolidaysSync.disabled = false;
      }
    });
    els.holidayForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { data: { session } } = await supa.auth.getSession();
      if (!session) return;
      const res = await authFetch('/api/holidays', {
        method: 'POST', session,
        body: { date: els.holidayDate.value, name: els.holidayName.value.trim(), kind: 'company' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert((data && (data.detail || data.message)) || 'Falha ao adicionar');
        return;
      }
      els.holidayDate.value = '';
      els.holidayName.value = '';
      await loadHolidays(session);
    });
    els.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await signIn(els.loginEmail.value, els.loginPassword.value);
    });
    els.btnForgot.addEventListener('click', showForgot);
    els.btnForgotBack.addEventListener('click', showLogin);
    els.forgotForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await forgotPassword(els.forgotEmail.value);
    });
    els.btnLogout.addEventListener('click', signOut);
    els.companySelect.addEventListener('change', async () => {
      const v = els.companySelect.value;
      if (!v) return;
      activeCompanyId = v;
      try { localStorage.setItem('pe_active_company', v); } catch (e) { /* noop */ }
      await renderAuth();
    });
    els.btnPrintMirror.addEventListener('click', () => window.print());
    document.querySelectorAll('.btn-punch').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const t = e.currentTarget.getAttribute('data-type');
        doPunch(t);
      });
    });
  }

  function cacheEls() {
    els = {
      loginCard: $('#login-card'),
      loginForm: $('#login-form'),
      loginEmail: $('#login-email'),
      loginPassword: $('#login-password'),
      loginError: $('#login-error'),
      btnDoLogin: $('#btn-do-login'),
      btnForgot: $('#btn-forgot'),
      forgotCard: $('#forgot-card'),
      forgotForm: $('#forgot-form'),
      forgotEmail: $('#forgot-email'),
      forgotMsg: $('#forgot-msg'),
      btnForgotSend: $('#btn-forgot-send'),
      btnForgotBack: $('#btn-forgot-back'),
      btnLogout: $('#btn-logout'),
      companySelect: $('#company-select'),
      userInfo: $('#user-info'),
      userFullName: $('#user-full-name'),
      userRole: $('#user-role'),
      userCompany: $('#user-company'),
      companyBadge: $('#company-badge'),
      punchesToday: $('#punches-today'),
      punchesWeek: $('#punches-week'),
      punchesCard: $('#punches-card'),
      mapCard: $('#map-card'),
      teamCard: $('#team-card'),
      teamMembersDiv: $('#team-members'),
      teamUserSelect: $('#team-user-select'),
      teamPunchesUl: $('#team-punches'),
      btnApplyFilter: $('#btn-apply-filter'),
      inputStart: $('#filter-start'),
      inputEnd: $('#filter-end'),
      holidaysCard: $('#holidays-card'),
      holidaysList: $('#holidays-list'),
      holidayYear: $('#holiday-year'),
      btnHolidaysReload: $('#btn-holidays-reload'),
      btnHolidaysSync: $('#btn-holidays-sync'),
      holidayForm: $('#holiday-form'),
      holidayDate: $('#holiday-date'),
      holidayName: $('#holiday-name'),
      payrollCard: $('#payroll-card'),
      mirrorUserWrap: $('#mirror-user-wrap'),
      mirrorUserSelect: $('#mirror-user-select'),
      mirrorStart: $('#mirror-start'),
      mirrorEnd: $('#mirror-end'),
      mirrorExpected: $('#mirror-expected'),
      btnMirror: $('#btn-mirror'),
      btnPrintMirror: $('#btn-print-mirror'),
      mirrorTotals: $('#mirror-totals'),
      mirrorTableBody: $('#mirror-table-body'),
      closeWrap: $('#close-wrap'),
      closeForm: $('#close-form'),
      closeStart: $('#close-start'),
      closeEnd: $('#close-end'),
      closingsList: $('#closings-list'),
      // Design system (novos elementos visuais)
      loginSection: $('#login-section'),
      userAvatar: $('#user-avatar'),
      liveClock: $('#live-clock'),
      liveDate: $('#live-date'),
      dayStatus: $('#day-status'),
      dayStatusDot: $('#day-status-dot'),
      dayStatusText: $('#day-status-text'),
      dayCount: $('#day-count'),
      metricWorked: $('#metric-worked'),
      metricBalance: $('#metric-balance'),
      metricOvertime: $('#metric-overtime'),
      statTeam: $('#stat-team'),
      statHolidays: $('#stat-holidays'),
      statCompany: $('#stat-company'),
    };
  }

  window.addEventListener('load', async () => {
    cacheEls();
    try {
      initSupabase();
    } catch (e) {
      console.error(e);
      return;
    }
    wire();
    startClock();
    await renderAuth();
  });
})();
