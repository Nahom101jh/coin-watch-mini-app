(function () {
  const tg = window.Telegram?.WebApp;
  let initData = '';

  if (tg) {
    tg.ready();
    tg.expand();
    initData = tg.initData || '';
    applyTelegramTheme(tg);
  }

  // --- Dev fallback: lets you test the UI in a normal browser tab. ---
  const isInsideTelegram = Boolean(initData);
  const devUserId = isInsideTelegram ? null : getOrCreateDevId();

  const MILESTONE_STEP = 50; // points per progress-ring lap

  const balanceEl = document.getElementById('balance');
  const balanceSubEl = document.getElementById('balanceSub');
  const milestoneLabelEl = document.getElementById('milestoneLabel');
  const ringProgressEl = document.getElementById('ringProgress');
  const coinIconEl = document.getElementById('coinIcon');
  const watchBtn = document.getElementById('watchBtn');
  const watchBtnLabel = document.getElementById('watchBtnLabel');
  const watchStatus = document.getElementById('watchStatus');
  const activityList = document.getElementById('activityList');
  const leaderboardList = document.getElementById('leaderboardList');
  // Referral code from the deep link bot.js appends to the Mini App URL
  // (t.me/YourBot?start=X -> ?ref=X on this page), read once at load.
  const refParam = new URLSearchParams(window.location.search).get('ref');
  const myUserId = isInsideTelegram ? tg?.initDataUnsafe?.user?.id : devUserId;

  const tabActivity = document.getElementById('tabActivity');
  const tabLeaderboard = document.getElementById('tabLeaderboard');
  const tabWithdraw = document.getElementById('tabWithdraw');
  const panelActivity = document.getElementById('panelActivity');
  const panelLeaderboard = document.getElementById('panelLeaderboard');
  const panelWithdraw = document.getElementById('panelWithdraw');

  const inviteProgressEl = document.getElementById('inviteProgress');
  const qualifyProgressEl = document.getElementById('qualifyProgress');
  const withdrawRuleEl = document.getElementById('withdrawRule');
  const refLinkEl = document.getElementById('refLink');
  const copyRefBtn = document.getElementById('copyRefBtn');
  const withdrawBtn = document.getElementById('withdrawBtn');
  const withdrawBtnLabel = document.getElementById('withdrawBtnLabel');
  const withdrawStatus = document.getElementById('withdrawStatus');

  let rewardPerAd = 10;
  let adHandlerReady = false;
  let currentProvider = null; // 'monetag' | 'adsgram' | null
  let showAdFn = null; // Monetag's global show_<zone> function
  let adsgramController = null; // Adsgram's controller object

  init();

  async function init() {
    const config = await api('/api/config');
    rewardPerAd = config.rewardPerAd;

    if (config.adProvider === 'adsgram' && config.adsgramBlockId) {
      currentProvider = 'adsgram';
      loadAdsgramSdk(config.adsgramBlockId);
    } else if (config.adProvider === 'monetag' && config.monetagZoneId) {
      currentProvider = 'monetag';
      loadMonetagSdk(config.monetagZoneId);
    } else {
      watchBtnLabel.textContent = 'Ads not configured yet';
      watchBtn.disabled = true;
      watchStatus.textContent = 'Set MONETAG_ZONE_ID or ADSGRAM_BLOCK_ID in .env to enable real ads.';
    }

    if (config.botUsername && myUserId) {
      refLinkEl.value = `https://t.me/${config.botUsername}?start=${myUserId}`;
    } else {
      refLinkEl.value = 'Link unavailable — bot still connecting, try again shortly.';
    }

    const session = await api('/api/session', { method: 'POST' });
    if (session) renderUser(session);

    refreshLeaderboard();
    refreshReferralStatus();
  }

  function loadMonetagSdk(zoneId) {
    const fnName = `show_${zoneId}`;
    const script = document.createElement('script');
    script.src = 'https://libtl.com/sdk.js';
    script.setAttribute('data-zone', zoneId);
    script.setAttribute('data-sdk', fnName);
    script.onload = () => {
      showAdFn = window[fnName];
      adHandlerReady = typeof showAdFn === 'function';
      // Preload so the first watch has no delay.
      if (adHandlerReady) showAdFn({ type: 'preload' }).catch(() => {});
    };
    document.head.appendChild(script);
  }

  function loadAdsgramSdk(blockId) {
    const script = document.createElement('script');
    script.src = 'https://sad.adsgram.ai/js/sad.min.js';
    script.onload = () => {
      if (!window.Adsgram) {
        watchStatus.textContent = 'Adsgram SDK failed to load.';
        return;
      }
      adsgramController = window.Adsgram.init({ blockId });
      adHandlerReady = true;
    };
    document.head.appendChild(script);
  }

  // One call, whichever provider is active underneath — this is the only
  // function the click handler below needs to know about.
  function showCurrentAd() {
    if (currentProvider === 'adsgram') return adsgramController.show();
    if (currentProvider === 'monetag') return showAdFn({ ymid: isInsideTelegram ? undefined : devUserId });
    return Promise.reject(new Error('no ad provider configured'));
  }

  function preloadNextMonetagAd() {
    // Monetag benefits from an explicit preload call between watches;
    // Adsgram's controller handles its own fetching internally.
    if (currentProvider === 'monetag' && adHandlerReady) showAdFn({ type: 'preload' }).catch(() => {});
  }

  watchBtn.addEventListener('click', async () => {
    if (!adHandlerReady) {
      watchStatus.textContent = 'Ad is still loading — try again in a moment.';
      return;
    }
    watchBtn.disabled = true;
    watchStatus.textContent = 'Loading ad…';

    try {
      await showCurrentAd();
      watchStatus.textContent = 'Crediting reward…';
      const result = await api('/api/watch-complete', { method: 'POST' });
      if (result?.error === undefined && result?.reason === undefined) {
        renderUser(result);
        watchStatus.textContent = `+${rewardPerAd} points!`;
        refreshLeaderboard();
      } else {
        watchStatus.textContent = describeLimit(result);
      }
    } catch {
      watchStatus.textContent = 'Ad was skipped or failed — no reward this time.';
    } finally {
      watchBtn.disabled = false;
      preloadNextMonetagAd();
    }
  });

  tabActivity.addEventListener('click', () => switchTab('activity'));
  tabLeaderboard.addEventListener('click', () => switchTab('leaderboard'));
  tabWithdraw.addEventListener('click', () => switchTab('withdraw'));

  function switchTab(name) {
    const tabs = { activity: tabActivity, leaderboard: tabLeaderboard, withdraw: tabWithdraw };
    const panels = { activity: panelActivity, leaderboard: panelLeaderboard, withdraw: panelWithdraw };

    for (const key of Object.keys(tabs)) {
      const isActive = key === name;
      tabs[key].classList.toggle('is-active', isActive);
      tabs[key].setAttribute('aria-selected', String(isActive));
      panels[key].classList.toggle('is-hidden', !isActive);
    }
  }

  let lastBalance = null;

  function renderUser(user) {
    balanceEl.textContent = user.balance;
    balanceSubEl.textContent = `points earned · ${user.adsWatchedToday} ads today`;
    updateRing(user.balance);

    if (lastBalance !== null && user.balance > lastBalance) {
      coinIconEl.classList.remove('is-spinning');
      // Restart the animation even if it's already mid-flight.
      void coinIconEl.offsetWidth;
      coinIconEl.classList.add('is-spinning');
    }
    lastBalance = user.balance;

    if (!user.history || user.history.length === 0) {
      activityList.innerHTML = '<li class="empty">No ads watched yet — your history shows up here.</li>';
      return;
    }
    activityList.innerHTML = user.history
      .map(
        (h) => `<li>
          <span class="row-left">
            <span class="row-badge">¢</span>
            <span class="row-name">${formatTime(h.at)}</span>
          </span>
          <span class="row-value">+${h.amount}</span>
        </li>`
      )
      .join('');
  }

  function updateRing(balance) {
    const CIRCUMFERENCE = 389.6; // 2 * PI * 62, matches the SVG radius in CSS
    const progress = (balance % MILESTONE_STEP) / MILESTONE_STEP;
    const offset = CIRCUMFERENCE * (1 - progress);
    ringProgressEl.style.strokeDashoffset = String(offset);

    const remaining = MILESTONE_STEP - (balance % MILESTONE_STEP);
    milestoneLabelEl.textContent =
      balance === 0 ? `${MILESTONE_STEP} points to your first milestone` : `${remaining} points to next milestone`;
  }

  async function refreshLeaderboard() {
    const rows = await api('/api/leaderboard');
    if (!rows || rows.length === 0) {
      leaderboardList.innerHTML = '<li class="empty">No one on the board yet — be first.</li>';
      return;
    }
    leaderboardList.innerHTML = rows
      .map(
        (r, i) => `<li>
          <span class="row-left">
            <span class="row-badge">${i + 1}</span>
            <span class="row-name">${escapeHtml(r.name)}</span>
          </span>
          <span class="row-value">${r.balance}</span>
        </li>`
      )
      .join('');
  }

  async function refreshReferralStatus() {
    const status = await api('/api/referral-status', { method: 'POST' });
    if (!status || status.error) return;

    inviteProgressEl.textContent = `${status.invitedCount}/${status.requiredInvites}`;
    qualifyProgressEl.textContent = `${status.qualifyingCount}/${status.requiredQualifyingInvites}`;
    withdrawRuleEl.textContent =
      `Invite ${status.requiredInvites} friends, and get at least ${status.requiredQualifyingInvites} of them to ` +
      `watch ${status.qualifyingAdsThreshold}+ ads each, to unlock withdrawing your balance.`;

    if (status.latestRequestStatus === 'paid') {
      withdrawBtn.disabled = true;
      withdrawBtnLabel.textContent = 'Already paid out';
    } else if (status.hasPendingRequest) {
      withdrawBtn.disabled = true;
      withdrawBtnLabel.textContent = 'Withdrawal pending review';
    } else if (status.eligible) {
      withdrawBtn.disabled = false;
      withdrawBtnLabel.textContent = 'Request withdrawal';
    } else {
      withdrawBtn.disabled = true;
      withdrawBtnLabel.textContent = 'Invite more friends to unlock';
    }
  }

  copyRefBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(refLinkEl.value);
    } catch {
      refLinkEl.select();
      document.execCommand('copy');
    }
    withdrawStatus.textContent = 'Link copied!';
    setTimeout(() => {
      if (withdrawStatus.textContent === 'Link copied!') withdrawStatus.textContent = '';
    }, 2000);
  });

  withdrawBtn.addEventListener('click', async () => {
    withdrawBtn.disabled = true;
    withdrawStatus.textContent = 'Submitting request…';

    const result = await api('/api/withdraw-request', { method: 'POST' });

    if (result && !result.error) {
      withdrawStatus.textContent = `Requested — ${result.etb} ETB. We'll reach out to send it.`;
      withdrawBtnLabel.textContent = 'Withdrawal pending review';
    } else if (result?.reason === 'already_pending') {
      withdrawStatus.textContent = 'You already have a pending request.';
      withdrawBtnLabel.textContent = 'Withdrawal pending review';
    } else {
      withdrawStatus.textContent = 'Could not submit — try again shortly.';
      withdrawBtn.disabled = false;
    }
  });

  function describeLimit(result) {
    if (result?.reason === 'too_soon') return `Wait ${result.waitSeconds}s before the next ad.`;
    if (result?.reason === 'daily_limit_reached') return "You've hit today's ad limit — come back tomorrow.";
    return 'Could not credit reward right now.';
  }

  function applyTelegramTheme(tg) {
    const p = tg.themeParams || {};
    const root = document.documentElement.style;
    if (p.bg_color) root.setProperty('--tg-bg', p.bg_color);
    if (p.secondary_bg_color) root.setProperty('--tg-surface', p.secondary_bg_color);
    if (p.text_color) root.setProperty('--tg-text', p.text_color);
    if (p.hint_color) root.setProperty('--tg-hint', p.hint_color);
    if (p.button_color) root.setProperty('--tg-button', p.button_color);
    if (p.button_text_color) root.setProperty('--tg-button-text', p.button_text_color);
  }

  async function api(pathname, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (initData) headers['X-Telegram-Init-Data'] = initData;

    const body = opts.method === 'POST' ? JSON.stringify({ devUserId, ref: refParam }) : undefined;

    try {
      const res = await fetch(pathname, { ...opts, headers, body });
      return await res.json();
    } catch {
      return null;
    }
  }

  function getOrCreateDevId() {
    let id = localStorage.getItem('devUserId');
    if (!id) {
      id = 'dev-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('devUserId', id);
    }
    return id;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
