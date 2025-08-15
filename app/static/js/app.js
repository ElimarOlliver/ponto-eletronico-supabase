(function(){
  let supa;
  const $ = (sel) => document.querySelector(sel);

  const btnLogin = $('#btn-login');
  const btnLogout = $('#btn-logout');
  const userInfo = $('#user-info');
  const userEmail = $('#user-email');
  const punchesList = $('#punches');
  const punchesCard = $('#punches-card');
  const mapCard = $('#map-card');

  // Manager UI
  const teamCard = document.querySelector('#team-card');
  const teamMembersDiv = document.querySelector('#team-members');
  const teamUserSelect = document.querySelector('#team-user-select');
  const teamPunchesUl = document.querySelector('#team-punches');
  const btnApplyFilter = document.querySelector('#btn-apply-filter');
  const inputStart = document.querySelector('#filter-start');
  const inputEnd = document.querySelector('#filter-end');

  let map, markersLayer;

  // Formatter para horário do Brasil (America/Sao_Paulo)
  const fmtBR = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'medium'
  });

  function initSupabase(){
    const url = window.__SUPABASE_URL__;
    const key = window.__SUPABASE_ANON_KEY__;
    supa = window.supabase.createClient(url, key);
  }

  async function signIn(){
    const email = prompt('Email:');
    const password = prompt('Senha:');
    if(!email || !password) return;
    const { data, error } = await supa.auth.signInWithPassword({ email, password });
    if(error){ alert(error.message); return; }
    renderAuth();
  }

  async function signOut(){
    await supa.auth.signOut();
    renderAuth();
  }

  async function renderAuth(){
    const { data: { session } } = await supa.auth.getSession();
    if(session){
      btnLogin.classList.add('hidden');
      btnLogout.classList.remove('hidden');
      userInfo.classList.remove('hidden');
      punchesCard.classList.remove('hidden');
      mapCard.classList.remove('hidden');
      userEmail.textContent = session.user.email || session.user.id;
      await refreshPunches(session);
      await refreshManager(session); // habilita área do gestor se aplicável
      initMap();
    } else {
      btnLogin.classList.remove('hidden');
      btnLogout.classList.add('hidden');
      userInfo.classList.add('hidden');
      punchesCard.classList.add('hidden');
      mapCard.classList.add('hidden');
      teamCard.classList.add('hidden');
    }
  }

  async function refreshPunches(session){
    try{
      const res = await fetch('/api/my-punches', {
        headers: { 'Authorization': 'Bearer ' + session.access_token }
      });
      const data = await res.json();
      punchesList.innerHTML = '';
      if(!Array.isArray(data)) return;

      data.forEach(p => {
        const li = document.createElement('li');
        const when = fmtBR.format(new Date(p.occurred_at));
        li.textContent = `[${p.p_type}] ${when}` + (p.latitude ? ` · (${p.latitude}, ${p.longitude})` : '');
        punchesList.appendChild(li);
      });

      if(map && data.length){
        markersLayer.clearLayers();
        data.slice(0, 10).forEach(p => {
          if(p.latitude && p.longitude){
            const marker = L.marker([p.latitude, p.longitude])
              .bindPopup(`${p.p_type} — ${fmtBR.format(new Date(p.occurred_at))}`);
            markersLayer.addLayer(marker);
          }
        });

        const first = data.find(p => p.latitude && p.longitude);
        if(first) map.setView([first.latitude, first.longitude], 13);
      }
    }catch(e){
      console.error(e);
    }
  }

  function initMap(){
    if(map) return;
    map = L.map('map').setView([-23.55, -46.63], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap'
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
  }

  async function doPunch(type){
    const { data: { session } } = await supa.auth.getSession();
    if(!session){ return alert('Faça login primeiro'); }

    const position = await new Promise(resolve => {
      try {
        navigator.geolocation.getCurrentPosition(
          pos => resolve(pos),
          _ => resolve(null),
          { enableHighAccuracy: true, timeout: 5000 }
        );
      } catch { resolve(null); }
    });
    const lat = position?.coords?.latitude;
    const lon = position?.coords?.longitude;
    const accuracy = position?.coords?.accuracy;

    const res = await fetch('/api/clock', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.access_token
      },
      body: JSON.stringify({ type, lat, lon, accuracy })
    });
    if(!res.ok){
      const err = await res.json().catch(()=>({detail:'Erro'}));
      alert(err.detail || 'Erro ao registrar ponto');
      return;
    }
    await refreshPunches(session);
  }

  async function refreshManager(session){
    try{
      const meRes = await fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + session.access_token }});
      const me = await meRes.json();
      if(!me || (me.role !== 'manager' && me.role !== 'admin')){
        teamCard.classList.add('hidden');
        return;
      }
      teamCard.classList.remove('hidden');

      const tRes = await fetch('/api/team', { headers: { 'Authorization': 'Bearer ' + session.access_token }});
      const team = await tRes.json();

      // Monta seletor + lista rápida acima
      teamUserSelect.innerHTML = '';
      teamMembersDiv.innerHTML = '';
      (team || []).forEach(member => {
        const opt = document.createElement('option');
        opt.value = member.id;
        opt.textContent = `${member.full_name || member.id} (${member.role})`;
        teamUserSelect.appendChild(opt);

        const p = document.createElement('p');
        p.textContent = `• ${member.full_name || member.id} — ${member.role}`;
        teamMembersDiv.appendChild(p);
      });

      teamUserSelect.onchange = async () => {
        await loadTeamPunches(session, teamUserSelect.value);
      };

      if(team && team.length){
        teamUserSelect.value = team[0].id;
        await loadTeamPunches(session, team[0].id);
      } else {
        teamPunchesUl.innerHTML = '<li class="text-gray-500">Nenhum colaborador encontrado.</li>';
      }

      btnApplyFilter.onclick = async () => {
        await loadTeamPunches(session, teamUserSelect.value);
      };

    }catch(e){
      console.error(e);
      teamCard.classList.add('hidden');
    }
  }

  async function loadTeamPunches(session, userId){
    teamPunchesUl.innerHTML = '<li>Carregando...</li>';
    try{
      const start = inputStart.value ? new Date(inputStart.value).toISOString() : '';
      const end   = inputEnd.value ? new Date(inputEnd.value).toISOString() : '';

      const url = new URL('/api/team-punches', window.location.origin);
      url.searchParams.set('user_id', userId);
      url.searchParams.set('limit', '50');
      if(start) url.searchParams.set('start', start);
      if(end)   url.searchParams.set('end', end);

      const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + session.access_token }});
      const data = await res.json();
      teamPunchesUl.innerHTML = '';

      if(!Array.isArray(data) || !data.length){
        teamPunchesUl.innerHTML = '<li class="text-gray-500">Sem registros.</li>';
        return;
      }

      data.forEach(p => {
        const when = fmtBR.format(new Date(p.occurred_at));
        const li = document.createElement('li');
        li.innerHTML = `
          <span class="font-medium">[${p.p_type}]</span> ${when}
          ${p.latitude ? ` · (${p.latitude}, ${p.longitude})` : ''}
          ${p.note ? ` · Nota: ${p.note}` : ''}
          · <span class="px-1 rounded border ${p.approval_status === 'approved' ? 'border-green-600' : p.approval_status === 'rejected' ? 'border-red-600' : 'border-gray-400'}">
              ${p.approval_status || 'pending'}
            </span>
          ${p.approval_status === 'pending'
            ? `<button class="ml-2 px-2 py-0.5 border rounded text-xs" data-action="approve" data-id="${p.id}">Aprovar</button>
               <button class="ml-1 px-2 py-0.5 border rounded text-xs" data-action="reject" data-id="${p.id}">Rejeitar</button>`
            : ''
          }
          <button class="ml-2 px-2 py-0.5 border rounded text-xs" data-action="edit-note" data-id="${p.id}">editar nota</button>
        `;
        teamPunchesUl.appendChild(li);
      });

      // ações
      teamPunchesUl.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const action = e.target.getAttribute('data-action');
          const id = e.target.getAttribute('data-id');

          if(action === 'edit-note'){
            const note = prompt('Nova nota (vazio apaga):', '');
            if(note === null) return;
            const body = { id, note: note === '' ? null : note };
            const up = await fetch('/api/punch-update', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
              body: JSON.stringify(body)
            });
            if(!up.ok){
              const err = await up.json().catch(()=>({detail:'Erro'}));
              alert(err.detail || 'Falha ao atualizar');
              return;
            }
          }

          if(action === 'approve' || action === 'reject'){
            const decision = action === 'approve' ? 'approved' : 'rejected';
            const up = await fetch('/api/punch-approve', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session.access_token },
              body: JSON.stringify({ id, decision })
            });
            if(!up.ok){
              const err = await up.json().catch(()=>({detail:'Erro'}));
              alert(err.detail || 'Falha ao aprovar/rejeitar');
              return;
            }
          }

          await loadTeamPunches(session, userId);
        });
      });

    }catch(e){
      console.error(e);
      teamPunchesUl.innerHTML = '<li class="text-red-600">Erro ao carregar pontos.</li>';
    }
  }

  function wire(){
    btnLogin?.addEventListener('click', signIn);
    btnLogout?.addEventListener('click', signOut);
    document.querySelectorAll('.btn-punch').forEach(btn => {
      btn.addEventListener('click', e => doPunch(e.target.getAttribute('data-type')));
    });
  }

  window.addEventListener('load', async () => {
    initSupabase();
    wire();
    renderAuth();
  });
})();
