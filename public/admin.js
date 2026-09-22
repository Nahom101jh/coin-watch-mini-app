(function () {
  const gate = document.getElementById('gate');
  const dashboard = document.getElementById('dashboard');
  const keyInput = document.getElementById('keyInput');
  const unlockBtn = document.getElementById('unlockBtn');
  const gateError = document.getElementById('gateError');
  const toastStack = document.getElementById('toastStack');

  const navItems = document.querySelectorAll('.nav-item');
  const sections = document.querySelectorAll('.admin-section');

  const statGrid = document.getElementById('statGrid');
  const barChart = document.getElementById('barChart');
  const leaderboardBody = document.getElementById('leaderboardBody');
  const leaderboardSearch = document.getElementById('leaderboardSearch');
  const withdrawalsBody = document.getElementById('withdrawalsBody');
  const withdrawalSearch = document.getElementById('withdrawalSearch');
  const withdrawalFilter = document.getElementById('withdrawalFilter');
  const eventsBody = document.getElementById('eventsBody');

  const editUserId = document.getElementById('editUserId');
  const editUserName = document.getElementById('editUserName');
  const editUserBalance = document.getElementById('editUserBalance');
  const editUserBtn = document.getElementById('editUserBtn');
  const editUserStatus = document.getElementById('editUserStatus');

  // Keep the last fetched data around so search/filter can re-render
  // instantly without a round trip.
  let latest = { stats: null, leaderboard: [], recentEvents: [], withdrawalRequests: [] };

  // --- Section navigation ---
  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.section;
      navItems.forEach((n) => n.classList.toggle('is-active', n === btn));
      sections.forEach((s) => s.classList.toggle('is-hidden', s.id !== `section-${name}`));
    });
  });

  // --- Unlock ---
  const savedKey = sessionStorage.getItem('adminKey');
  if (savedKey) tryUnlock(savedKey);

  unlockBtn.addEventListener('click', () => tryUnlock(keyInput.value.trim()));
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryUnlock(keyInput.value.trim());
  });

  async function tryUnlock(key) {
    if (!key) return;
    gateError.textContent = '';
    unlockBtn.disabled = true;
    unlockBtn.textContent = 'Unlocking…';

    let res;
    try {
      res = await fetch('/api/admin/stats', { headers: { 'X-Admin-Key': key } });
    } catch {
      gateError.textContent = 'Could not reach the server — check your connection.';
      unlockBtn.disabled = false;
      unlockBtn.textContent = 'Unlock';
      return;
    }

    if (res.status === 401) {
      gateError.textContent = 'Wrong key — check your .env ADMIN_KEY.';
      sessionStorage.removeItem('adminKey');
      unlockBtn.disabled = false;
      unlockBtn.textContent = 'Unlock';
      return;
    }
    if (res.status === 503) {
      gateError.textContent = 'ADMIN_KEY is not set on the server yet.';
      unlockBtn.disabled = false;
      unlockBtn.textContent = 'Unlock';
      return;
    }
    if (!res.ok) {
      gateError.textContent = 'Could not load stats — is the server running?';
      unlockBtn.disabled = false;
      unlockBtn.textContent = 'Unlock';
      return;
    }

    sessionStorage.setItem('adminKey', key);
    gate.classList.add('is-hidden');
    dashboard.classList.remove('is-hidden');

    const data = await res.json();
    latest = { ...latest, ...data };
    renderAll();

    unlockBtn.disabled = false;
    unlockBtn.textContent = 'Unlock';
  }

  async function refreshData() {
    const key = sessionStorage.getItem('adminKey');
    const res = await fetch('/api/admin/stats', { headers: { 'X-Admin-Key': key } });
    if (!res.ok) return;
    const data = await res.json();
    latest = { ...latest, ...data };
    renderAll();
  }

  function renderAll() {
    renderStats(latest.stats);
    renderBarChart(latest.recentEvents || []);
    renderLeaderboardTable();
    renderWithdrawalsTable();
    renderEventsTable(latest.recentEvents || []);
  }

  function renderStats(stats) {
    if (!stats) return;
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
  }

  // --- Leaderboard table + search ---
  function filterByName(list, query) {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((item) => item.name.toLowerCase().includes(q));
  }

  leaderboardSearch.addEventListener('input', renderLeaderboardTable);

  function renderLeaderboardTable() {
    const rows = filterByName(latest.leaderboard || [], leaderboardSearch.value);

    if (rows.length === 0) {
      leaderboardBody.innerHTML = `<tr><td colspan="3" class="empty-state">${
        (latest.leaderboard || []).length === 0 ? 'No one on the board yet.' : 'No names match your search.'
      }</td></tr>`;
      return;
    }

    leaderboardBody.innerHTML = rows
      .map((r, i) => {
        const rank = i + 1;
        return `<tr>
          <td><span class="rank ${rank <= 3 ? 'is-top3' : ''}">${rank}</span></td>
          <td>${escapeHtml(r.name)}</td>
          <td class="num">${r.balance}</td>
        </tr>`;
      })
      .join('');
  }

  // --- Withdrawals table + search/filter ---
  withdrawalSearch.addEventListener('input', renderWithdrawalsTable);
  withdrawalFilter.addEventListener('change', renderWithdrawalsTable);

  function statusBadge(status) {
    const label = status === 'pending' ? 'Pending' : status === 'paid' ? 'Paid' : 'Rejected';
    const cls = status === 'pending' ? 'badge-pending' : status === 'paid' ? 'badge-paid' : 'badge-rejected';
    return `<span class="badge ${cls}"><span class="badge-dot"></span>${label}</span>`;
  }

  function renderWithdrawalsTable() {
    let rows = filterByName(latest.withdrawalRequests || [], withdrawalSearch.value);
    const statusValue = withdrawalFilter.value;
    if (statusValue !== 'all') rows = rows.filter((r) => r.status === statusValue);

    if (rows.length === 0) {
      withdrawalsBody.innerHTML = `<tr><td colspan="5" class="empty-state">${
        (latest.withdrawalRequests || []).length === 0 ? 'No withdrawal requests yet.' : 'Nothing matches your filters.'
      }</td></tr>`;
      return;
    }

    withdrawalsBody.innerHTML = rows
      .map((r) => {
        const action =
          r.status === 'pending'
            ? `<button class="btn btn-secondary mark-paid-btn" data-id="${r.id}" data-name="${escapeHtml(r.name)}" data-etb="${r.etb}">Mark paid</button>`
            : '';
        return `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td class="num">${r.etb}</td>
          <td>${formatTime(r.at)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>${action}</td>
        </tr>`;
      })
      .join('');

    withdrawalsBody.querySelectorAll('.mark-paid-btn').forEach((btn) => {
      btn.addEventListener('click', () => confirmMarkPaid(btn.dataset.id, btn.dataset.name, btn.dataset.etb, btn));
    });
  }

  async function confirmMarkPaid(requestId, name, etb, buttonEl) {
    const ok = await showConfirm({
      title: 'Mark this withdrawal as paid?',
      body: `This confirms you've already sent ${etb} ETB to ${name} outside the app. This can't be undone here.`,
      confirmLabel: 'Mark paid',
    });
    if (!ok) return;

    buttonEl.disabled = true;
    buttonEl.textContent = 'Saving…';

    const key = sessionStorage.getItem('adminKey');
    const res = await fetch(`/api/admin/withdrawals/${requestId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify({ status: 'paid' }),
    });

    if (res.ok) {
      showToast(`Marked ${name}'s withdrawal as paid.`, 'success');
      refreshData();
    } else {
      showToast('Could not update — try again.', 'error');
      buttonEl.disabled = false;
      buttonEl.textContent = 'Mark paid';
    }
  }

  // --- Recent activity table ---
  function renderEventsTable(events) {
    const rows = events.slice(0, 20);
    if (rows.length === 0) {
      eventsBody.innerHTML = '<tr><td colspan="3" class="empty-state">No activity yet.</td></tr>';
      return;
    }
    eventsBody.innerHTML = rows
      .map(
        (e) => `<tr>
          <td>${escapeHtml(e.name)}</td>
          <td class="num">+${e.amount}</td>
          <td>${formatTime(e.at)}</td>
        </tr>`
      )
      .join('');
  }

  // --- Edit user ---
  editUserBtn.addEventListener('click', async () => {
    const id = editUserId.value.trim();
    if (!id) {
      editUserStatus.textContent = 'Enter a user ID first.';
      return;
    }

    const name = editUserName.value.trim();
    const balanceRaw = editUserBalance.value.trim();
    const body = {};
    if (name) body.name = name;
    if (balanceRaw) body.balance = Number(balanceRaw);

    if (Object.keys(body).length === 0) {
      editUserStatus.textContent = 'Enter a new name or balance to save.';
      return;
    }

    const summary = [name ? `name to "${name}"` : null, balanceRaw ? `balance to ${balanceRaw}` : null]
      .filter(Boolean)
      .join(' and ');

    const ok = await showConfirm({
      title: 'Save this change?',
      body: `This sets ${summary} for user "${id}", overwriting the stored value directly.`,
      confirmLabel: 'Save',
    });
    if (!ok) return;

    editUserStatus.textContent = '';
    editUserBtn.disabled = true;
    editUserBtn.textContent = 'Saving…';

    const key = sessionStorage.getItem('adminKey');
    const res = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
      body: JSON.stringify(body),
    });

    editUserBtn.disabled = false;
    editUserBtn.textContent = 'Save';

    if (res.ok) {
      const updated = await res.json();
      showToast(`Saved — ${updated.name} now has ${updated.balance} points.`, 'success');
      editUserId.value = '';
      editUserName.value = '';
      editUserBalance.value = '';
      refreshData();
    } else {
      editUserStatus.textContent = 'Could not save — check the values and try again.';
    }
  });

  // --- Bar chart ---
  function renderBarChart(events) {
    const days = lastNDays(7);
    const counts = days.map((day) => events.filter((e) => e.at.startsWith(day)).length);
    const max = Math.max(...counts, 1);

    if (events.length === 0) {
      barChart.innerHTML = '<div class="empty-state">No ads watched yet this week.</div>';
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

  // --- Reusable confirm dialog ---
  function showConfirm({ title, body, confirmLabel }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'dialog-backdrop';
      backdrop.innerHTML = `
        <div class="dialog">
          <p class="dialog-title">${escapeHtml(title)}</p>
          <p class="dialog-body">${escapeHtml(body)}</p>
          <div class="dialog-actions">
            <button class="btn btn-secondary" data-action="cancel">Cancel</button>
            <button class="btn btn-primary" data-action="confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>`;

      function close(result) {
        backdrop.remove();
        resolve(result);
      }

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close(false);
      });
      backdrop.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
      backdrop.querySelector('[data-action="confirm"]').addEventListener('click', () => close(true));

      document.body.appendChild(backdrop);
    });
  }

  // --- Reusable toast ---
  function showToast(message, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    toastStack.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 200ms ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    }, 3200);
  }

  function formatTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
