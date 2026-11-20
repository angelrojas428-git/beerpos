import Alpine from 'alpinejs';
import QRCode from 'qrcode';
import twemoji from '@twemoji/api';
import { computeSocketUrl } from './socketUrl.js';

window.Alpine = Alpine;
window.QRCode = QRCode;

// Parse all emojis on the page into SVG images for consistent cross-browser rendering
// (Chrome/Edge on Windows render native emojis as monochrome glyphs; Twemoji renders color SVGs)
function parseEmojis(root) {
  try {
    twemoji.parse(root || document.body, {
      folder: 'svg',
      ext: '.svg',
      base: 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/',
      size: '72x72'
    });
  } catch (e) {
    // If Twemoji fails (offline), native emojis remain as fallback
    console.warn('Twemoji parse skipped:', e.message);
  }
}

// Re-parse emojis after Alpine updates the DOM
function setupEmojiObserver() {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            const hasEmoji = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(node.textContent || '');
            if (hasEmoji) parseEmojis(node);
          } else if (node.nodeType === 3) {
            const hasEmoji = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u.test(node.textContent || '');
            if (hasEmoji && node.parentElement) parseEmojis(node.parentElement);
          }
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function app() {
  return {
    loading: true,
    stock: { beer_stock: null, beer_stock_min: 0, low_stock: false },
    stockInput: null,
    stockMinInput: 0,
    cash: { open: false, shift: null, totals: null, expected_usd: 0 },
    cashOpeningFloat: 0,
    cashCounted: null,
    cashNotes: '',
    cashHistory: [],
    staffList: [],
    staffForm: { name: '', pin: '', role: 'bartender' },
    view: 'login', // 'login' | 'bartender' | 'client' | 'display'
    tab: 'fast',
    mobileMenuOpen: false,
    darkMode: false,
    installPrompt: null,
    showInstallBanner: false,
    installMenuOpen: false,
    lang: 'es',
    numericKeypad: { visible: false, target: '', value: '' },
    passkeyScanning: false,
    estId: 1,    est: null,   staffRole: null,   staffName: null,
    ticketWidth: '80', autoPrint: false, lastTicket: null,
    summary: null,
    reportDate: '',
    reportDateFrom: '',
    reportDateTo: '',
    reportClientFilter: '',
    reportStaffFilter: '',
    reportTypeFilter: '',
    reportClientsList: [],
    reportStaffList: [],
    hourly: [],
    hourlyLoading: false,
    hourlyMetric: 'beers',
    report: null,
    reportClients: [],
    reportLoading: false,
    reportError: '',
    sessionToken: null,

    // login
    establishments: [],
    loginEstId: 1,
    loginName: '',
    loginPin: '',
    loginError: '',

    // client view
    token: null,
    client: null,
    clientPasskeys: [],
    clientPasskeysLoading: false,
    clientPasskeyLoadError: false,
    clientVerificationCode: null,
    clientVerificationExpiresAt: null,
    codeSecondsLeft: 60,
    codeTickTimer: null,
    codeRenewTimer: null,
    clientsModalOpen: false,
    // credit / cuentas por cobrar
    creditClients: [],
    creditAging: [],
    creditStatement: null,
    creditTabLoading: false,
    redeemQty: 1,
    redeeming: false,
    requesting: false,
    orderStatus: null,
    orderTimeLeft: null,
    orderTimer: null,
    clientOrderPollTimer: null,
    clientSyncTimer: null,
    confirmation: null,
    confirmTime: '',
    confirmDate: '',
    confirmColorClass: '',
    confirmTimer: null,
    calcQty: 10,
    socket: null,
    socketConnected: false,
    audioContext: null,
    audioEnabled: true,
    displayError: '',
    displaySale: null,
    displayNotice: '',
    displayNow: Date.now(),
    displayClockTimer: null,
    online: navigator.onLine,
    pendingSyncCount: 0,
    syncError: '',

    // bartender
    fastQty: 3,
    fastPending: [],
    lastFastCode: null,
    lastFastQty: null,
    clients: [],
    pendingOrders: [],
    pendingOrdersPage: 1,
    pendingOrdersPageSize: 10,
    clientsPage: 1,
    clientsPageSize: 8,
    clientSearch: '',
    newClient: { full_name: '', document_id: '', phone: '' },
    lastRegistered: null,
    newRate: null,
    newPrice: null,
    newName: '',
    newOwner: '',
    newPhone: '',
    newLogoUrl: '',
    newThemeColor: '#0f172a',
    newSecondaryColor: '#f59e0b',
    qrModal: null,
    sse: null,
    sseEstablishmentId: null,
    toast: { show: false, type: 'success', title: '', message: '', showBalance: false, balance: 0 },
    logoFile: null,

    watch: {
      tab() {
        this.qrModal = null;
      }
    },

    async init() {
      const savedDark = localStorage.getItem('beerposDarkMode');
      if (savedDark !== null) {
        this.darkMode = savedDark === 'true';
      } else {
        this.darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      this.applyTheme();

      const savedTicketWidth = localStorage.getItem('beerposTicketWidth');
      if (savedTicketWidth) this.ticketWidth = savedTicketWidth;
      this.autoPrint = localStorage.getItem('beerposAutoPrint') === 'true';

      const savedLang = localStorage.getItem('beerposLang');
      if (savedLang) {
        this.setLang(savedLang);
      } else {
        this.setLang(navigator.language.startsWith('es') ? 'es' : 'en');
      }

      window.addEventListener('online', () => {
        this.online = true;
        this.retryPendingSync();
      });
      window.addEventListener('offline', () => { this.online = false; });
      window.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.view === 'client' && this.client) {
          this.pollClientOrderStatus();
        }
      });

      // PWA install prompt
      window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        this.installPrompt = event;
        this.showInstallBanner = true;
      });
      // Cerrar menú de instalación al hacer clic fuera de la burbuja
      window.addEventListener('click', (event) => {
        if (!this.installMenuOpen) return;
        const bubble = event.target.closest('[aria-label="Instalar BeerPOS"]') || event.target.closest('.fixed.bottom-5.right-5');
        if (!bubble) this.installMenuOpen = false;
      });
      navigator.serviceWorker?.addEventListener('message', (event) => {
        const { type, count, failedCount, message } = event.data || {};
        if (type === 'sync-status') {
          this.pendingSyncCount = count;
          if (failedCount) this.syncError = `${failedCount} venta(s) necesitan reintento.`;
        }
        if (type === 'sync-queued') this.pendingSyncCount = count;
        if (type === 'sync-complete') {
          this.pendingSyncCount = count;
          this.syncError = '';
          this.loadFastPending();
          this.loadSummary();
        }
        if (type === 'sync-error') {
          this.syncError = message || 'No se pudo sincronizar una venta pendiente.';
        }
      });
      navigator.serviceWorker?.addEventListener('controllerchange', () => this.refreshPendingSync());
      navigator.serviceWorker?.ready.then(() => this.refreshPendingSync()).catch((error) => {
        console.error('No se pudo consultar la cola offline:', error);
      });
      try {
        this.refreshPendingSync();
        this.reportDate = this.localDate();
        this.reportDateFrom = this.localDate();
        this.reportDateTo = this.localDate();
        const path = window.location.pathname;
        const params = new URLSearchParams(window.location.search);
        if (params.get('display') === '1') {
          this.view = 'display';
          this.sessionToken = localStorage.getItem('beerposSessionToken');
          if (!this.sessionToken) throw new Error('Inicia sesión en la pantalla de barra antes de abrir el display.');
          const session = await this.api('/auth/me');
          this.estId = session.establishment_id;
          this.est = await this.api(`/establishments/${this.estId}`);
          if (params.has('est') && Number(params.get('est')) !== Number(this.estId)) {
            throw new Error('La sesión no pertenece a este establecimiento.');
          }
          await this.loadFastPending();
          this.connectRealtimeSocket();
          this.displayClockTimer = setInterval(() => { this.displayNow = Date.now(); }, 1000);
          return;
        }
        const m = path.match(/^\/c\/([a-f0-9]+)/i);
        if (m) {
          this.view = 'client';
          this.token = m[1];
          await this.loadClient();
          this.connectClientSse();
          this.connectRealtimeSocket({ clientToken: this.token });
          this.startClientOrderPolling();
          this.startClientSyncTimer();
        } else {
          await this.loadEstablishments();
          const savedToken = localStorage.getItem('beerposSessionToken');
          if (savedToken) {
            this.sessionToken = savedToken;
            try {
              const session = await this.api('/auth/me');
              this.estId = session.establishment_id;
              this.staffRole = session.staff?.role || null;
              this.staffName = session.staff?.name || null;
              this.est = await this.api(`/establishments/${this.estId}`);
              this.view = 'bartender';
              await this.loadBartender();
              this.connectRealtimeSocket();
              this.connectBartenderSse();
              this.initAudioContext();
              return;
            } catch (e) {
              localStorage.removeItem('beerposSessionToken');
              this.sessionToken = null;
            }
          }
          this.view = 'login';
        }

        // Sincroniza al volver a la pestaña (red de seguridad para eventos perdidos)
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden && this.view === 'client' && this.client) {
            this.pollClientOrderStatus();
            this.loadClientOrders();
          }
        });
      } catch (e) {
        console.error(e);
        if (this.view === 'display') this.displayError = e.message;
        else alert('Error inicializando: ' + e.message);
      } finally {
        this.loading = false;
      }
    },
    async loadEstablishments() {
      try {
        this.establishments = await this.api('/auth');
        this.loginEstId = this.establishments[0]?.id || 1;
      } catch (e) { console.error(e); }
    },
    async doLogin() {
      this.loginError = '';
      try {
        const res = await this.api('/auth/login', {
          method: 'POST',
          body: JSON.stringify({ establishment_id: this.loginEstId, name: this.loginName, pin: this.loginPin })
        });
        this.sessionToken = res.sessionToken;
        localStorage.setItem('beerposSessionToken', this.sessionToken);
        this.estId = res.staff.establishment_id;
        this.staffRole = res.staff.role || null;
        this.staffName = res.staff.name || null;
        this.view = 'bartender';
        await this.loadBartender();
        this.connectRealtimeSocket();
        this.connectBartenderSse();
        this.initAudioContext();
      } catch (e) {
        this.loginError = e.message;
      }
    },
    loginSkip() {
      this.estId = this.loginEstId;
      this.sessionToken = null;
      localStorage.removeItem('beerposSessionToken');
      this.view = 'bartender';
      this.loadBartender();
      this.connectBartenderSse();
      this.initAudioContext();
    },
    async doLogout() {
      try {
        await this.api('/auth/logout', { method: 'POST' });
      } catch (e) { /* ignore errors */ }
      this.sessionToken = null;
      localStorage.removeItem('beerposSessionToken');
      this.socket?.disconnect();
      this.sse?.close();
      this.stopClientOrderPolling();
      this.stopClientSyncTimer();
      this.stopExpiryTimer();
      this.view = 'login';
    },

    api(path, opts = {}) {
      const isFormData = opts.body instanceof FormData;
      opts.headers = Object.assign(
        isFormData ? {} : { 'Content-Type': 'application/json' },
        this.sessionToken ? { 'x-session-token': this.sessionToken } : {},
        opts.headers || {}
      );
      return fetch('/api' + path, opts).then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const err = new Error(data.error || ('HTTP ' + r.status));
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    },

    // --- Client ---
    async loadClient() {
      this.client = await this.api(`/clients/token/${this.token}`);
      this.redeemQty = Math.min(1, this.client.current_balance || 1) || 1;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.client.theme_color || '#0f172a');
      await this.loadClientPasskeys();
      await this.loadClientOrders();
      await this.loadClientVerificationCode();
    },
    webAuthnAvailable() {
      return window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials;
    },
    decodeBase64Url(value) {
      const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
      return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
    },
    encodeBase64Url(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    },
    decodeWebAuthnOptions(options) {
      const decoded = { ...options, challenge: this.decodeBase64Url(options.challenge) };
      if (options.user) decoded.user = { ...options.user, id: this.decodeBase64Url(options.user.id) };
      for (const key of ['allowCredentials', 'excludeCredentials']) {
        if (options[key]) {
          decoded[key] = options[key].map((credential) => ({
            ...credential,
            id: this.decodeBase64Url(credential.id),
          }));
        }
      }
      return decoded;
    },
    serializeWebAuthnCredential(credential) {
      const response = credential.response;
      const serializedResponse = {
        clientDataJSON: this.encodeBase64Url(response.clientDataJSON),
      };
      if (response.attestationObject) {
        serializedResponse.attestationObject = this.encodeBase64Url(response.attestationObject);
        if (typeof response.getTransports === 'function') {
          serializedResponse.transports = response.getTransports();
        }
      } else {
        serializedResponse.authenticatorData = this.encodeBase64Url(response.authenticatorData);
        serializedResponse.signature = this.encodeBase64Url(response.signature);
        if (response.userHandle) serializedResponse.userHandle = this.encodeBase64Url(response.userHandle);
      }
      return {
        id: credential.id,
        rawId: this.encodeBase64Url(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: credential.getClientExtensionResults(),
        response: serializedResponse,
      };
    },
    async loadClientPasskeys() {
      if (!this.token) return;
      this.clientPasskeysLoading = true;
      this.clientPasskeyLoadError = false;
      try {
        this.clientPasskeys = await this.api('/client-passkeys', {
          headers: { 'x-client-token': this.token },
        });
      } catch (e) {
        console.warn('No se pudieron cargar las passkeys:', e.message);
        this.clientPasskeys = [];
        this.clientPasskeyLoadError = true;
      } finally {
        this.clientPasskeysLoading = false;
      }
    },
    async authenticateClientPasskey(purpose = 'withdrawal', quantity = null) {
      if (!this.webAuthnAvailable()) {
        throw new Error('Este navegador no admite passkeys seguras.');
      }
      const request = { purpose };
      if (purpose === 'withdrawal') request.quantity = quantity;
      const options = await this.api('/client-passkeys/authentication/options', {
        method: 'POST',
        headers: { 'x-client-token': this.token },
        body: JSON.stringify(request),
      });
      const credential = await navigator.credentials.get({
        publicKey: this.decodeWebAuthnOptions(options),
      });
      if (!credential) throw new Error('No se completó la autenticación con passkey.');
      const result = await this.api('/client-passkeys/authentication/verify', {
        method: 'POST',
        headers: { 'x-client-token': this.token },
        body: JSON.stringify({
          challenge: options.challenge,
          purpose,
          response: this.serializeWebAuthnCredential(credential),
        }),
      });
      return result.authorization;
    },
    async registerClientPasskey() {
      if (!this.webAuthnAvailable()) {
        this.showToast('error', 'Passkeys no disponibles', 'Abre este enlace en un navegador compatible y mediante HTTPS.');
        return;
      }
      try {
        this.clientPasskeyLoadError = false;
        const headers = { 'x-client-token': this.token };
        if (this.clientPasskeys.length) {
          headers['x-client-passkey-auth'] = await this.authenticateClientPasskey('manage');
        }
        const options = await this.api('/client-passkeys/registration/options', {
          method: 'POST',
          headers,
        });
        const credential = await navigator.credentials.create({
          publicKey: this.decodeWebAuthnOptions(options),
        });
        if (!credential) throw new Error('No se completó el registro de la passkey.');
        await this.api('/client-passkeys/registration/verify', {
          method: 'POST',
          headers: { 'x-client-token': this.token },
          body: JSON.stringify({
            challenge: options.challenge,
            response: this.serializeWebAuthnCredential(credential),
          }),
        });
        await this.loadClientPasskeys();
        if (this.clientPasskeyLoadError) throw new Error('La passkey se registró, pero no se pudo actualizar la lista.');
        this.showToast('success', 'Passkey activada', 'Tu autenticador seguro quedó vinculado a esta cuenta.');
      } catch (e) {
        this.showToast('error', 'No se pudo activar la passkey', e.message || 'Inténtalo nuevamente.');
      }
    },
    async removeClientPasskey(passkey) {
      try {
        const authorization = await this.authenticateClientPasskey('manage');
        await this.api(`/client-passkeys/${passkey.id}`, {
          method: 'DELETE',
          headers: {
            'x-client-token': this.token,
            'x-client-passkey-auth': authorization,
          },
        });
        await this.loadClientPasskeys();
        if (this.clientPasskeyLoadError) throw new Error('La passkey se eliminó, pero no se pudo actualizar la lista.');
        this.showToast('success', 'Passkey eliminada', 'El autenticador se desvinculó de esta cuenta.');
      } catch (e) {
        this.showToast('error', 'No se pudo eliminar la passkey', e.message || 'Inténtalo nuevamente.');
      }
    },
    async loadClientOrders() {
      if (!this.client) return;
      try {
        // Solo traer órdenes activas: SOLICITADO o EN_PREPARACION
        const orders = await this.api(`/client-orders?establishment_id=${this.client.establishment_id}&status=SOLICITADO,EN_PREPARACION&limit=5`);
        const myOrder = orders.find(o => o.client_id === this.client.id);
        this.orderStatus = myOrder || null;
        if (myOrder && myOrder.status === 'SOLICITADO') this.startExpiryTimer(myOrder.expires_at);
      } catch (e) { console.warn(e); }
    },
    async loadClientVerificationCode() {
      if (!this.token) return;
      try {
        // Verificar si ya hay un código válido en localStorage (misma sesión/cliente)
        const cached = localStorage.getItem(`beerpos_verification_code_${this.token}`);
        if (cached) {
          const { code, expires_at } = JSON.parse(cached);
          const now = Date.now();
          if (new Date(expires_at).getTime() > now) {
            this.clientVerificationCode = code;
            this.clientVerificationExpiresAt = expires_at;
            this.startClientVerificationTimer();
            return;
          }
        }

        const res = await this.api(`/clients/token/${this.token}/verification-code`);
        this.clientVerificationCode = res.code;
        this.clientVerificationExpiresAt = res.expires_at;
        // Cachear para consistencia entre pestañas del mismo cliente
        localStorage.setItem(`beerpos_verification_code_${this.token}`, JSON.stringify({
          code: res.code,
          expires_at: res.expires_at
        }));
        this.startClientVerificationTimer();
      } catch (e) { console.warn('No se pudo cargar código de verificación:', e.message); }
    },
    startClientVerificationTimer() {
      this.stopClientVerificationTimer();
      // Calcular segundos restantes basado en el expires_at real del backend
      const updateSeconds = async () => {
        if (!this.clientVerificationExpiresAt) return;
        const remaining = Math.max(0, Math.ceil((new Date(this.clientVerificationExpiresAt).getTime() - Date.now()) / 1000));
        this.codeSecondsLeft = remaining;
        // Si llegó a 0, renovar código inmediatamente
        if (remaining <= 0) {
          try {
            const res = await this.api(`/clients/token/${this.token}/verification-code`);
            this.clientVerificationCode = res.code;
            this.clientVerificationExpiresAt = res.expires_at;
            localStorage.setItem(`beerpos_verification_code_${this.token}`, JSON.stringify({
              code: res.code,
              expires_at: res.expires_at
            }));
            this.codeSecondsLeft = 60;
            this.showToast('info', 'Código renovado', 'Se generó un nuevo código automáticamente.');
          } catch (e) { console.warn('No se pudo renovar código al llegar a 0:', e.message); }
        }
      };
      updateSeconds();
      // Tick visual cada segundo
      this.codeTickTimer = setInterval(updateSeconds, 1000);
      // Renovar código automáticamente cada 55 segundos (antes de que expire)
      this.codeRenewTimer = setInterval(async () => {
        try {
          const res = await this.api(`/clients/token/${this.token}/verification-code`);
          this.clientVerificationCode = res.code;
          this.clientVerificationExpiresAt = res.expires_at;
          localStorage.setItem(`beerpos_verification_code_${this.token}`, JSON.stringify({
            code: res.code,
            expires_at: res.expires_at
          }));
          this.codeSecondsLeft = 60;
        } catch (e) { console.warn('No se pudo renovar código automático:', e.message); }
      }, 55000);
    },
    stopClientVerificationTimer() {
      if (this.codeTickTimer) {
        clearInterval(this.codeTickTimer);
        this.codeTickTimer = null;
      }
      if (this.codeRenewTimer) {
        clearInterval(this.codeRenewTimer);
        this.codeRenewTimer = null;
      }
    },
    async refreshVerificationCode() {
      if (!this.token) return;
      try {
        // Forzar nueva generación eliminando cache local
        localStorage.removeItem(`beerpos_verification_code_${this.token}`);
        const res = await this.api(`/clients/token/${this.token}/verification-code`);
        this.clientVerificationCode = res.code;
        this.clientVerificationExpiresAt = res.expires_at;
        localStorage.setItem(`beerpos_verification_code_${this.token}`, JSON.stringify({
          code: res.code,
          expires_at: res.expires_at
        }));
        this.showToast('info', 'Código renovado', 'Nuevo código generado. Válido por 60 segundos.');
      } catch (e) { this.showToast('error', 'Error', 'No se pudo renovar el código.'); }
    },
    async requestWithdrawal() {
      if (!this.client || this.client.current_balance < this.redeemQty) return;
      this.requesting = true;
      try {
        if (this.clientPasskeyLoadError) {
          throw new Error('No se pudo comprobar la configuración de passkeys. Actualiza la página e inténtalo de nuevo.');
        }
        const requestedQty = this.redeemQty;
        const headers = { 'x-client-token': this.token };
        if (this.clientPasskeys.length) {
          headers['x-client-passkey-auth'] = await this.authenticateClientPasskey('withdrawal', requestedQty);
        }
        const res = await this.api('/client-orders', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            establishment_id: this.client.establishment_id,
            client_id: this.client.id,
            quantity: requestedQty
          })
        });
        this.orderStatus = { ...res, status: 'SOLICITADO' };
        this.startExpiryTimer(res.expires_at);
        this.redeemQty = Math.max(1, Math.min(1, this.client.current_balance));
        this.showToast('success', 'Pedido enviado', `Solicitaste ${requestedQty} cerveza(s). Saldo actual: ${this.client.current_balance}. El bartender te notificará cuando esté listo.`, true, this.client.current_balance);
        this.clientAlert();
      } catch (e) { this.showToast('error', 'Error', e.message); } finally {
        this.requesting = false;
      }
    },
    showConfirmation(res) {
      const colors = [
        'bg-emerald-600/95', 'bg-sky-600/95', 'bg-fuchsia-600/95',
        'bg-amber-600/95', 'bg-rose-600/95', 'bg-teal-600/95', 'bg-indigo-600/95'
      ];
      const day = new Date().getDay();
      this.confirmColorClass = colors[day % colors.length];
      this.confirmation = res;
      const tick = () => {
        const d = new Date();
        this.confirmTime = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        this.confirmDate = d.toLocaleDateString('es-VE', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
      };
      tick();
      if (this.confirmTimer) clearInterval(this.confirmTimer);
      this.confirmTimer = setInterval(tick, 1000);
    },
    calcUsd() {
      const p = Number(this.client?.beer_price_usd || 0);
      return (p * (this.calcQty || 0)).toFixed(2);
    },
    calcVes() {
      const rate = Number(this.client?.exchange_rate?.usd_to_ves || 0);
      return (Number(this.calcUsd()) * rate).toFixed(2);
    },

    // --- Bartender ---
    async loadBartender() {
      this.est = await this.api(`/establishments/${this.estId}`);
      this.newPrice = Number(this.est.beer_price_usd);
      this.newName = this.est.name || '';
      this.newOwner = this.est.owner_name || '';
      this.newPhone = this.est.phone || '';
      this.newLogoUrl = this.est.logo_url || '';
      this.newThemeColor = this.est.theme_color || '#0f172a';
      this.newSecondaryColor = this.est.secondary_color || '#f59e0b';
      this.stockInput = this.est.beer_stock === undefined ? null : this.est.beer_stock;
      this.stockMinInput = Number(this.est.beer_stock_min || 0);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.newThemeColor);
      this.newRate = this.est.exchange_rate?.usd_to_ves
        ? Number(this.est.exchange_rate.usd_to_ves)
        : null;
      await Promise.all([
        this.loadSummary(),
        this.loadFastPending(),
        this.loadClients(),
        this.loadReport(),
        this.loadPendingOrders()
      ]);
      this.autoUpdateBcvRate();
      this.displayClockTimer = setInterval(() => { this.displayNow = Date.now(); }, 1000);
    },
    async connectBartenderSse() {
      this.sseEstablishmentId = this.estId;
      if (!window.EventSource) return;
      this.sse = new EventSource(`/api/events/${this.estId}?session=${encodeURIComponent(this.sessionToken)}`);
      this.sse.addEventListener('hello', (e) => console.log('SSE hello', e.data));
      this.sse.addEventListener('client_balance', (e) => {
        const data = JSON.parse(e.data);
        this.clients = this.clients.map(c => c.id === data.client.id ? data.client : c);
        this.lastRegistered = data.client;
        this.loadSummary();
      });
      this.sse.addEventListener('client_redeem', (e) => {
        const data = JSON.parse(e.data);
        this.clients = this.clients.map(c => c.id === data.client_id ? { ...c, current_balance: data.current_balance } : c);
        this.loadSummary();
      });
      this.sse.addEventListener('client_order', (e) => {
        const data = JSON.parse(e.data);
        this.loadPendingOrders();
        this.showToast('info', 'Nuevo pedido', `Cliente ${data.client_name} solicita ${data.quantity} cerveza(s).`);
        this.clientAlert();
      });
      this.sse.addEventListener('client_order_accepted', (e) => {
        this.loadPendingOrders();
      });
      this.sse.addEventListener('client_order_delivered', (e) => {
        this.loadPendingOrders();
      });
      this.sse.addEventListener('client_order_cancelled', (e) => {
        this.loadPendingOrders();
        this.loadClients();
      });
      this.sse.addEventListener('client_order_expired', (e) => {
        this.loadPendingOrders();
      });
      this.sse.addEventListener('fast_sale', (e) => {
        const data = JSON.parse(e.data);
        this.lastFastCode = data.redemption.code;
        this.lastFastQty = data.redemption.quantity;
        this.notifyRealtimeEvent(data);
        this.loadFastPending();
        this.loadSummary();
      });
      this.sse.addEventListener('fast_dispatch', (e) => {
        this.notifyRealtimeEvent(JSON.parse(e.data));
        this.loadFastPending();
        this.loadSummary();
      });
      this.sse.addEventListener('fast_expired', (e) => {
        this.notifyRealtimeEvent(JSON.parse(e.data));
        this.loadFastPending();
        this.loadSummary();
      });
      this.sse.addEventListener('credit_updated', (e) => {
        const data = JSON.parse(e.data);
        this.clients = this.clients.map(c => c.id === data.client_id
          ? { ...c, 
              credit_balance_usd: data.credit_balance_usd ?? data.balance_after_usd,
              credit_limit_usd: data.credit_limit_usd ?? c.credit_limit_usd
            }
          : c);
        if (this.creditClients.length) this.loadCredit();
      });
      this.sse.addEventListener('ping', () => {});
      this.sseReconnectAttempts = 0;
      this.sse.onerror = () => {
        this.sse.close();
        this.sseReconnectAttempts++;
        if (this.sseReconnectAttempts <= 5) {
          const delay = Math.min(1000 * 2 ** this.sseReconnectAttempts, 30000);
          setTimeout(() => {
            if (this.view === 'bartender') this.connectBartenderSse();
            if (this.view === 'client') this.connectClientSse();
          }, delay);
        }
      };
    },
    connectRealtimeSocket(auth) {
      if (!window.io) return;
      const authPayload = auth || { sessionToken: this.sessionToken };
      const socketUrl = computeSocketUrl(window.location);
      this.socket = window.io(socketUrl, { auth: authPayload, transports: ['websocket', 'polling'] });
      this.socket.on('connect', () => {
        this.socketConnected = true;
        this.displayError = '';
        if (this.view === 'display') this.loadFastPending();
      });
      this.socket.on('disconnect', () => { this.socketConnected = false; });
      this.socket.on('connect_error', (error) => {
        this.socketConnected = false;
        if (this.view === 'display') this.displayError = error.message || 'No se pudo conectar al servidor.';
      });
      this.socket.on('fast_sale', (data) => {
        this.lastFastCode = data.redemption.code;
        this.lastFastQty = data.redemption.quantity;
        this.displaySale = data.redemption;
        this.displayNotice = `Nueva venta rápida · Código ${data.redemption.code}`;
        this.notifyRealtimeEvent(data);
        this.loadFastPending();
        if (this.view === 'bartender') this.loadSummary();
      });
      this.socket.on('fast_dispatch', (data) => {
        this.displaySale = data.redemption;
        this.displayNotice = `Código ${data.redemption.code} despachado`;
        this.notifyRealtimeEvent(data);
        this.loadFastPending();
        if (this.view === 'bartender') this.loadSummary();
      });
      this.socket.on('fast_expired', (data) => {
        this.displaySale = data;
        this.displayNotice = `Código ${data.code} expirado`;
        this.notifyRealtimeEvent(data);
        this.loadFastPending();
      });
      this.socket.on('credit_updated', (data) => {
        if (this.view !== 'bartender') return;
        this.clients = this.clients.map(c => c.id === data.client_id
          ? { ...c, 
              credit_balance_usd: data.credit_balance_usd ?? data.balance_after_usd,
              credit_limit_usd: data.credit_limit_usd ?? c.credit_limit_usd
            }
          : c);
        if (this.creditClients.length) this.loadCredit();
      });
      this.socket.on('client_redeem', (data) => {
        this.displaySale = data;
        this.displayNotice = `Despacho de ${data.redeemed} cerveza(s)`;
        this.notifyRealtimeEvent(data);
        if (this.view === 'bartender') {
          this.clients = this.clients.map(c => c.id === data.client_id
            ? { ...c, current_balance: data.current_balance }
            : c);
          this.loadSummary();
        }
      });
      this.socket.on('client_order', (data) => {
        if (this.view === 'bartender') {
          this.loadPendingOrders();
          this.showToast('info', 'Nuevo pedido', `Cliente ${data.client_name} solicita ${data.quantity} cerveza(s).`);
          this.notifyRealtimeEvent(data);
        }
        if (this.view === 'client' && this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'SOLICITADO' };
          this.showToast('info', 'Pedido recibido', `Solicitaste ${data.quantity} cerveza(s). Saldo: ${this.client.current_balance}`, true, this.client.current_balance);
          this.startExpiryTimer(data.expires_at);
        }
      });
      this.socket.on('client_order_accepted', (data) => {
        if (this.view === 'bartender') {
          this.loadPendingOrders();
        }
        if (this.view === 'client' && this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'EN_PREPARACION' };
          if (data.new_balance != null) {
            this.client.current_balance = Number(data.new_balance);
          }
          this.showToast('info', 'Pedido en preparación', `El bartender está preparando tu retiro. Saldo: ${this.client.current_balance}`, true, this.client.current_balance);
          this.notifyRealtimeEvent(data);
        }
      });
      this.socket.on('client_order_delivered', (data) => {
        if (this.view === 'bartender') {
          this.loadPendingOrders();
        }
        if (this.view === 'client' && this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'ENTREGADO' };
          this.notifyRealtimeEvent(data);
          this.stopExpiryTimer();
          this.stopClientOrderPolling();
          this.stopClientSyncTimer();
          this.loadClient().then(() => {
            this.showToast('success', 'Pedido entregado', `¡Tu retiro fue entregado! Acércate al bartender. Saldo: ${this.client.current_balance}`, true, this.client.current_balance);
          });
        }
      });
      this.socket.on('client_order_cancelled', (data) => {
        if (this.view === 'bartender') {
          this.loadPendingOrders();
          this.loadClients();
        }
        if (this.view === 'client' && this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'CANCELADO' };
          this.notifyRealtimeEvent(data);
          this.stopExpiryTimer();
          this.stopClientOrderPolling();
          this.stopClientSyncTimer();
          this.loadClient().then(() => {
            this.showToast('error', 'Pedido cancelado', 'El bartender canceló tu solicitud. Tu saldo no fue afectado.', true, this.client.current_balance);
          });
        }
      });
      this.socket.on('client_order_expired', (data) => {
        if (this.view === 'bartender') {
          this.loadPendingOrders();
        }
        if (this.view === 'client' && this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'EXPIRADO' };
          this.notifyRealtimeEvent(data);
          this.stopExpiryTimer();
          this.stopClientOrderPolling();
          this.stopClientSyncTimer();
          this.loadClient().then(() => {
            this.showToast('error', 'Pedido expirado', 'Tu solicitud expiró por inactividad. Tu saldo fue liberado.', true, this.client.current_balance);
          });
        }
      });
    },
    notifyRealtimeEvent() {
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      if (!this.audioEnabled || !this.audioContext) return;
      const oscillator = this.audioContext.createOscillator();
      const gain = this.audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.18, this.audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioContext.currentTime + 0.25);
      oscillator.connect(gain);
      gain.connect(this.audioContext.destination);
      oscillator.start();
      oscillator.stop(this.audioContext.currentTime + 0.25);
    },
    initAudioContext() {
      if (this.audioContext) return;
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          this.audioContext = new AudioContext();
          if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
          }
        }
      } catch (e) { console.warn('No se pudo inicializar el contexto de audio:', e); }
    },
    async enableSound() {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return alert('Este navegador no admite alertas de sonido.');
      if (this.audioEnabled) {
        try {
          await this.audioContext?.suspend();
        } catch (e) { console.warn(e); }
        this.audioEnabled = false;
        return;
      }
      try {
        this.audioContext = this.audioContext || new AudioContext();
        await this.audioContext.resume();
        this.audioEnabled = true;
      } catch (e) {
        alert('No se pudieron activar las alertas de sonido: ' + e.message);
      }
    },
    openDisplay() {
      window.open(`/?display=1&est=${encodeURIComponent(this.estId)}`, '_blank');
    },
    timeRemaining(expiresAt) {
      if (!expiresAt) return '';
      const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - this.displayNow) / 1000));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    },
    connectClientSse() {
      if (!window.EventSource || !this.client) return;
      const estId = this.client.establishment_id || 0;
      const sse = new EventSource(`/api/events/${estId}?token=${this.token}`);
      this.sse = sse;
      this.sseReconnectAttempts = 0;
      sse.addEventListener('client_redeem', (e) => {
        const data = JSON.parse(e.data);
        if (this.client) {
          this.client.current_balance = data.current_balance;
          this.clientAlert();
        }
      });
      sse.addEventListener('client_balance', (e) => {
        const data = JSON.parse(e.data);
        if (this.client && data.client.id === this.client.id) {
          this.client.current_balance = data.client.current_balance;
          this.clientAlert();
        }
      });
      sse.addEventListener('client_order', (e) => {
        const data = JSON.parse(e.data);
        if (this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'SOLICITADO' };
          this.startExpiryTimer(data.expires_at);
          this.showToast('info', 'Pedido recibido', `Solicitaste ${data.quantity} cerveza(s). Saldo: ${this.client.current_balance}`, true, this.client.current_balance);
        }
      });
      sse.addEventListener('client_order_accepted', (e) => {
        const data = JSON.parse(e.data);
        if (this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'EN_PREPARACION' };
          if (data.new_balance != null) {
            this.client.current_balance = Number(data.new_balance);
          }
          // Recargar cliente desde backend para asegurar balance actualizado
          this.loadClient();
          this.showToast('info', 'Pedido en preparación', `El bartender está preparando tu retiro. Saldo: ${this.client.current_balance}`, true, this.client.current_balance);
          this.clientAlert();
        }
      });
      sse.addEventListener('client_order_delivered', (e) => {
        const data = JSON.parse(e.data);
        // Actualizar lista de clientes con nuevo balance después de entregar
        if (data.new_balance != null) {
          this.clients = this.clients.map(c => c.id === data.client_id ? { ...c, current_balance: data.new_balance } : c);
        }
        if (this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'ENTREGADO' };
          this.clientAlert();
          this.stopExpiryTimer();
          this.stopClientOrderPolling();
          this.stopClientSyncTimer();
          this.loadClient().then(() => {
            this.showToast('success', 'Pedido entregado', `¡Tu retiro fue entregado! Acércate al bartender. Saldo: ${this.client.current_balance}`, true, this.client.current_balance);
          });
        }
      });
      sse.addEventListener('client_order_cancelled', (e) => {
        const data = JSON.parse(e.data);
        if (this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'CANCELADO' };
          this.clientAlert();
          this.stopExpiryTimer();
          this.stopClientOrderPolling();
          this.stopClientSyncTimer();
          this.loadClient().then(() => {
            this.showToast('error', 'Pedido cancelado', 'El bartender canceló tu solicitud. Tu saldo no fue afectado.', true, this.client.current_balance);
          });
        }
      });
      sse.addEventListener('client_order_expired', (e) => {
        const data = JSON.parse(e.data);
        if (this.client && data.client_id === this.client.id) {
          this.orderStatus = { ...data, status: 'EXPIRADO' };
          this.clientAlert();
          this.stopExpiryTimer();
          this.stopClientOrderPolling();
          this.stopClientSyncTimer();
          this.loadClient().then(() => {
            this.showToast('error', 'Pedido expirado', 'Tu solicitud expiró por inactividad. Tu saldo fue liberado.', true, this.client.current_balance);
          });
        }
      });
      sse.addEventListener('credit_updated', (e) => {
        const data = JSON.parse(e.data);
        if (this.client && data.client_id === this.client.id) {
          this.client.credit_balance_usd = data.credit_balance_usd ?? data.balance_after_usd;
          this.client.credit_limit_usd = data.credit_limit_usd ?? this.client.credit_limit_usd;
          this.loadClient();
        }
      });
      sse.addEventListener('ping', () => {});
      sse.onerror = () => {
        sse.close();
        this.sseReconnectAttempts++;
        if (this.sseReconnectAttempts <= 5 && this.sse === sse) {
          const delay = Math.min(1000 * 2 ** this.sseReconnectAttempts, 30000);
          setTimeout(() => {
            if (this.view === 'client') this.connectClientSse();
          }, delay);
        }
      };
    },
    async loadSummary() {
      try { this.summary = await this.api(`/transactions/summary/${this.estId}`); } catch(e){}
      await this.loadStock();
    },
    async loadStock() {
      try {
        const data = await this.api(`/inventory/${this.estId}`);
        this.stock = data;
      } catch (e) { /* stock no disponible */ }
    },
    async saveStock() {
      try {
        const data = await this.api(`/inventory/${this.estId}`, {
          method: 'PUT',
          body: JSON.stringify({ beer_stock: this.stockInput, beer_stock_min: this.stockMinInput })
        });
        this.stock = data;
        this.stockInput = data.beer_stock;
        this.stockMinInput = data.beer_stock_min;
        this.showToast('success', 'Stock actualizado', `Quedan ${data.beer_stock ?? '∞'} cerveza(s).`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async disableStock() {
      try {
        const data = await this.api(`/inventory/${this.estId}`, {
          method: 'PUT',
          body: JSON.stringify({ beer_stock: null })
        });
        this.stock = data;
        this.stockInput = null;
        this.stockMinInput = data.beer_stock_min;
        this.showToast('success', 'Stock desactivado', 'Ya no se controla el inventario.');
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async adjustStock(delta) {
      try {
        const data = await this.api(`/inventory/${this.estId}/adjust`, {
          method: 'POST',
          body: JSON.stringify({ delta })
        });
        this.stock = data;
        this.stockInput = data.beer_stock;
        this.showToast('success', 'Stock ajustado', `Quedan ${data.beer_stock} cerveza(s).`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async loadCash() {
      this.cashLoading = true;
      try {
        this.cash = await this.api('/cash/current');
      } catch (e) { console.error(e); }
      finally { this.cashLoading = false; }
    },
    async openCash() {
      try {
        this.cash = await this.api('/cash/open', {
          method: 'POST',
          body: JSON.stringify({ opening_float_usd: this.cashOpeningFloat })
        });
        this.showToast('success', 'Caja abierta', `Fondo inicial: $${Number(this.cashOpeningFloat).toFixed(2)}`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async closeCash() {
      if (this.cashCounted === null || this.cashCounted === '') {
        return this.showToast('error', 'Error', 'Ingresa el efectivo contado.');
      }
      try {
        const res = await this.api('/cash/close', {
          method: 'POST',
          body: JSON.stringify({ counted_usd: this.cashCounted, notes: this.cashNotes })
        });
        const d = Number(res.shift.difference_usd);
        this.showToast('success', 'Caja cerrada', d === 0 ? 'Caja cuadrada.' : `Diferencia: $${d.toFixed(2)}`);
        this.cashCounted = null;
        this.cashNotes = '';
        await this.loadCash();
        await this.loadCashHistory();
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async loadCashHistory() {
      try { this.cashHistory = await this.api('/cash/history?limit=20'); } catch (e) { console.error(e); }
    },
    async loadStaff() {
      try { this.staffList = await this.api('/staff'); } catch (e) { console.error(e); }
    },
    async createStaff() {
      if (!this.staffForm.name || !this.staffForm.pin) {
        return this.showToast('error', 'Error', 'Nombre y PIN son obligatorios.');
      }
      try {
        await this.api('/staff', { method: 'POST', body: JSON.stringify(this.staffForm) });
        this.staffForm = { name: '', pin: '', role: 'bartender' };
        await this.loadStaff();
        this.showToast('success', 'Usuario creado', 'Ya puede iniciar sesión.');
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async resetStaffPin(s) {
      const pin = window.prompt(`Nuevo PIN para ${s.name} (6-12 dígitos):`);
      if (!pin) return;
      try {
        await this.api('/auth/change-pin', {
          method: 'POST',
          body: JSON.stringify({ staff_id: s.id, new_pin: pin })
        });
        this.showToast('success', 'PIN actualizado', `PIN de ${s.name} cambiado.`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async toggleStaff(s) {
      const activating = !s.active;
      try {
        await this.api(`/staff/${s.id}`, { method: 'PATCH', body: JSON.stringify({ active: activating }) });
        await this.loadStaff();
        this.showToast('success', 'Usuario actualizado', `${s.name}: ${activating ? 'activado' : 'desactivado'}.`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async loadReport() {
      if (!this.estId) return;
      const from = this.reportDateFrom || this.reportDate;
      const to = this.reportDateTo || this.reportDate;
      if (!from) return;
      this.reportLoading = true;
      this.reportError = '';
      this.report = null;
      this.reportClients = [];
      try {
        const params = new URLSearchParams();
        if (from && to && from === to) {
          params.set('date', from);
        } else {
          if (from) params.set('date_from', from);
          if (to) params.set('date_to', to);
        }
        if (this.reportClientFilter) params.set('client_id', this.reportClientFilter);
        if (this.reportStaffFilter) params.set('staff_id', this.reportStaffFilter);
        if (this.reportTypeFilter) params.set('type', this.reportTypeFilter);
        this.report = await this.api(`/transactions/report/${this.estId}?${params}`);
        await this.loadReportClients(from, to);
        await this.loadReportFilterLists();
        await this.loadHourly(from, to);
      } catch (e) {
        this.reportError = e.message;
      } finally {
        this.reportLoading = false;
      }
    },
    async loadHourly(from, to) {
      if (!this.estId) return;
      this.hourlyLoading = true;
      try {
        const params = new URLSearchParams();
        if (from && to && from === to) {
          params.set('date', from);
        } else {
          if (from) params.set('date_from', from);
          if (to) params.set('date_to', to);
        }
        const res = await this.api(`/transactions/hourly/${this.estId}?${params}`);
        this.hourly = res.buckets || [];
      } catch (e) { console.warn('Hourly report error', e); this.hourly = []; }
      finally { this.hourlyLoading = false; }
    },
    async loadReportClients(from, to) {
      if (!this.estId) return;
      try {
        const params = new URLSearchParams();
        if (from) params.set('date_from', from);
        if (to) params.set('date_to', to);
        this.reportClients = await this.api(`/transactions/clients/${this.estId}?${params}`);
      } catch (e) { console.warn('Client report error', e); }
    },
    async loadReportFilterLists() {
      if (!this.estId) return;
      try {
        // Load clients for filter dropdown
        const clients = await this.api(`/clients?establishment_id=${this.estId}`);
        this.reportClientsList = clients || [];
        // Load staff for filter dropdown
        const staff = await this.api(`/auth/staff?establishment_id=${this.estId}`);
        this.reportStaffList = staff || [];
      } catch (e) { console.warn('Load filter lists error', e); }
    },
    async exportCsv() {
      if (!this.estId) return;
      const from = this.reportDateFrom || this.reportDate;
      const to = this.reportDateTo || this.reportDate;
      if (!from) return;
      const params = new URLSearchParams();
      if (from && to && from === to) {
        params.set('date', from);
      } else {
        if (from) params.set('date_from', from);
        if (to) params.set('date_to', to);
      }
      if (this.reportClientFilter) params.set('client_id', this.reportClientFilter);
      if (this.reportStaffFilter) params.set('staff_id', this.reportStaffFilter);
      if (this.reportTypeFilter) params.set('type', this.reportTypeFilter);
      await this.downloadExport('csv', params);
    },
    async exportExcel() {
      if (!this.estId) return;
      const from = this.reportDateFrom || this.reportDate;
      const to = this.reportDateTo || this.reportDate;
      if (!from) return;
      const params = new URLSearchParams();
      if (from && to && from === to) {
        params.set('date', from);
      } else {
        if (from) params.set('date_from', from);
        if (to) params.set('date_to', to);
      }
      if (this.reportClientFilter) params.set('client_id', this.reportClientFilter);
      if (this.reportStaffFilter) params.set('staff_id', this.reportStaffFilter);
      if (this.reportTypeFilter) params.set('type', this.reportTypeFilter);
      await this.downloadExport('excel', params);
    },
    async exportPdf() {
      if (!this.estId) return;
      const from = this.reportDateFrom || this.reportDate;
      const to = this.reportDateTo || this.reportDate;
      if (!from) return;
      const params = new URLSearchParams();
      if (from && to && from === to) {
        params.set('date', from);
      } else {
        if (from) params.set('date_from', from);
        if (to) params.set('date_to', to);
      }
      if (this.reportClientFilter) params.set('client_id', this.reportClientFilter);
      if (this.reportStaffFilter) params.set('staff_id', this.reportStaffFilter);
      if (this.reportTypeFilter) params.set('type', this.reportTypeFilter);
      await this.downloadExport('pdf', params);
    },
    async downloadExport(format, params) {
      if (!this.sessionToken) {
        this.showToast('error', 'Error', 'Inicia sesión para exportar reportes.');
        return;
      }
      const url = `/api/transactions/export/${format}/${this.estId}?${params}`;
      try {
        const resp = await fetch(url, {
          headers: { 'x-session-token': this.sessionToken }
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${resp.status}`);
        }
        const blob = await resp.blob();
        const disposition = resp.headers.get('Content-Disposition') || '';
        const filenameMatch = disposition.match(/filename="([^"]+)"/);
        const filename = filenameMatch ? filenameMatch[1] : `reporte.${format}`;
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        this.showToast('success', 'Reporte descargado', `Archivo ${filename} generado correctamente.`);
      } catch (e) {
        this.showToast('error', 'Error al exportar', e.message);
      }
    },
    localDate() {
      const date = new Date();
      const offset = date.getTimezoneOffset() * 60000;
      return new Date(date.getTime() - offset).toISOString().slice(0, 10);
    },
    money(value) {
      return Number(value || 0).toFixed(2);
    },
    hourlyValue(b) {
      if (this.hourlyMetric === 'revenue') return Number(b.revenue_usd || 0);
      if (this.hourlyMetric === 'count') return Number(b.sales_count || 0);
      return Number(b.beers_sold || 0);
    },
    hourlyLabel(b) {
      const v = this.hourlyValue(b);
      if (this.hourlyMetric === 'revenue') return '$' + v.toFixed(2);
      return v;
    },
    hourlyPct(b) {
      const max = Math.max(1, ...this.hourly.map((x) => this.hourlyValue(x)));
      return Math.min(100, (this.hourlyValue(b) / max) * 100);
    },
    saveTicketPrefs() {
      localStorage.setItem('beerposTicketWidth', this.ticketWidth);
      localStorage.setItem('beerposAutoPrint', String(this.autoPrint));
    },
    printLastTicket() {
      if (!this.lastTicket) return;
      this.printTicket(this.lastTicket);
    },
    buildTicket(partial) {
      this.lastTicket = {
        code: partial.code || null,
        client: partial.client || null,
        items: partial.items || [],
        total_usd: Number(partial.total_usd || 0),
        total_ves: Number(partial.total_ves || 0),
        method: partial.method || 'Efectivo',
        staff: this.staffName || '',
        at: new Date().toISOString()
      };
      if (this.autoPrint) this.printTicket(this.lastTicket);
    },
    printTicket(t) {
      const html = this.buildTicketHtml(t);
      let frame = document.getElementById('beerposPrintFrame');
      if (!frame) {
        frame = document.createElement('iframe');
        frame.id = 'beerposPrintFrame';
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
        document.body.appendChild(frame);
      }
      const doc = frame.contentWindow.document;
      doc.open();
      doc.write(html);
      doc.close();
      const win = frame.contentWindow;
      const doPrint = () => { try { win.focus(); win.print(); } catch (e) { /* impresión no disponible */ } };
      if (doc.readyState === 'complete') setTimeout(doPrint, 150);
      else win.addEventListener('load', () => setTimeout(doPrint, 150), { once: true });
    },
    buildTicketHtml(t) {
      const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
      const width = this.ticketWidth === '58' ? '58mm' : '80mm';
      const est = this.est || {};
      const when = t.at ? new Date(t.at) : new Date();
      const dateStr = when.toLocaleString(this.lang === 'en' ? 'en-US' : 'es-VE');
      const items = (t.items || []).map((it) =>
        `<tr><td>${esc(it.qty)} x ${esc(it.name)}</td><td style="text-align:right">$${Number(it.amount || 0).toFixed(2)}</td></tr>`
      ).join('');
      const totalVes = Number(t.total_ves || 0) > 0
        ? `<div class="row"><span class="muted">Total Bs.</span><span>Bs. ${Number(t.total_ves).toFixed(2)}</span></div>`
        : '';
      const clientRow = t.client
        ? `<div class="row"><span class="muted">Cliente</span><span>${esc(t.client)}</span></div>`
        : '';
      const codeRow = t.code
        ? `<div class="row"><span class="muted">Código</span><span>${esc(t.code)}</span></div>`
        : '';
      return `<!DOCTYPE html><html lang="${esc(this.lang)}"><head><meta charset="utf-8" />
<title>Ticket</title>
<style>
  @page { size: ${width} auto; margin: 3mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Courier New', ui-monospace, monospace; color: #000; background: #fff; width: ${width}; margin: 0 auto; padding: 3mm; font-size: 12px; line-height: 1.35; }
  .center { text-align: center; }
  .muted { color: #444; }
  h1 { font-size: 15px; margin: 0 0 2px; }
  table { width: 100%; border-collapse: collapse; margin: 2px 0; }
  td { vertical-align: top; padding: 1px 0; }
  .dash { border-top: 1px dashed #000; margin: 5px 0; }
  .row { display: flex; justify-content: space-between; }
  .total { font-weight: bold; font-size: 14px; }
  .foot { text-align: center; margin-top: 6px; }
</style></head>
<body>
  <h1 class="center">${esc(est.name || 'Ticket')}</h1>
  ${est.owner_name ? `<div class="center muted">${esc(est.owner_name)}</div>` : ''}
  <div class="dash"></div>
  <div class="row"><span class="muted">Fecha</span><span>${esc(dateStr)}</span></div>
  ${t.staff ? `<div class="row"><span class="muted">Atiende</span><span>${esc(t.staff)}</span></div>` : ''}
  ${clientRow}
  ${codeRow}
  <div class="dash"></div>
  <table>${items}</table>
  <div class="dash"></div>
  <div class="row total"><span>TOTAL</span><span>$${Number(t.total_usd || 0).toFixed(2)}</span></div>
  ${totalVes}
  <div class="row"><span class="muted">Pago</span><span>${esc(t.method)}</span></div>
  <div class="foot">Gracias por su compra</div>
</body></html>`;
    },
    toggleDarkMode() {
      this.darkMode = !this.darkMode;
      localStorage.setItem('beerposDarkMode', String(this.darkMode));
      this.applyTheme();
    },
    applyTheme() {
      if (this.darkMode) {
        document.documentElement.classList.add('dark');
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#020617');
      } else {
        document.documentElement.classList.remove('dark');
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#ffffff');
      }
    },
    translations: {
      es: {
        app_name: 'BeerPOS',
        login_title: 'Barra / Administración',
        establishment: 'Establecimiento',
        staff_name: 'Nombre de staff',
        clave_placeholder: 'Clave de acceso',
        login_btn: 'Iniciar Sesión',
        login_error: 'Credenciales inválidas',
        skip_pin: 'Continuar sin clave (demo)',
        logout: 'Cerrar Sesión',
        secondary_display: 'Pantalla secundaria',
        sound: 'Sonido',
        sound_on: 'Sonido activado',
        sound_off: 'Activar alertas',
        theme: 'Tema',
        theme_dark: 'Claro',
        theme_light: 'Oscuro',
        fast_sale: 'Venta Rápida',
        fast_sale_desc: 'Para clientes sin teléfono. Genera un código de 3 dígitos.',
        beers: 'cervezas',
        usd: 'USD',
        ves: 'Bs.',
        generate_code: 'Generar Código',
        generated_code: 'Código generado',
        clients: 'Clientes',
        reports: 'Reportes',
        settings: 'Ajustes',
        withdrawals: 'Pedidos de retiro',
        combo_balance: 'Cargar combo / saldo',
        search_client: 'Buscar por nombre, cédula o teléfono',
        name: 'Nombre',
        id_document: 'Cédula',
        phone: 'Teléfono',
        balance: 'Saldo',
        last_activity: 'Última actividad',
        buy_qr: 'Comprar / QR',
        qty: 'Cant.',
        charge: 'Cargar',
        undo: 'Deshacer',
        accept: 'Aceptar',
        deliver: 'Entregar',
        cancel: 'Cancelar',
        no_pending: 'Sin pedidos pendientes.',
        page: 'Página',
        of: 'de',
        report_title: 'Control de ventas por día',
        from: 'Desde',
        to: 'Hasta',
        update: 'Actualizar',
        export_csv: 'CSV',
        export_excel: 'Excel',
        beers_sold: 'Cervezas vendidas',
        beers_dispatched: 'Cervezas despachadas',
        revenue_usd: 'Ingresos USD',
        revenue_ves: 'Ingresos VES',
        combos_loaded: 'Combos cargados',
        redemptions_count: 'Retiros despachados',
        daily_breakdown: 'Desglose diario',
        date: 'Fecha',
        sold: 'Vendidas',
        dispatched: 'Despachadas',
        no_data: 'Sin datos para el período seleccionado.',
        dispatches_bartender: 'Despachos por bartender',
        bartender: 'Bartender',
        withdrawals_count: 'Retiros',
        client_activity: 'Actividad de clientes',
        bought: 'Compradas',
        spent_usd: 'Gastado USD',
        spent_ves: 'Gastado VES',
        current_balance: 'Saldo actual',
        no_clients: 'Sin clientes con actividad en el período.',
        pwa_install: '¿Instalar BeerPOS?',
        install: 'Instalar',
        skip: 'Omitir',
        keypad_title: 'Teclado numérico',
        accept_key: 'Aceptar',
        language: 'Idioma',
        language_es: 'Español',
        language_en: 'Inglés',
      },
      en: {
        app_name: 'BeerPOS',
        login_title: 'Bar / Administration',
        establishment: 'Establishment',
        staff_name: 'Staff name',
        clave_placeholder: 'Access key',
        login_btn: 'Sign In',
        login_error: 'Invalid credentials',
        skip_pin: 'Continue without key (demo)',
        logout: 'Logout',
        secondary_display: 'Secondary display',
        sound: 'Sound',
        sound_on: 'Sound on',
        sound_off: 'Enable alerts',
        theme: 'Theme',
        theme_dark: 'Light',
        theme_light: 'Dark',
        fast_sale: 'Fast Sale',
        fast_sale_desc: 'For customers without phone. Generates a 3-digit code.',
        beers: 'beers',
        usd: 'USD',
        ves: 'Bs.',
        generate_code: 'Generate Code',
        generated_code: 'Code generated',
        clients: 'Clients',
        reports: 'Reports',
        settings: 'Settings',
        withdrawals: 'Withdrawal Orders',
        combo_balance: 'Load Combo / Balance',
        search_client: 'Search by name, ID or phone',
        name: 'Name',
        id_document: 'ID',
        phone: 'Phone',
        balance: 'Balance',
        last_activity: 'Last activity',
        buy_qr: 'Buy / QR',
        qty: 'Qty',
        charge: 'Charge',
        undo: 'Undo',
        accept: 'Accept',
        deliver: 'Deliver',
        cancel: 'Cancel',
        no_pending: 'No pending orders.',
        page: 'Page',
        of: 'of',
        report_title: 'Daily Sales Control',
        from: 'From',
        to: 'To',
        update: 'Update',
        export_csv: 'CSV',
        export_excel: 'Excel',
        beers_sold: 'Beers Sold',
        beers_dispatched: 'Beers Dispatched',
        revenue_usd: 'Revenue USD',
        revenue_ves: 'Revenue VES',
        combos_loaded: 'Combos Loaded',
        redemptions_count: 'Withdrawals Dispatched',
        daily_breakdown: 'Daily Breakdown',
        date: 'Date',
        sold: 'Sold',
        dispatched: 'Dispatched',
        no_data: 'No data for the selected period.',
        dispatches_bartender: 'Dispatches by Bartender',
        bartender: 'Bartender',
        withdrawals_count: 'Withdrawals',
        client_activity: 'Client Activity',
        bought: 'Bought',
        spent_usd: 'Spent USD',
        spent_ves: 'Spent VES',
        current_balance: 'Current Balance',
        no_clients: 'No clients with activity in the period.',
        pwa_install: 'Install BeerPOS?',
        install: 'Install',
        skip: 'Skip',
        keypad_title: 'Numeric Keypad',
        accept_key: 'Accept',
        language: 'Language',
        language_es: 'Spanish',
        language_en: 'English',
      },
    },
    $t(key) {
      return this.translations[this.lang]?.[key] || key;
    },
    setLang(lang) {
      this.lang = lang;
      localStorage.setItem('beerposLang', lang);
      document.documentElement.lang = lang;
    },
    async installPWA() {
      if (!this.installPrompt) return;
      try {
        this.installPrompt.prompt();
        const { outcome } = await this.installPrompt.userChoice;
        if (outcome === 'accepted') {
          this.showInstallBanner = false;
          this.installMenuOpen = false;
        }
        this.installPrompt = null;
      } catch (e) {
        console.warn('PWA install failed', e);
      }
    },
    toggleInstallMenu() {
      this.installMenuOpen = !this.installMenuOpen;
    },
    dismissInstallBanner() {
      this.showInstallBanner = false;
      this.installMenuOpen = false;
      this.installPrompt = null;
    },
    openNumericKeypad(target) {
      this.numericKeypad = { visible: true, target, value: '' };
    },
    closeNumericKeypad() {
      this.numericKeypad = { visible: false, target: '', value: '' };
    },
    pressNumericKey(key) {
      if (this.numericKeypad.value.length >= 4) return;
      this.numericKeypad.value += key;
    },
    backspaceNumeric() {
      this.numericKeypad.value = this.numericKeypad.value.slice(0, -1);
    },
    applyNumericKeypad() {
      if (this.numericKeypad.target === 'loginPin') {
        this.loginPin = this.numericKeypad.value;
      }
      this.closeNumericKeypad();
    },
    async scanClientPasskeyAtPos() {
      if (!this.estId || !this.sessionToken) return null;
      if (!this.webAuthnAvailable()) {
        this.showToast('error', 'Passkeys no disponibles', 'Este navegador no admite WebAuthn en este origen.');
        return null;
      }
      this.passkeyScanning = true;
      try {
        const options = await this.api('/client-passkeys/pos/authentication/options', {
          method: 'POST',
        });
        const credential = await navigator.credentials.get({
          publicKey: this.decodeWebAuthnOptions(options),
        });
        if (!credential) throw new Error('No se completó la autenticación con passkey.');
        const result = await this.api('/client-passkeys/pos/authentication/verify', {
          method: 'POST',
          body: JSON.stringify({
            challenge: options.challenge,
            response: this.serializeWebAuthnCredential(credential),
          }),
        });
        const client = result.client;
        if (Number(client.current_balance) < 1) {
          this.showToast('info', 'Cliente reconocido', `${client.full_name} no tiene saldo disponible.`);
          return result;
        }
        await this.api('/client-orders', {
          method: 'POST',
          body: JSON.stringify({
            establishment_id: this.estId,
            client_id: client.id,
            quantity: 1,
          }),
        });
        this.showToast('success', 'Pedido creado', `Se solicitó 1 cerveza para ${client.full_name}.`);
        return result;
      } catch (e) {
        this.showToast('error', 'Error de passkey', e.message || 'No se pudo autenticar al cliente.');
        return null;
      } finally {
        this.passkeyScanning = false;
      }
    },
    async resetClientPasskeys(client) {
      if (!this.isOwner() || !confirm(`¿Desvincular todas las passkeys de ${client.full_name}? El cliente deberá registrar un autenticador nuevo.`)) return;
      try {
        const result = await this.api(`/client-passkeys/pos/clients/${client.id}`, { method: 'DELETE' });
        this.showToast('success', 'Passkeys desvinculadas', `Se eliminaron ${result.deleted} autenticador(es).`);
      } catch (e) {
        this.showToast('error', 'Error', e.message || 'No se pudieron desvincular las passkeys.');
      }
    },
    async loadFastPending() {
      try { this.fastPending = await this.api(`/redemptions/fast?establishment_id=${this.estId}`); } catch(e){}
    },
    fastTotalUsd() {
      const p = Number(this.est?.beer_price_usd || 0);
      return (p * (this.fastQty || 0)).toFixed(2);
    },
    fastTotalVes() {
      const rate = Number(this.est?.exchange_rate?.usd_to_ves || 0);
      return (Number(this.fastTotalUsd()) * rate).toFixed(2);
    },
    async createFastSale() {
      try {
        const requestId = this.createRequestId();
        const res = await this.api('/redemptions/fast', {
          method: 'POST',
          headers: { 'X-Background-Sync': 'true' },
          body: JSON.stringify({ establishment_id: this.estId, quantity: this.fastQty, request_id: requestId })
        });
        if (res.queued) {
          this.pendingSyncCount = res.pending_count;
          this.syncError = '';
          this.lastFastCode = null;
          alert('Sin conexión: la venta quedó guardada y se sincronizará al recuperar la red.');
          return;
        }
        this.lastFastCode = res.redemption.code;
        this.lastFastQty = res.redemption.quantity;
        this.buildTicket({
          code: res.redemption.code,
          items: [{ qty: res.redemption.quantity, name: 'Cerveza', amount: res.amount_usd }],
          total_usd: res.amount_usd,
          total_ves: res.amount_ves,
          method: 'Efectivo'
        });
        await Promise.all([this.loadFastPending(), this.loadSummary()]);
      } catch (e) { alert(e.message); }
    },
    async dispatchFast(id) {
      try {
        await this.api(`/redemptions/fast/${id}/dispatch`, { method: 'POST' });
        await Promise.all([this.loadFastPending(), this.loadSummary()]);
      } catch (e) { alert(e.message); }
    },

    async loadClients() {
      try {
        const q = encodeURIComponent(this.clientSearch || '');
        this.clients = await this.api(`/clients?establishment_id=${this.estId}&search=${q}`);
        this.clients.forEach(c => { if (c._qty == null) c._qty = 10; });
        this.clientsPage = 1;
      } catch (e) {}
    },
    async loadPendingOrders() {
      try {
        this.pendingOrders = await this.api(`/client-orders?establishment_id=${this.estId}&limit=100`);
        this.pendingOrdersPage = 1;
      } catch (e) { console.warn(e); }
    },
    async acceptOrder(orderId) {
      try {
        const res = await this.api(`/client-orders/${orderId}/accept`, { method: 'PATCH' });
        await this.loadPendingOrders();
        await this.loadClients();
        this.showToast('success', 'Pedido aceptado', 'Se descontó el saldo y el pedido está en preparación.');
        this.clientAlert();
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async deliverOrder(orderId) {
      try {
        // Pedir código de verificación que el cliente muestra en su pantalla
        const code = prompt('Ingrese el código de verificación de 4 dígitos que muestra el cliente en su pantalla:');
        if (!code) return;
        const res = await this.api(`/client-orders/${orderId}/deliver`, {
          method: 'PATCH',
          body: JSON.stringify({ verification_code: code })
        });
        await this.loadPendingOrders();
        await this.loadClients();
        this.showToast('success', 'Pedido entregado', 'El cliente ha sido notificado.');
        this.clientAlert();
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    toggleClientsModal() {
      this.clientsModalOpen = !this.clientsModalOpen;
      if (this.clientsModalOpen) {
        this.loadClients();
      } else {
        this.clientSearch = '';
      }
    },
    async cancelOrder(orderId) {
      try {
        const res = await this.api(`/client-orders/${orderId}/cancel`, { method: 'PATCH' });
        await this.loadPendingOrders();
        await this.loadClients();
        this.showToast('info', 'Pedido cancelado', 'El saldo del cliente fue liberado.');
        this.clientAlert();
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    orderStatusLabel(status) {
      const labels = {
        SOLICITADO: 'Solicitado',
        EN_PREPARACION: 'En preparación',
        ENTREGADO: 'Entregado',
        CANCELADO: 'Cancelado',
        EXPIRADO: 'Expirado'
      };
      return labels[status] || status;
    },
    get pendingOrdersCount() {
      return this.pendingOrders.filter(o => o.status === 'SOLICITADO' || o.status === 'EN_PREPARACION').length;
    },
    get pendingOrdersPages() {
      return Math.ceil(this.pendingOrders.length / this.pendingOrdersPageSize);
    },
    get pendingOrdersPaginated() {
      const start = (this.pendingOrdersPage - 1) * this.pendingOrdersPageSize;
      return this.pendingOrders.slice(start, start + this.pendingOrdersPageSize);
    },
    prevPage() {
      if (this.pendingOrdersPage > 1) this.pendingOrdersPage--;
    },
    nextPage() {
      if (this.pendingOrdersPage < this.pendingOrdersPages) this.pendingOrdersPage++;
    },
    get clientsPages() {
      return Math.ceil(this.clients.length / this.clientsPageSize);
    },
    get clientsPaginated() {
      const start = (this.clientsPage - 1) * this.clientsPageSize;
      return this.clients.slice(start, start + this.clientsPageSize);
    },
    prevClientPage() {
      if (this.clientsPage > 1) this.clientsPage--;
    },
    nextClientPage() {
      if (this.clientsPage < this.clientsPages) this.clientsPage++;
    },
    async checkDocument() {
      const doc = this.newClient.document_id?.trim();
      if (!doc || doc.length < 5) return;
      try {
        const clients = await this.api(`/clients?establishment_id=${this.estId}&search=${encodeURIComponent(doc)}`);
        const existing = clients.find(c => c.document_id === doc);
        if (existing) {
          this.newClient.full_name = existing.full_name;
          this.newClient.phone = existing.phone;
          this.showToast('info', 'Cliente ya registrado', `Se encontró a ${existing.full_name}. Puede actualizar sus datos si es necesario.`);
        }
      } catch (e) { console.warn(e); }
    },
    async registerClient() {
      const { full_name, document_id, phone } = this.newClient;
      if (!full_name || !document_id || !phone) return alert('Completa nombre, cédula y teléfono');
      try {
        const res = await this.api('/clients', {
          method: 'POST',
          body: JSON.stringify({ establishment_id: this.estId, full_name, document_id, phone })
        });
        this.lastRegistered = res;
        this.newClient = { full_name: '', document_id: '', phone: '' };
        await this.loadClients();
      } catch (e) { alert(e.message); }
    },
    async chargeCombo(c) {
      const qty = parseInt(c._qty, 10);
      if (!qty || qty <= 0) return alert('Cantidad inválida');
      try {
        const res = await this.api(`/clients/${c.id}/charge-combo`, {
          method: 'POST',
          body: JSON.stringify({ quantity: qty, payment_method: 'cash' })
        });
        c.current_balance = res.client.current_balance;
        await this.loadSummary();
        this.showToast('success', 'Combo cargado', `Cargadas ${qty} cervezas. Total: $${res.amount_usd} / Bs. ${res.amount_ves}`);
        this.buildTicket({
          client: c.full_name,
          items: [{ qty, name: 'Cerveza', amount: res.amount_usd }],
          total_usd: res.amount_usd,
          total_ves: res.amount_ves,
          method: 'Efectivo'
        });
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async undoCharge(c) {
      const qty = parseInt(c._qty, 10);
      if (!qty || qty <= 0) return alert('Cantidad inválida');
      if (qty > Number(c.current_balance || 0)) return alert('No se puede deshacer más de lo que tiene en saldo');
      try {
        const res = await this.api(`/clients/${c.id}/charge-combo`, {
          method: 'POST',
          body: JSON.stringify({ quantity: -qty, payment_method: 'cash' })
        });
        c.current_balance = res.client.current_balance;
        await this.loadSummary();
        this.showToast('success', 'Carga deshecha', `Se descontaron ${qty} cervezas. Saldo: ${res.client.current_balance}`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },

    // --- Credit / Fiado ---
    isOwner() {
      return this.staffRole === 'owner';
    },
    creditUsage(c) {
      const limit = Number(c.credit_limit_usd || 0);
      const bal = Number(c.credit_balance_usd || 0);
      if (limit <= 0) return 0;
      return bal / limit;
    },
    creditBadgeClass(c) {
      if (Number(c.credit_limit_usd || 0) <= 0) return 'bg-slate-700 text-slate-300';
      const u = this.creditUsage(c);
      if (Number(c.credit_balance_usd || 0) >= Number(c.credit_limit_usd)) return 'bg-rose-700 text-white';
      if (u >= 0.8) return 'bg-amber-500 text-slate-950';
      return 'bg-emerald-700 text-white';
    },
    creditBadgeText(c) {
      const limit = Number(c.credit_limit_usd || 0);
      const bal = Number(c.credit_balance_usd || 0);
      if (limit <= 0) return 'Sin crédito';
      if (bal >= limit) return 'Límite alcanzado';
      return 'Activo';
    },
    async setCreditLimit(c) {
      const current = Number(c.credit_limit_usd || 0);
      const input = prompt(`Límite de crédito (USD) para ${c.full_name}:\nActual: $${current.toFixed(2)}\n(0 = sin crédito)`, current > 0 ? String(current) : '');
      if (input == null) return;
      const limit = Number(input);
      if (!Number.isFinite(limit) || limit < 0) return this.showToast('error', 'Error', 'Ingresa un monto válido.');
      try {
        const res = await this.api(`/credit/clients/${c.id}/limit`, {
          method: 'POST',
          body: JSON.stringify({ credit_limit_usd: limit })
        });
        c.credit_limit_usd = res.credit_limit_usd;
        c.credit_balance_usd = res.credit_balance_usd;
        c.available_usd = Number(res.credit_limit_usd) - Number(res.credit_balance_usd);
        await this.loadCredit();
        this.showToast('success', 'Límite actualizado', `Cupo de ${c.full_name}: $${Number(res.credit_limit_usd).toFixed(2)}`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async removeCredit(c) {
      if (Number(c.credit_limit_usd || 0) <= 0) return this.showToast('info', 'Sin crédito', 'Este cliente no tiene crédito habilitado.');
      if (!confirm(`¿Quitar TODO el crédito (fiado) a ${c.full_name}?\n\nEsto pondrá el límite en $0.00.\nDeuda actual: $${Number(c.credit_balance_usd || 0).toFixed(2)}`)) return;
      try {
        const res = await this.api(`/credit/clients/${c.id}/limit`, {
          method: 'POST',
          body: JSON.stringify({ credit_limit_usd: 0 })
        });
        c.credit_limit_usd = res.credit_limit_usd;
        c.credit_balance_usd = res.credit_balance_usd;
        c.available_usd = Number(res.credit_limit_usd) - Number(res.credit_balance_usd);
        await this.loadCredit();
        this.showToast('success', 'Crédito removido', `${c.full_name} ya no tiene cupo de fiado.`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async toggleCreditHold(c) {
      if (c.credit_hold_reason) {
        if (!confirm(`Desbloquear crédito de ${c.full_name}?`)) return;
        try {
          await this.api(`/credit/clients/${c.id}/hold`, { method: 'POST', body: JSON.stringify({ reason: null }) });
          c.credit_hold_reason = null;
          await this.loadCredit();
          this.showToast('success', 'Crédito desbloqueado', `${c.full_name} puede volver a fiar.`);
        } catch (e) { this.showToast('error', 'Error', e.message); }
      } else {
        const reason = prompt(`Motivo de bloqueo para ${c.full_name}:`, '');
        if (!reason) return;
        try {
          await this.api(`/credit/clients/${c.id}/hold`, { method: 'POST', body: JSON.stringify({ reason }) });
          c.credit_hold_reason = reason;
          await this.loadCredit();
          this.showToast('success', 'Crédito bloqueado', `${c.full_name}: ${reason}`);
        } catch (e) { this.showToast('error', 'Error', e.message); }
      }
    },
    async creditAdjust(c) {
      const input = prompt(`Ajuste de saldo para ${c.full_name}:\nSaldo actual: $${Number(c.credit_balance_usd||0).toFixed(2)}\n\nMonto (positivo=aumenta deuda, negativo=reduce):`, '0');
      if (input == null) return;
      const amount = Number(input);
      if (!Number.isFinite(amount) || amount === 0) return;
      const note = prompt('Motivo del ajuste (obligatorio):', '');
      if (!note) return;
      try {
        const res = await this.api(`/credit/clients/${c.id}/adjust`, {
          method: 'POST',
          body: JSON.stringify({ amount_usd: amount, note })
        });
        c.credit_balance_usd = res.balance_after_usd;
        await this.loadCredit();
        this.showToast('success', 'Ajuste registrado', `Nuevo saldo: $${res.balance_after_usd.toFixed(2)}`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async creditNote(c) {
      const input = prompt(`Nota de crédito para ${c.full_name}:\nSaldo actual: $${Number(c.credit_balance_usd||0).toFixed(2)}\n\nMonto a reducir:`, '');
      if (input == null) return;
      const amount = Number(input);
      if (!Number.isFinite(amount) || amount <= 0) return;
      const note = prompt('Motivo de la nota de crédito (obligatorio):', '');
      if (!note) return;
      try {
        const res = await this.api(`/credit/clients/${c.id}/credit-note`, {
          method: 'POST',
          body: JSON.stringify({ amount_usd: amount, note })
        });
        c.credit_balance_usd = res.balance_after_usd;
        await this.loadCredit();
        this.showToast('success', 'Nota de crédito registrada', `Nuevo saldo: $${res.balance_after_usd.toFixed(2)}`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async fiadoSale(c) {
      const price = Number(this.est?.beer_price_usd || 0);
      if (price <= 0) return alert('Define el precio de la cerveza en Ajustes antes de vender a crédito.');
      if (Number(c.credit_limit_usd || 0) <= 0) return alert('Este cliente no tiene crédito (fiado) habilitado.');
      const qty = parseInt(prompt('Cantidad de cervezas a fiado:', '1'), 10);
      if (!qty || qty <= 0) return;
      const amount = Math.round(qty * price * 100) / 100;
      const rate = Number(this.est?.exchange_rate?.usd_to_ves || 0) || null;
      const body = { client_id: c.id, amount_usd: amount, quantity: qty, exchange_rate: rate };
      try {
        const res = await this.api('/credit/sale', { method: 'POST', body: JSON.stringify(body) });
        c.credit_balance_usd = res.balance_after_usd;
        if (this.creditClients.length) await this.loadCredit();
        await this.loadSummary();
        this.showToast('success', 'Venta a crédito', `Fiado $${amount.toFixed(2)} · Debe ahora $${res.balance_after_usd.toFixed(2)}`);
        this.buildTicket({
          client: c.full_name,
          items: [{ qty, name: 'Cerveza', amount }],
          total_usd: amount,
          total_ves: rate ? amount * rate : 0,
          method: 'Crédito (fiado)'
        });
      } catch (e) {
        if (e.data?.code === 'limit_exceeded') {
          const d = e.data.details || {};
          if (!this.isOwner()) {
            this.showToast('error', 'Límite excedido', `Disponible $${(d.available || 0).toFixed(2)}. Solo el owner puede autorizar el exceso.`);
            return;
          }
          const override = confirm(`Límite excedido. Disponible $${(d.available || 0).toFixed(2)}, consumo $${amount.toFixed(2)}.\n¿Registrar de todos modos (override de owner)?`);
          if (override) { await this.fiadoSaleOverride(c, body); return; }
        }
        this.showToast('error', 'Error', e.message);
      }
    },
    async fiadoSaleOverride(c, body) {
      const reason = prompt('Motivo del exceso de límite (obligatorio):');
      if (!reason) return;
      try {
        const res = await this.api('/credit/sale/override', { method: 'POST', body: JSON.stringify({ ...body, reason }) });
        c.credit_balance_usd = res.balance_after_usd;
        if (this.creditClients.length) await this.loadCredit();
        await this.loadSummary();
        this.showToast('success', 'Venta a crédito (override)', `Debe ahora $${res.balance_after_usd.toFixed(2)}`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async loadCredit() {
      this.creditTabLoading = true;
      try {
        const [clients, aging] = await Promise.all([
          this.api('/credit/clients'),
          this.api('/credit/aging').catch(() => ({ aging: [] })),
        ]);
        this.creditClients = (clients.clients || []).filter(c => Number(c.credit_limit_usd || 0) > 0 || Number(c.credit_balance_usd || 0) > 0);
        this.creditAging = aging.aging || [];
      } catch (e) {
        console.warn(e);
      } finally {
        this.creditTabLoading = false;
      }
    },
    creditAgingFor(clientId) {
      return this.creditAging.find(a => a.client_id === clientId) || null;
    },
    async creditAbono(c) {
      const bal = Number(c.credit_balance_usd || 0);
      if (bal <= 0) return alert('El cliente no tiene deuda.');
      const amount = prompt(`Abono (deuda actual $${bal.toFixed(2)}):`, bal.toFixed(2));
      if (amount == null) return;
      const method = prompt('Método (efectivo / pago_movil / zelle / transferencia):', 'efectivo') || 'efectivo';
      try {
        const res = await this.api(`/credit/clients/${c.id}/payment`, {
          method: 'POST',
          body: JSON.stringify({ amount_usd: Number(amount), payment_method: method })
        });
        await this.loadCredit();
        await this.loadSummary();
        this.showToast('success', 'Abono registrado', `Abonado $${res.paid_usd.toFixed(2)} · Saldo $${res.balance_after_usd.toFixed(2)}`);
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async openStatement(c) {
      try {
        const data = await this.api(`/credit/clients/${c.id}/statement`);
        this.creditStatement = { client: data.client, entries: data.entries || [] };
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    async downloadStatementPdf() {
      if (!this.creditStatement?.client) return;
      const c = this.creditStatement.client;
      try {
        const resp = await fetch(`/api/credit/clients/${c.id}/statement?format=pdf`, {
          headers: this.sessionToken ? { 'x-session-token': this.sessionToken } : {}
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const disposition = resp.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/);
        const filename = match ? match[1] : 'estado_cuenta.pdf';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { this.showToast('error', 'Error al generar PDF', e.message); }
    },
    creditTotalDebt() {
      return this.creditClients.reduce((a, c) => a + Number(c.credit_balance_usd || 0), 0);
    },
    showToast(type = 'success', title = '', message = '', showBalance = false, balance = 0) {
      this.toast = { show: true, type, title, message, showBalance, balance };
      setTimeout(() => { this.toast.show = false; }, 5000);
    },
    clientLink(token) {
      return `${window.location.origin}/c/${token}`;
    },
    renderQr(containerId, url, size = 168) {
      const el = document.getElementById(containerId);
      if (!el || !window.QRCode) return;
      const canvas = document.createElement('canvas');
      try {
        QRCode.toCanvas(canvas, url, {
          width: size,
          color: { dark: '#111827', light: '#ffffff' },
          errorCorrectionLevel: 'H'
        }, (error) => {
          if (error) {
            console.error('No se pudo generar el QR:', error);
            return;
          }
          el.replaceChildren(canvas);
        });
      } catch (e) {
        console.error('No se pudo generar el QR:', e);
      }
    },
    async ensureClientToken(client) {
      if (client.access_token) return client.access_token;
      // Tokens are hashed at rest, so the list never carries them. Issue a fresh one on demand.
      const res = await this.api(`/clients/${client.id}/rotate-token`, { method: 'POST' });
      client.access_token = res.access_token;
      if (this.lastRegistered?.id === client.id) this.lastRegistered.access_token = res.access_token;
      if (this.qrModal?.id === client.id) this.qrModal.access_token = res.access_token;
      return res.access_token;
    },
    async showQr(client) {
      try {
        if (!client.access_token &&
            !confirm(`¿Mostrar el QR de ${client.full_name}? Se generará un enlace nuevo y el anterior dejará de funcionar.`)) {
          return;
        }
        await this.ensureClientToken(client);
        this.qrModal = client;
        this.clientsModalOpen = false;
        this.$nextTick(() => this.renderQr('qr-modal-canvas', this.clientLink(client.access_token), 280));
      } catch (e) { alert(e.message); }
    },
    async copyClientLink(client) {
      try {
        if (!client.access_token &&
            !confirm(`¿Copiar el enlace de ${client.full_name}? Se generará uno nuevo y el anterior dejará de funcionar.`)) {
          return;
        }
        const token = await this.ensureClientToken(client);
        await this.copyLink(token);
      } catch (e) { alert(e.message); }
    },
    async copyLink(token) {
      const url = this.clientLink(token);
      try {
        await navigator.clipboard.writeText(url);
        alert('Enlace copiado: ' + url);
      } catch (e) {
        prompt('Copia este enlace:', url);
      }
    },
    async rotateClientToken(client) {
      if (!this.sessionToken) return alert('Inicia sesión con PIN para renovar el QR.');
      if (!confirm(`¿Renovar el QR de ${client.full_name}? El enlace anterior dejará de funcionar.`)) return;
      try {
        const res = await this.api(`/clients/${client.id}/rotate-token`, { method: 'POST' });
        client.access_token = res.access_token;
        if (this.lastRegistered?.id === client.id) {
          this.lastRegistered.access_token = res.access_token;
          this.$nextTick(() => this.renderQr(
            `qr-reg-${client.id}`,
            this.clientLink(res.access_token),
            180
          ));
        }
        if (this.qrModal?.id === client.id) {
          this.qrModal.access_token = res.access_token;
          this.$nextTick(() => this.renderQr('qr-modal-canvas', this.clientLink(res.access_token), 280));
        }
      } catch (e) { alert(e.message); }
    },

    async saveRate() {
      if (!this.newRate) return;
      try {
        await this.api(`/establishments/${this.estId}/rate`, { method: 'POST', body: JSON.stringify({ usd_to_ves: this.newRate }) });
        await this.loadBartender();
      } catch (e) { alert(e.message); }
    },
    async fetchBcvRate() {
      try {
        // The endpoint already persists the fetched rate in the DB, so no extra save call is needed.
        const res = await this.api(`/establishments/${this.estId}/rate/fetch`, { method: 'POST' });
        const rate = Number(res.usd_to_ves);
        this.newRate = rate;
        if (this.est) this.est.exchange_rate = { usd_to_ves: rate };
        return rate;
      } catch (e) { throw new Error('No se pudo obtener la tasa del BCV: ' + e.message); }
    },
    async autoUpdateBcvRate() {
      try {
        await this.fetchBcvRate();
      } catch (e) { console.warn(e.message); }
    },
    async refreshBcvRate() {
      try {
        const rate = await this.fetchBcvRate();
        alert(`Tasa BCV actualizada: $1 = Bs. ${rate}`);
        await this.loadBartender();
      } catch (e) { alert(e.message); }
    },
    async savePrice() {
      if (!this.newPrice) return;
      try {
        await this.api(`/establishments/${this.estId}/price`, { method: 'PATCH', body: JSON.stringify({ beer_price_usd: this.newPrice }) });
        await this.loadBartender();
      } catch (e) { alert(e.message); }
    },
    async saveBranding() {
      try {
        const updated = await this.api(`/establishments/${this.estId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            logo_url: this.newLogoUrl,
            theme_color: this.newThemeColor,
            secondary_color: this.newSecondaryColor
          })
        });
        this.est = { ...this.est, ...updated };
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.newThemeColor);
        alert('Marca actualizada.');
      } catch (e) { alert(e.message); }
    },
    async saveEstablishment() {
      try {
        const updated = await this.api(`/establishments/${this.estId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            name: this.newName || undefined,
            owner_name: this.newOwner || undefined,
            phone: this.newPhone || undefined
          })
        });
        this.est = { ...this.est, ...updated };
        this.newName = '';
        this.newOwner = '';
        this.newPhone = '';
        alert('Datos del negocio actualizados.');
      } catch (e) { alert(e.message); }
    },
    handleLogoFile(e) {
      this.logoFile = e.target.files[0] || null;
    },
    async uploadLogo() {
      if (!this.logoFile) return;
      const formData = new FormData();
      formData.append('logo', this.logoFile);
      try {
        const res = await this.api(`/establishments/${this.estId}/logo`, {
          method: 'POST',
          body: formData
        });
        this.newLogoUrl = res.logo_url;
        this.est = { ...this.est, logo_url: res.logo_url };
        this.logoFile = null;
        this.showToast('success', 'Logo subido', 'La imagen del establecimiento se actualizó correctamente.');
      } catch (e) { this.showToast('error', 'Error', e.message); }
    },
    clientAlert() {
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(800, ctx.currentTime);
          osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(0.15, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.3);
          ctx.close();
        }
      } catch (e) { console.warn(e); }
    },
    startExpiryTimer(expiresAt) {
      this.stopExpiryTimer();
      const endTime = new Date(expiresAt).getTime();
      const tick = () => {
        const now = Date.now();
        const seconds = Math.max(0, Math.ceil((endTime - now) / 1000));
        this.orderTimeLeft = seconds;
        if (seconds <= 0) {
          this.stopExpiryTimer();
          if (this.orderStatus) this.orderStatus.status = 'EXPIRADO';
          this.showToast('error', 'Pedido expirado', 'Tu solicitud expiró por inactividad. Tu saldo fue liberado.');
        }
      };
      tick();
      this.orderTimer = setInterval(tick, 1000);
    },
    stopExpiryTimer() {
      if (this.orderTimer) {
        clearInterval(this.orderTimer);
        this.orderTimer = null;
      }
      this.orderTimeLeft = null;
    },
    startClientOrderPolling() {
      this.stopClientOrderPolling();
      // Initial immediate check
      this.pollClientOrderStatus();
      // Then poll every 3 seconds
      this.clientOrderPollTimer = setInterval(() => {
        this.pollClientOrderStatus();
      }, 3000);
    },
    stopClientOrderPolling() {
      if (this.clientOrderPollTimer) {
        clearInterval(this.clientOrderPollTimer);
        this.clientOrderPollTimer = null;
      }
    },
    startClientSyncTimer() {
      this.stopClientSyncTimer();
      // Full state sync every 30 seconds as safety net for missed real-time events
      this.clientSyncTimer = setInterval(() => {
        this.loadClientOrders();
      }, 30000);
    },
    stopClientSyncTimer() {
      if (this.clientSyncTimer) {
        clearInterval(this.clientSyncTimer);
        this.clientSyncTimer = null;
      }
    },
    async pollClientOrderStatus() {
      if (!this.client) return;
      try {
        // Solo traer órdenes activas: SOLICITADO o EN_PREPARACION
        const orders = await this.api(`/client-orders?establishment_id=${this.client.establishment_id}&status=SOLICITADO,EN_PREPARACION&limit=5`);
        const myOrder = orders.find(o => o.client_id === this.client.id);
        if (myOrder) {
          // Initialize orderStatus if null (e.g., page just loaded with existing order)
          if (!this.orderStatus) {
            this.orderStatus = { ...myOrder };
            if (myOrder.status === 'SOLICITADO') this.startExpiryTimer(myOrder.expires_at);
            return;
          }
          if (myOrder.status !== this.orderStatus.status) {
            this.orderStatus = { ...myOrder };
            if (myOrder.status === 'EN_PREPARACION') {
              // Orden aceptada por el bartender
              this.loadClient();
              this.showToast('info', 'Pedido recibido', `El bartender recibió tu solicitud y está preparando tu retiro. Saldo: ${this.client.current_balance}`, true, this.client.current_balance);
              this.clientAlert();
            } else if (myOrder.status === 'SOLICITADO') {
              this.startExpiryTimer(myOrder.expires_at);
            }
          }
        } else if (this.orderStatus && this.orderStatus.status !== 'ENTREGADO') {
          // La orden ya no está en SOLICITADO ni EN_PREPARACION: probablemente fue entregada
          this.orderStatus = { ...this.orderStatus, status: 'ENTREGADO' };
          this.stopExpiryTimer();
          this.stopClientOrderPolling();
          this.stopClientSyncTimer();
          this.clientAlert();
          this.loadClient().then(() => {
            this.showToast('success', 'Pedido entregado', `¡Tu retiro fue entregado! Acércate al bartender. Saldo: ${this.client.current_balance}`, true, this.client.current_balance);
          });
        }
      } catch (e) { console.warn('Polling error', e); }
    },
    formatTime(seconds) {
      if (!seconds) return '0:00';
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    formatTimeLeft(isoString) {
      if (!isoString) return '--:--';
      const remaining = Math.max(0, new Date(isoString).getTime() - Date.now());
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    brandStyles() {
      const source = this.client || this.est;
      return {
        '--brand-primary': source?.theme_color || '#0f172a',
        '--brand-secondary': source?.secondary_color || '#f59e0b'
      };
    },
    redeemButtonStyle() {
      const bg = this.client?.secondary_color || '#10b981';
      const c = bg.charAt(0) === '#' ? bg.slice(1) : bg;
      let r, g, b;
      if (c.length === 3) {
        r = parseInt(c[0] + c[0], 16);
        g = parseInt(c[1] + c[1], 16);
        b = parseInt(c[2] + c[2], 16);
      } else {
        const rgb = parseInt(c, 16);
        r = (rgb >> 16) & 0xff;
        g = (rgb >> 8) & 0xff;
        b = (rgb >> 0) & 0xff;
      }
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      return {
        backgroundColor: bg,
        color: luma > 186 ? '#0f172a' : '#ffffff'
      };
    },
    orderBadgeClass(status) {
      const classes = {
        SOLICITADO: 'bg-amber-500 text-amber-900',
        EN_PREPARACION: 'bg-blue-500 text-blue-900',
        ENTREGADO: 'bg-emerald-500 text-emerald-900',
        CANCELADO: 'bg-rose-500 text-rose-900',
        EXPIRADO: 'bg-slate-500 text-slate-900'
      };
      return classes[status] || 'bg-slate-600 text-white';
    },
    orderStatusMessage(order) {
      const messages = {
        SOLICITADO: `Pedido enviado. Esperando que el bartender lo acepte. Expira en ${order.expires_at ? this.timeRemaining(order.expires_at) : ''}.`,
        EN_PREPARACION: 'El bartender recibió tu pedido y lo está preparando. ¡Pronto estarán listas tus cervezas!',
        ENTREGADO: 'Tu pedido fue entregado. ¡Gracias por tu compra!',
        CANCELADO: 'Tu pedido fue cancelado. Tu saldo no fue afectado.',
        EXPIRADO: 'Tu pedido expiró por inactividad. Tu saldo fue liberado.'
      };
      return messages[order.status] || '';
    },
    refreshPendingSync() {
      navigator.serviceWorker?.controller?.postMessage({ type: 'GET_SYNC_STATUS' });
    },
    retryPendingSync() {
      this.syncError = '';
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'SYNC_PENDING' });
      }
    },
    createRequestId() {
      if (crypto.randomUUID) return crypto.randomUUID();
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },

    timeAgo(ts) {
      const diff = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
      if (diff < 1) return 'ahora';
      if (diff < 60) return diff + ' min';
      return Math.floor(diff/60) + ' h';
    },
    formatDocumentId(doc) {
      if (!doc) return '';
      const cleaned = String(doc).replace(/[^0-9]/g, '');
      const formatted = cleaned.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return `V-${formatted}`;
    }
  };
}

window.app = app;
Alpine.start();

// Initial emoji parse after Alpine renders the first view
parseEmojis(document.body);

// Watch for dynamically added content (tab switches, modals, toasts, etc.)
setupEmojiObserver();
