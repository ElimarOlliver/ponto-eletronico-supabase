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

  const MANAGER_ROLES = new Set(['manager', 'company_admin', 'system_admin', 'admin']);
  const COMPANY_ADMIN_ROLES = new Set(['company_admin', 'system_admin', 'admin']);
  const VALID_PUNCH_TYPES = new Set(['in', 'out', 'break_start', 'break_end']);

  const fmtBR = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium',
  });

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
    els.forgotMsg.className = 'text-sm ' + (isError ? 'text-red-600' : 'text-gray-700');
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
        showLoginError(error.message);
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
    els.loginCard.classList.remove('hidden');
    els.forgotCard.classList.add('hidden');
    showForgotMsg('');
  }

  function showForgot() {
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
      els.companyBadge.classList.add('hidden');
      clear(els.punchesList);
      clear(els.teamPunchesUl);
      clear(els.teamMembersDiv);
      clear(els.teamUserSelect);
      showLoginError('');
      return;
    }
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
        els.companyBadge.classList.add('hidden');
        showLogin();
        showLoginError(await readError(meRes));
        return;
      }
      me = await meRes.json();
    } catch (e) {
      console.error(e);
    }
    els.userEmail.textContent = (session.user && session.user.email) || session.user.id;
    els.userRole.textContent = (me && me.role) || '—';
    els.userCompany.textContent = profileCompanyLabel(me);
    const badge = profileCompanyLabel(me);
    if (me && (me.company_nome || profileCompanyCNPJ(me))) {
      els.companyBadge.textContent = badge;
      els.companyBadge.classList.remove('hidden');
    } else {
      els.companyBadge.classList.add('hidden');
    }
    await refreshPunches(session);
    await refreshManager(session, me);
    await refreshHolidays(session, me);
    await refreshPayroll(session, me);
    initMap();
  }

  async function refreshPunches(session) {
    try {
      const res = await authFetch('/api/my-punches', { session });
      if (!res.ok) {
        console.error(await readError(res));
        return;
      }
      const data = await res.json();
      clear(els.punchesList);
      if (!Array.isArray(data) || !data.length) {
        els.punchesList.appendChild(liText('Sem registros.', 'text-gray-500'));
        return;
      }
      data.forEach((p) => {
        const when = fmtBR.format(new Date(p.occurred_at));
        let txt = '[' + String(p.p_type) + '] ' + when;
        if (p.latitude && p.longitude) txt += ' · (' + p.latitude + ', ' + p.longitude + ')';
        els.punchesList.appendChild(liText(txt));
      });

      if (map && data.length && markersLayer) {
        markersLayer.clearLayers();
        data.slice(0, 10).forEach((p) => {
          const lat = Number(p.latitude);
          const lon = Number(p.longitude);
          if (Number.isFinite(lat) && Number.isFinite(lon)) {
            const marker = window.L.marker([lat, lon])
              .bindPopup(String(p.p_type) + ' — ' + fmtBR.format(new Date(p.occurred_at)));
            markersLayer.addLayer(marker);
          }
        });
        const first = data.find((p) => Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude)));
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
        els.teamPunchesUl.appendChild(liText('Falha ao carregar equipe.', 'text-red-600'));
        return;
      }
      const team = await tRes.json();

      clear(els.teamUserSelect);
      clear(els.teamMembersDiv);
      (Array.isArray(team) ? team : []).forEach((member) => {
        const opt = document.createElement('option');
        opt.value = member.id;
        opt.textContent = (member.full_name || member.id) + ' (' + member.role + ')';
        els.teamUserSelect.appendChild(opt);

        const p = document.createElement('p');
        p.textContent = '• ' + (member.full_name || member.id) + ' — ' + member.role;
        els.teamMembersDiv.appendChild(p);
      });

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
    li.className = 'border rounded px-2 py-1';

    const head = document.createElement('div');
    const when = fmtBR.format(new Date(p.occurred_at));
    let headTxt = '[' + String(p.p_type) + '] ' + when;
    if (p.latitude && p.longitude) headTxt += ' · (' + p.latitude + ', ' + p.longitude + ')';
    if (p.note) headTxt += ' · Nota: ' + String(p.note);
    headTxt += ' · ' + (p.approval_status || 'pending');
    head.textContent = headTxt;
    li.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'mt-1 space-x-2';

    if ((p.approval_status || 'pending') === 'pending') {
      const bApprove = document.createElement('button');
      bApprove.type = 'button';
      bApprove.className = 'px-2 py-0.5 border rounded text-xs';
      bApprove.textContent = 'Aprovar';
      bApprove.addEventListener('click', async () => {
        const up = await authFetch('/api/punch-approve', {
          method: 'POST', session, body: { id: p.id, decision: 'approved' },
        });
        if (!up.ok) {
          alert(await readError(up));
          return;
        }
        await loadTeamPunches(session, userId);
      });
      const bReject = document.createElement('button');
      bReject.type = 'button';
      bReject.className = 'px-2 py-0.5 border rounded text-xs';
      bReject.textContent = 'Rejeitar';
      bReject.addEventListener('click', async () => {
        const up = await authFetch('/api/punch-approve', {
          method: 'POST', session, body: { id: p.id, decision: 'rejected' },
        });
        if (!up.ok) {
          alert(await readError(up));
          return;
        }
        await loadTeamPunches(session, userId);
      });
      actions.appendChild(bApprove);
      actions.appendChild(bReject);
    }

    const bNote = document.createElement('button');
    bNote.type = 'button';
    bNote.className = 'px-2 py-0.5 border rounded text-xs';
    bNote.textContent = 'editar nota';
    bNote.addEventListener('click', async () => {
      const note = prompt('Nova nota (vazio apaga):', '');
      if (note === null) return;
      const up = await authFetch('/api/punch-update', {
        method: 'POST', session, body: { id: p.id, note: note === '' ? null : note },
      });
      if (!up.ok) {
        alert(await readError(up));
        return;
      }
      await loadTeamPunches(session, userId);
    });
    actions.appendChild(bNote);

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
        els.teamPunchesUl.appendChild(liText((data && (data.detail || data.message)) || 'Erro ao carregar.', 'text-red-600'));
        return;
      }
      if (!Array.isArray(data) || !data.length) {
        els.teamPunchesUl.appendChild(liText('Sem registros.', 'text-gray-500'));
        return;
      }
      data.forEach((p) => {
        els.teamPunchesUl.appendChild(punchRow(p, session, userId));
      });
    } catch (e) {
      console.error(e);
      clear(els.teamPunchesUl);
      els.teamPunchesUl.appendChild(liText('Erro ao carregar pontos.', 'text-red-600'));
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
        els.holidaysList.appendChild(liText((data && (data.detail || data.message)) || 'Erro ao carregar.', 'text-red-600'));
        return;
      }
      if (!Array.isArray(data) || !data.length) {
        els.holidaysList.appendChild(liText('Sem feriados para ' + year + '. Admin: clique em Sincronizar BrasilAPI.', 'text-gray-500'));
        return;
      }
      data.forEach((h) => {
        const li = document.createElement('li');
        li.className = 'border rounded px-2 py-1 flex items-center justify-between gap-2';
        const label = document.createElement('span');
        let d = String(h.h_date || '');
        try { d = fmtDateBR.format(new Date(d + 'T12:00:00')); } catch { /* mantém */ }
        label.textContent = d + ' · ' + String(h.name) + ' [' + String(h.kind) + (h.company_id ? ', local' : ', nacional') + ']';
        li.appendChild(label);
        els.holidaysList.appendChild(li);
      });
    } catch (e) {
      console.error(e);
      clear(els.holidaysList);
      els.holidaysList.appendChild(liText('Erro ao carregar feriados.', 'text-red-600'));
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

  function mirrorCell(text) {
    const td = document.createElement('td');
    td.className = 'pr-2';
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
        let dateTxt = String(d.date || '');
        try { dateTxt = fmtDateBR.format(new Date(dateTxt + 'T12:00:00')); } catch { /* mantém */ }
        tr.appendChild(mirrorCell(dateTxt));
        tr.appendChild(mirrorCell(String(d.status || '') + (d.pending ? ' (pendente)' : '') + (d.holiday ? ' (feriado)' : '')));
        tr.appendChild(mirrorCell(fmtMin(d.expected_min)));
        tr.appendChild(mirrorCell(fmtMin(d.worked_min)));
        tr.appendChild(mirrorCell(fmtMin(d.overtime_min)));
        tr.appendChild(mirrorCell(fmtMin(d.deficit_min)));
        tr.appendChild(mirrorCell(String(d.punches || 0)));
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
        els.closingsList.appendChild(liText((data && (data.detail || data.message)) || 'Erro.', 'text-red-600'));
        return;
      }
      if (!Array.isArray(data) || !data.length) {
        els.closingsList.appendChild(liText('Nenhum fechamento.', 'text-gray-500'));
        return;
      }
      data.forEach((c) => {
        els.closingsList.appendChild(liText(
          String(c.period_start) + ' → ' + String(c.period_end) + ' · ' + String(c.status),
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
      userInfo: $('#user-info'),
      userEmail: $('#user-email'),
      userRole: $('#user-role'),
      userCompany: $('#user-company'),
      companyBadge: $('#company-badge'),
      punchesList: $('#punches'),
      punchesCard: $('#punches-card'),
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
      mirrorTotals: $('#mirror-totals'),
      mirrorTableBody: $('#mirror-table-body'),
      closeWrap: $('#close-wrap'),
      closeForm: $('#close-form'),
      closeStart: $('#close-start'),
      closeEnd: $('#close-end'),
      closingsList: $('#closings-list'),
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
    await renderAuth();
  });
})();
