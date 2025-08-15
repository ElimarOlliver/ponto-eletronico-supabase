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
      initMap();
    } else {
      btnLogin.classList.remove('hidden');
      btnLogout.classList.add('hidden');
      userInfo.classList.add('hidden');
      punchesCard.classList.add('hidden');
      mapCard.classList.add('hidden');
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
        try{
          const first = data.find(p => p.latitude && p.longitude);
          if(first) map.setView([first.latitude, first.longitude], 13);
        } catch(_){}
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

    // geolocalização (opcional)
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

  function wire(){
    btnLogin.addEventListener('click', signIn);
    btnLogout.addEventListener('click', signOut);
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
