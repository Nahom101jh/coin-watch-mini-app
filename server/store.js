// Minimal file-based store. No database server to install — good fit for a
// school project. Swap this module out for a real DB later without touching
// the API routes, since everything goes through the functions below.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.json');

// Withdrawal eligibility rules — change these numbers here and everything
// (API, frontend copy) reads from this single source of truth.
const REQUIRED_INVITES = 15;
const REQUIRED_QUALIFYING_INVITES = 5;
const QUALIFYING_ADS_THRESHOLD = 50;
const POINTS_PER_ETB = 1;

function load() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: {}, events: [], withdrawalRequests: [] };
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.events) db.events = [];
    if (!db.withdrawalRequests) db.withdrawalRequests = [];

    // Upgrade any user records saved before referrals existed, so old data
    // never crashes new code — missing fields just default to empty.
    for (const user of Object.values(db.users || {})) {
      if (!Array.isArray(user.invitedUserIds)) user.invitedUserIds = [];
      if (user.referredBy === undefined) user.referredBy = null;
    }

    return db;
  } catch {
    return { users: {}, events: [], withdrawalRequests: [] };
  }
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getOrCreateUser(id, name, referredBy) {
  const db = load();
  if (!db.users[id]) {
    db.users[id] = {
      id,
      name: name || `User ${id}`,
      balance: 0,
      adsWatchedTotal: 0,
      adsWatchedToday: 0,
      lastAdDay: todayKey(),
      lastAdAt: 0,
      history: [], // recent reward events, newest first
      referredBy: null,
      invitedUserIds: [],
    };

    // Only link the referral once, at creation, and never let someone be
    // credited as their own referrer.
    if (referredBy && referredBy !== id && db.users[referredBy]) {
      db.users[id].referredBy = referredBy;
      const referrer = db.users[referredBy];
      if (!referrer.invitedUserIds.includes(id)) referrer.invitedUserIds.push(id);
    }

    save(db);
  }
  return db.users[id];
}

function getUser(id) {
  const db = load();
  return db.users[id] || null;
}

// Returns { ok: true, user } or { ok: false, reason }
function creditAdReward(id, amount, { maxPerDay, minSecondsBetween }) {
  const db = load();
  const user = db.users[id];
  if (!user) return { ok: false, reason: 'unknown_user' };

  const today = todayKey();
  if (user.lastAdDay !== today) {
    user.lastAdDay = today;
    user.adsWatchedToday = 0;
  }

  const secondsSinceLast = (Date.now() - user.lastAdAt) / 1000;
  if (user.lastAdAt && secondsSinceLast < minSecondsBetween) {
    return { ok: false, reason: 'too_soon', waitSeconds: Math.ceil(minSecondsBetween - secondsSinceLast) };
  }

  if (user.adsWatchedToday >= maxPerDay) {
    return { ok: false, reason: 'daily_limit_reached' };
  }

  user.balance += amount;
  user.adsWatchedTotal += 1;
  user.adsWatchedToday += 1;
  user.lastAdAt = Date.now();
  user.history.unshift({ at: new Date().toISOString(), amount });
  user.history = user.history.slice(0, 20);

  db.users[id] = user;
  db.events.unshift({ at: new Date().toISOString(), userId: id, name: user.name, amount });
  db.events = db.events.slice(0, 200); // keep the log bounded

  save(db);
  return { ok: true, user };
}

function getLeaderboard(limit = 10) {
  const db = load();
  return Object.values(db.users)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit)
    .map((u) => ({ name: u.name, balance: u.balance }));
}

function getRecentEvents(limit = 20) {
  const db = load();
  return db.events.slice(0, limit);
}

function getStats() {
  const db = load();
  const users = Object.values(db.users);
  const today = todayKey();

  return {
    totalUsers: users.length,
    totalPointsIssued: users.reduce((sum, u) => sum + u.balance, 0),
    totalAdsWatched: users.reduce((sum, u) => sum + u.adsWatchedTotal, 0),
    adsWatchedToday: users.reduce((sum, u) => sum + (u.lastAdDay === today ? u.adsWatchedToday : 0), 0),
    activeUsersToday: users.filter((u) => u.lastAdDay === today && u.adsWatchedToday > 0).length,
  };
}

function getReferralStatus(id) {
  const db = load();
  const user = db.users[id];
  if (!user) return null;

  const invited = user.invitedUserIds.map((uid) => db.users[uid]).filter(Boolean);
  const qualifyingCount = invited.filter((u) => u.adsWatchedTotal >= QUALIFYING_ADS_THRESHOLD).length;
  const invitedCount = invited.length;
  const eligible = invitedCount >= REQUIRED_INVITES && qualifyingCount >= REQUIRED_QUALIFYING_INVITES;

  const myRequests = db.withdrawalRequests.filter((r) => r.userId === id);
  const pending = myRequests.find((r) => r.status === 'pending') || null;
  const latest = myRequests[myRequests.length - 1] || null;

  return {
    invitedCount,
    qualifyingCount,
    requiredInvites: REQUIRED_INVITES,
    requiredQualifyingInvites: REQUIRED_QUALIFYING_INVITES,
    qualifyingAdsThreshold: QUALIFYING_ADS_THRESHOLD,
    pointsPerEtb: POINTS_PER_ETB,
    eligible,
    hasPendingRequest: Boolean(pending),
    latestRequestStatus: latest ? latest.status : null,
  };
}

// Returns { ok: true, request } or { ok: false, reason }
function requestWithdrawal(id) {
  const db = load();
  const user = db.users[id];
  if (!user) return { ok: false, reason: 'unknown_user' };

  const status = getReferralStatus(id);
  if (!status.eligible) return { ok: false, reason: 'not_eligible' };
  if (status.hasPendingRequest) return { ok: false, reason: 'already_pending' };

  const request = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    userId: id,
    name: user.name,
    points: user.balance,
    etb: user.balance * POINTS_PER_ETB,
    at: new Date().toISOString(),
    status: 'pending',
  };
  db.withdrawalRequests.push(request);
  save(db);
  return { ok: true, request };
}

function listWithdrawalRequests() {
  const db = load();
  return [...db.withdrawalRequests].reverse(); // newest first
}

function setWithdrawalStatus(requestId, status) {
  const db = load();
  const request = db.withdrawalRequests.find((r) => r.id === requestId);
  if (!request) return null;
  request.status = status;
  save(db);
  return request;
}

module.exports = {
  getOrCreateUser,
  getUser,
  creditAdReward,
  getLeaderboard,
  getRecentEvents,
  getStats,
  getReferralStatus,
  requestWithdrawal,
  listWithdrawalRequests,
  setWithdrawalStatus,
};
