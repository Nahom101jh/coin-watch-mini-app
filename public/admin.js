(function () {
  const gate = document.getElementById('gate');
  const dashboard = document.getElementById('dashboard');
  const keyInput = document.getElementById('keyInput');
  const unlockBtn = document.getElementById('unlockBtn');
  const gateError = document.getElementById('gateError');

  const statGrid = document.getElementById('statGrid');
  const barChart = document.getElementById('barChart');
  const leaderboardList = document.getElementById('leaderboardList');
  const withdrawalsList = document.getElementById('withdrawalsList');
  const eventsList = document.getElementById('eventsList');

  const editUserId = document.getElementById('editUserId');
  const editUserName = document.getElementById('editUserName');
  const editUserBalance = document.getElementById('editUserBalance');
  const editUserBtn = document.getElementById('editUserBtn');
  const editUserStatus = document.getElementById('editUserStatus');

  const savedKey = sessionStorage.getItem('adminKey');
  if (savedKey) tryUnlock(savedKey);

  unlockBtn.addEventListener('click', () => tryUnlock(keyInput.value.trim()));
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryUnlock(keyInput.value.trim());
  });

  async function tryUnlock(key) {
    if (!key) return;
    gateError.textContent = '';

    const res = await fetch('/api/admin/stats', { headers: { 'X-Admin-Key': key } });

    if (res.status === 401) {
      gateError.textContent = 'Wrong key — check your .env ADMIN_KEY.';
      sessionStorage.removeItem('adminKey');
      return;
    }
    if (res.status === 503) {
      gateError.textContent = 'ADMIN_KEY is not set on the server yet.';
      return;
    }
    if (!res.ok) {
      gateError.textContent = 'Could not load stats — is the server running?';
      return;
    }

    sessionStorage.setItem('adminKey', key);
    gate.classList.add('is-hidden');
    dashboard.classList.remove('is-hidden');

    const data = await res.json();
    render(data);
  }

  function render({ stats, leaderboard, recentEvents, withdrawalRequests }) {
    statGrid.innerHTML = [
      ['Total users', stats.totalUsers],
      ['Active today', stats.activeUsersToday],
      ['Points issued (all time)', stats.totalPointsIssued],
      ['Ads watched (all time)', stats.totalAdsWatched],
    ]
      .map(
        ([label, value]) => `<div class="stat-tile">
          <div class="stat-value">${value}</div>
          <div class="stat-label">${label}</div>
        </div>`
      )
      .join('');

    renderBarChart(recentEvents);
    renderWithdrawals(withdrawalRequests || []);

    leaderboardList.innerHTML =
      leaderboard.length === 0
        ? '<li class="empty">No one on the board yet.</li>'
        : leaderboard
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

    eventsList.innerHTML =
      recentEvents.length === 0
        ? '<li class="empty">No activity yet.</li>'
        : recentEvents
            .slice(0, 15)
            .map(
              (e) => `<li>
                <span class="row-left">
                  <span class="row-badge">¢</span>
                  <span class="row-name">${escapeHtml(e.name)} · ${formatTime(e.at)}</span>
                </span>
                <span class="row-value">+${e.amount}</span>
              </li>`
            )
            .join('');
  }

  function renderWithdrawals(requests) {
    if (requests.length === 0) {
      withdrawalsList.innerHTML = '<li class="empty">No withdrawal requests yet.</li>';
      return;
    }

    withdrawalsList.innerHTML = requests
      .map((r) => {
        const statusLabel = r.status === 'pending' ? '⏳ pending' : r.status === 'paid' ? '✅ paid' : '❌ rejected';
        const actions =
          r.status === 'pending'
            ? `<button class="mark-paid-btn" data-id="${r.id}">Mark paid</button>`
            : `<span class="row-status">${statusLabel}</span>`;

        return `<li>
          <span class="row-left">
            <span class="row-badge">¢</span>
            <span class="row-name">${escapeHtml(r.name)} · ${r.etb} ETB · ${formatTime(r.at)}</span>
          </span>
          ${actions}
        </li>`;
      })
      .join('');

    withdrawalsList.querySelectorAll('.mark-paid-btn').forEach((btn) => {
      btn.addEventListener('click', () => markPaid(btn.dataset.id));
    });
  }

  async function markPaid(requestId) {
    const key = sessionStorage.getItem('adminKey');
    const res = await fetch(`/api/admin/withdrawals/${requestId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ status: 'paid' }),
    });
    if (res.ok) tryUnlock(key); // refetch and re-render everything
  }

  editUserBtn.addEventListener('click', async () => {
    const id = editUserId.value.trim();
    if (!id) {
      editUserStatus.textContent = 'Enter a user ID first.';
      return;
    }

    const body = {};
    if (editUserName.value.trim()) body.name = editUserName.value.trim();
    if (editUserBalance.value.trim()) body.balance = Number(editUserBalance.value);

    editUserBtn.disabled = true;
    editUserStatus.textContent = 'Saving…';

    const key = sessionStorage.getItem('adminKey');
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify(body),
    });

    editUserBtn.disabled = false;

    if (res.ok) {
      const updated = await res.json();
      editUserStatus.textContent = `Saved — ${updated.name} now has ${updated.balance} points.`;
      editUserName.value = '';
      editUserBalance.value = '';
      tryUnlock(key); // refresh the leaderboard/stats to reflect the change
    } else {
      editUserStatus.textContent = 'Could not save — check the values and try again.';
    }
  });

  function renderBarChart(events) {
    const days = lastNDays(7);
    const counts = days.map((day) => events.filter((e) => e.at.startsWith(day)).length);
    const max = Math.max(...counts, 1);

    if (events.length === 0) {
      barChart.innerHTML = '<div class="bar-empty">No ads watched yet this week.</div>';
      return;
    }

    barChart.innerHTML = days
      .map((day, i) => {
        const heightPct = Math.max((counts[i] / max) * 100, counts[i] > 0 ? 6 : 0);
        return `<div class="bar" style="height:${heightPct}%" title="${day}: ${counts[i]}"></div>`;
      })
      .join('');
  }

  function lastNDays(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
