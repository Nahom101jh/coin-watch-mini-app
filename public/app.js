(function () {
  const tg = window.Telegram?.WebApp;
  let initData = '';

  if (tg) {
    tg.ready();
    tg.expand();
    initData = tg.initData || '';
    applyTelegramTheme(tg);
  }

  // Haptics are a no-op outside real Telegram (tg.HapticFeedback won't
  // exist), so every call here is safe to fire unconditionally.
  function hapticTap(style = 'light') {
    tg?.HapticFeedback?.impactOccurred?.(style);
  }
  function hapticResult(type) {
    tg?.HapticFeedback?.notificationOccurred?.(type);
  }
  function hapticSelect() {
    tg?.HapticFeedback?.selectionChanged?.();
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
  let currentProvider = null; // 'monetag' | 'adsgram' | null — the PRIMARY network only
  let showAdFn = null; // Monetag's global show_<zone> function
  let adsgramController = null; // Adsgram's controller object

  // Tads (https://tads.me) is a fallback network, not a competing primary —
  // it's tried only when the primary provider above has no ad to show, so
  // it's tracked separately rather than as a third currentProvider value.
  let tadsWidgetId = null;
  let tadsReady = false;

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
    } else if (!config.tadsWidgetId) {
      // Only show the "not configured" message if there's truly no
      // provider at all — if Tads is set but the primary isn't, Tads
      // alone is enough to enable the button (see showCurrentAd below).
      watchBtnLabel.textContent = 'Ads not configured yet';
      watchBtn.disabled = true;
      watchStatus.textContent = 'Set MONETAG_ZONE_ID, ADSGRAM_BLOCK_ID or TADS_WIDGET_ID in .env to enable real ads.';
    }

    if (config.tadsWidgetId) {
      tadsWidgetId = config.tadsWidgetId;
      loadTadsSdk();
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

  function loadTadsSdk() {
    const script = document.createElement('script');
    script.src = 'https://w.tads.me/widget.js';
    script.onload = () => {
      tadsReady = Boolean(window.tads?.init);
      // If there's no primary provider at all, Tads alone should enable
      // the button — mirrors the adHandlerReady flag the primary networks set.
      if (tadsReady && !currentProvider) {
        adHandlerReady = true;
        watchBtnLabel.textContent = 'Watch Ad';
        watchBtn.disabled = false;
      }
    };
    document.head.appendChild(script);
  }

  // Fullscreen Banner: rewards on view, one ad per call — matches this
  // button's "watch one ad, get paid" flow. A fresh controller each call
  // because fullscreen widgets are meant to show once per view, not be reused.
  function tryTadsAd() {
    if (!tadsReady || !window.tads?.init) return Promise.reject(new Error('tads_not_ready'));

    return new Promise((resolve, reject) => {
      const controller = window.tads.init({
        widgetId: tadsWidgetId,
        type: 'fullscreen',
        debug: false,
        onShowReward: () => resolve(),
        onAdsNotFound: () => reject(new Error('tads_no_ad')),
      });
      // Tads' own docs are inconsistent about whether init() returns a
      // controller with .loadAd()/.showAd() or a promise-like — handle both.
      Promise.resolve(controller.loadAd ? controller.loadAd() : controller)
        .then(() => (controller.showAd ? controller.showAd() : null))
        .catch(reject);
    });
  }

  // Tries the primary provider first; falls back to Tads only if the
  // primary has no fill (or there is no primary at all). Returns which
  // network actually served the ad, so the click handler below knows
  // whether to claim the reward itself (primary) or wait for Tads' own
  // server-to-server webhook to credit it instead (see caller).
  async function showCurrentAd() {
    if (currentProvider === 'adsgram') {
      try {
        await withTimeout(adsgramController.show(), AD_TIMEOUT_MS);
        return 'primary';
      } catch (err) {
        if (!tadsReady) throw err;
      }
    } else if (currentProvider === 'monetag') {
      try {
        await withTimeout(showAdFn({ ymid: isInsideTelegram ? undefined : devUserId }), AD_TIMEOUT_MS);
        return 'primary';
      } catch (err) {
        if (!tadsReady) throw err;
      }
    } else if (!tadsReady) {
      throw new Error('no ad provider configured');
    }

    await withTimeout(tryTadsAd(), AD_TIMEOUT_MS);
    return 'tads';
  }

  const AD_TIMEOUT_MS = 20000;

  // A legitimate "no ad available" outcome doesn't always resolve or reject
  // the ad SDK's promise — it can just hang. Without this, the button would
  // stay stuck on "Loading ad…" forever any time an auction has no fill,
  // which is a normal, common outcome, not an error.
  function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('ad_timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function preloadNextMonetagAd() {
    // Monetag benefits from an explicit preload call between watches;
    // Adsgram's controller handles its own fetching internally.
    if (currentProvider === 'monetag' && adHandlerReady) showAdFn({ type: 'preload' }).catch(() => {});
  }

  // Tads' webhook usually lands within a second or two of the ad finishing,
  // but there's no guarantee of exactly when — so poll a few times rather
  // than assuming it's already landed the instant showAd() resolves.
  async function waitForTadsCredit(attempts = 5, delayMs = 1500) {
    const before = lastBalance ?? 0;
    for (let i = 0; i < attempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      const session = await api('/api/session', { method: 'POST' });
      if (session && session.balance > before) {
        renderUser(session);
        watchStatus.textContent = `+${session.balance - before} points!`;
        hapticResult('success');
        refreshLeaderboard();
        return;
      }
    }
    watchStatus.textContent = "Reward is still processing — it'll show up shortly.";
  }

  watchBtn.addEventListener('click', async () => {
    if (!adHandlerReady) {
      watchStatus.textContent = 'Ad is still loading — try again in a moment.';
      return;
    }
    hapticTap('light');
    watchBtn.disabled = true;
    watchStatus.textContent = 'Loading ad…';

    try {
      const source = await showCurrentAd();

      if (source === 'primary') {
        watchStatus.textContent = 'Crediting reward…';
        const result = await api('/api/watch-complete', { method: 'POST' });
        if (result?.error === undefined && result?.reason === undefined) {
          renderUser(result);
          watchStatus.textContent = `+${rewardPerAd} points!`;
          hapticResult('success');
          refreshLeaderboard();
        } else {
          watchStatus.textContent = describeLimit(result);
          hapticResult('warning');
        }
      } else {
        // Tads credits server-side via its own webhook (see server/index.js
        // /api/tads-webhook), not via a call from here — calling
        // /api/watch-complete now too would double-credit the same view.
        // Poll briefly for the balance to actually change instead.
        watchStatus.textContent = 'Confirming reward…';
        await waitForTadsCredit();
      }
    } catch (err) {
      console.warn('[ad]', err);
      watchStatus.textContent = 'No ad available right now — please try again in a moment.';
      hapticResult('error');
    } finally {
      watchBtn.disabled = false;
      preloadNextMonetagAd();
    }
  });

  tabActivity.addEventListener('click', () => switchTab('activity'));
  tabLeaderboard.addEventListener('click', () => switchTab('leaderboard'));
  tabWithdraw.addEventListener('click', () => switchTab('withdraw'));

  let activeTab = 'activity';

  function switchTab(name) {
    if (name === activeTab) return;
    hapticSelect();
    activeTab = name;

    const tabs = { activity: tabActivity, leaderboard: tabLeaderboard, withdraw: tabWithdraw };
    const panels = { activity: panelActivity, leaderboard: panelLeaderboard, withdraw: panelWithdraw };

    for (const key of Object.keys(tabs)) {
      const isActive = key === name;
      tabs[key].classList.toggle('is-active', isActive);
      tabs[key].setAttribute('aria-selected', String(isActive));
      panels[key].classList.toggle('is-hidden', !isActive);
      if (isActive) {
        panels[key].classList.remove('panel-enter');
        void panels[key].offsetWidth; // restart the animation each time
        panels[key].classList.add('panel-enter');
      }
    }
  }

  let lastBalance = null;

  function renderUser(user) {
    balanceEl.classList.remove('is-loading');
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

    inviteProgressEl.classList.remove('is-loading');
    qualifyProgressEl.classList.remove('is-loading');
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
    hapticResult('success');
    withdrawStatus.textContent = 'Link copied!';
    setTimeout(() => {
      if (withdrawStatus.textContent === 'Link copied!') withdrawStatus.textContent = '';
    }, 2000);
  });

  withdrawBtn.addEventListener('click', async () => {
    hapticTap('medium');
    withdrawBtn.disabled = true;
    withdrawStatus.textContent = 'Submitting request…';

    const result = await api('/api/withdraw-request', { method: 'POST' });

    if (result && !result.error) {
      hapticResult('success');
      withdrawStatus.textContent = `Requested — ${result.etb} ETB. We'll reach out to send it.`;
      withdrawBtnLabel.textContent = 'Withdrawal pending review';
    } else if (result?.reason === 'already_pending') {
      hapticResult('warning');
      withdrawStatus.textContent = 'You already have a pending request.';
      withdrawBtnLabel.textContent = 'Withdrawal pending review';
    } else {
      hapticResult('error');
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

    const body = opts.method === 'POST' ? JSON.stringify({ devUserId }) : undefined;

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
