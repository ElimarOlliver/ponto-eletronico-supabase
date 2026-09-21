/* Página de redefinição de senha (link do e-mail de recovery).
 * Suporta fluxo PKCE (?code=) e fluxo implícito (#access_token=...&type=recovery).
 * Render só com textContent; sem innerHTML com dados externos.
 */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let supa = null;

  function setStatus(msg, isError) {
    const el = $('#reset-status');
    el.textContent = msg;
    el.className = 'text-sm mb-3 ' + (isError ? 'text-red-600' : 'text-gray-600');
  }

  async function boot() {
    const url = window.__SUPABASE_URL__;
    const key = window.__SUPABASE_ANON_KEY__;
    if (!url || !key || String(url).includes('{{')) {
      setStatus('Configuração ausente. Contate o suporte.', true);
      return;
    }
    supa = window.supabase.createClient(url, key);

    // Fluxo PKCE: o link traz ?code= — troca por sessão de recovery.
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      const { error } = await supa.auth.exchangeCodeForSession(code);
      if (error) {
        setStatus('Link inválido ou expirado. Solicite um novo em "Esqueci minha senha".', true);
        return;
      }
      // Limpa o code da URL sem recarregar.
      window.history.replaceState({}, '', window.location.pathname);
    }

    const { data: { session } } = await supa.auth.getSession();
    if (!session) {
      setStatus('Link inválido ou expirado. Solicite um novo em "Esqueci minha senha".', true);
      return;
    }
    setStatus('Link válido. Defina sua nova senha abaixo.');
    $('#reset-form').classList.remove('hidden');
  }

  async function onSubmit(e) {
    e.preventDefault();
    const pw = $('#reset-password').value || '';
    const confirm = $('#reset-confirm').value || '';
    if (pw.length < 6) {
      setStatus('A senha deve ter ao menos 6 caracteres.', true);
      return;
    }
    if (pw !== confirm) {
      setStatus('As senhas não conferem.', true);
      return;
    }
    const { error } = await supa.auth.updateUser({ password: pw });
    if (error) {
      setStatus(error.message, true);
      return;
    }
    await supa.auth.signOut();
    setStatus('Senha alterada com sucesso. Volte ao login e entre com a nova senha.');
    $('#reset-form').classList.add('hidden');
  }

  window.addEventListener('load', () => {
    boot().catch((e) => {
      console.error(e);
      setStatus('Falha inesperada. Tente novamente.', true);
    });
    $('#reset-form').addEventListener('submit', onSubmit);
  });
})();
