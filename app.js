// 1. Firebase Credentials
const firebaseConfig = {
  apiKey: "AIzaSyC6eDR2AqfSoj-EjoczcnOFX_R1AS1d_8Y",
  authDomain: "parking-lot-registration.firebaseapp.com",
  databaseURL: "https://parking-lot-registration-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "parking-lot-registration",
  storageBucket: "parking-lot-registration.firebasestorage.app",
  messagingSenderId: "1031026900719",
  appId: "1:1031026900719:web:b8642e24d22842e71f251a",
  measurementId: "G-BFCQJ9MC1T"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const PURGE_AFTER_DAYS = 2; // Auto cleanup interval

// App State
let currentUser = localStorage.getItem('parking_user') || null;
let currentRole = localStorage.getItem('parking_role') || 'АЖИЛТАН';
let accountsMap = {};
let activeVehiclesMap = {};
let historyLogMap = {};
let freeVehiclesMap = {};
let listenersStarted = false; // prevents duplicate Firebase listeners

// Checkout "freeze": price and time are locked the moment the exit button is pressed
let checkoutSnapshot = null;
const FREEZE_MAX_MINUTES = 10; // a frozen price is refreshed if the modal stays open longer than this

// Rate settings: first short period, then a price per started hour, with "locks" (caps)
const DEFAULT_RATES = {
  firstMinutes: 10,
  firstFee: 1500,
  hourRate: 3000,
  locks: [
    { until: 720,  price: 20000 },  // price grows until it hits 20000, stays locked until 12h
    { until: 1440, price: 40000 }   // then grows until 40000, locked until 24h
  ]
};

let rates = JSON.parse(JSON.stringify(DEFAULT_RATES));
let locksDraft = DEFAULT_RATES.locks.map(l => ({ ...l }));

// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
const createUserForm = document.getElementById('create-user-form');
const usersTableBody = document.getElementById('users-table-body');
const currentUserDisplay = document.getElementById('current-user-display');
const roleBadge = document.getElementById('role-badge');
const checkinForm = document.getElementById('checkin-form');
const plateInput = document.getElementById('plate-input');
const tableBody = document.getElementById('vehicle-table-body');
const historyBody = document.getElementById('history-table-body');
const activeCount = document.getElementById('active-count');
const adminPanel = document.getElementById('admin-panel');
const qrSection = document.getElementById('qr-section');

// ==========================================
// SHIFT SUMMARY & REPORTS
// ==========================================
const PAYMENT_LABELS = {
  Cash: 'Бэлэн мөнгө',
  Card: 'Карт',
  Transfer: 'Данс',
  Free: 'Үнэгүй'
};

let shiftLogsMap = {};
let shiftListenerRef = null;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

let shiftStartTs = parseInt(localStorage.getItem('parking_shift_start'), 10) || null;

function getShiftStart() {
  return shiftStartTs || startOfToday();
}

// Resume the employee's open shift from Firebase, or start a new one
function loadShiftStart(username) {
  const ref = db.ref(`active_shifts/${username}`);
  return ref.once('value').then((snap) => {
    const saved = snap.val();
    if (saved && saved.start) {
      shiftStartTs = saved.start;            // resume the earlier shift
    } else {
      shiftStartTs = Date.now();             // first login of a new shift
      ref.set({ start: shiftStartTs });
    }
    localStorage.setItem('parking_shift_start', String(shiftStartTs));
  });
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString([], {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

// Listen only to logs since shift start (separate from the "last 3" listener)
function listenShiftLogs() {
  if (!currentUser) return;
  if (shiftListenerRef) shiftListenerRef.off('value');

  shiftListenerRef = db.ref('history_log').orderByChild('timestamp').startAt(getShiftStart());
  shiftListenerRef.on('value', (snap) => {
    shiftLogsMap = snap.val() || {};
    renderShiftSummary();
  });
}

function computeShiftSummary() {
  const summary = {
    Cash: { count: 0, amount: 0 },
    Card: { count: 0, amount: 0 },
    Transfer: { count: 0, amount: 0 },
    Free: { count: 0, amount: 0 }
  };

  Object.values(shiftLogsMap).forEach((r) => {
    if (r.exitStaff !== currentUser) return;
    const method = summary[r.paymentMethod] ? r.paymentMethod : null;
    if (!method) return;
    summary[method].count += 1;
    // Free exits never count as revenue
    if (method !== 'Free') summary[method].amount += Number(r.fee) || 0;
  });

  const total = summary.Cash.amount + summary.Card.amount + summary.Transfer.amount;
  const totalCount = Object.values(summary).reduce((s, x) => s + x.count, 0);
  return { summary, total, totalCount };
}

function renderShiftSummary() {
  const body = document.getElementById('shift-summary-body');
  const label = document.getElementById('shift-start-label');
  if (!body) return;

  label.textContent = `Ээлж эхэлсэн: ${formatDateTime(getShiftStart())}`;

  const { summary, total, totalCount } = computeShiftSummary();
  body.innerHTML = '';

  Object.keys(PAYMENT_LABELS).forEach((m) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${PAYMENT_LABELS[m]}</td>
      <td>${summary[m].count}</td>
      <td><strong>${m === 'Free' ? '—' : '₮' + summary[m].amount.toLocaleString()}</strong></td>
    `;
    body.appendChild(tr);
  });

  const totalRow = document.createElement('tr');
  totalRow.style.background = '#f1f5f9';
  totalRow.innerHTML = `
    <td><strong>НИЙТ</strong></td>
    <td><strong>${totalCount}</strong></td>
    <td><strong>₮${total.toLocaleString()}</strong></td>
  `;
  body.appendChild(totalRow);
}

// ==========================================
// TELEGRAM NOTIFICATION
// ==========================================
const TELEGRAM_BOT_TOKEN = '8909979204:AAH9IQfyZsOf2N0rKSRO51zvivz2E5i7oVU';
const TELEGRAM_CHAT_ID = '8383510896';

function buildReportText(report) {
  const money = (n) => '₮' + (Number(n) || 0).toLocaleString();
  return [
    '📋 Ээлжийн тайлан',
    `👤 Ажилтан: ${report.staff}`,
    `🕒 ${formatDateTime(report.shiftStart)} → ${formatDateTime(report.shiftEnd)}`,
    '',
    `💵 Бэлэн мөнгө: ${money(report.cash)} (${report.counts.cash})`,
    `💳 Карт: ${money(report.card)} (${report.counts.card})`,
    `🏦 Данс: ${money(report.transfer)} (${report.counts.transfer})`,
    `🆓 Үнэгүй: ${report.counts.free} машин`,
    '',
    `💰 НИЙТ: ${money(report.total)}`,
    `🚗 Зогсоолд үлдсэн: ${report.carsStillInside} машин`
  ].join('\n');
}

function sendTelegramReport(report) {
  return fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: buildReportText(report)
    })
  }).then((res) => {
    if (!res.ok) throw new Error('Telegram error ' + res.status);
  });
}

// Send end-of-shift report to Firebase + Telegram
const sendReportBtn = document.getElementById('send-report-btn');
if (sendReportBtn) {
  sendReportBtn.addEventListener('click', () => {
    const { summary, total, totalCount } = computeShiftSummary();

    if (totalCount === 0) {
      alert('Энэ ээлжид гаргасан машин алга байна.');
      return;
    }
    if (!confirm('Ээлжийн тайланг илгээх үү?\nИлгээсний дараа тоолуур шинэчлэгдэнэ.')) return;

    const now = Date.now();
    const report = {
      staff: currentUser,
      shiftStart: getShiftStart(),
      shiftEnd: now,
      cash: summary.Cash.amount,
      card: summary.Card.amount,
      transfer: summary.Transfer.amount,
      total: total,
      counts: {
        cash: summary.Cash.count,
        card: summary.Card.count,
        transfer: summary.Transfer.count,
        free: summary.Free.count
      },
      carsStillInside: Object.keys(activeVehiclesMap).length,
      timestamp: now
    };

    sendReportBtn.disabled = true;

    // 1) Save the permanent record first
    db.ref('shift_reports').push(report)
      .then(() => {
        // 2) Then notify Telegram (a failure here doesn't lose the report)
        return sendTelegramReport(report)
          .then(() => alert('Тайлан амжилттай илгээгдлээ!'))
          .catch(() => alert('Тайлан хадгалагдлаа, гэхдээ Telegram руу илгээж чадсангүй.'));
      })
      .then(() => {
        // Report sent = shift over, so the next shift starts from now
        shiftStartTs = now;
        localStorage.setItem('parking_shift_start', String(now));
        db.ref(`active_shifts/${currentUser}`).set({ start: now });
        listenShiftLogs();
      })
      .catch((err) => alert('Тайлан илгээхэд алдаа гарлаа: ' + err.message))
      .finally(() => { sendReportBtn.disabled = false; });
  });
}

// Admin: view submitted reports
function listenShiftReports() {
  if (currentRole !== 'admin') return;
  const ref = db.ref('shift_reports').limitToLast(20);
  ref.off('value');
  ref.on('value', (snap) => {
    const body = document.getElementById('shift-reports-body');
    if (!body) return;
    const reports = Object.values(snap.val() || {}).sort((a, b) => b.timestamp - a.timestamp);
    body.innerHTML = '';
    if (reports.length === 0) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">Тайлан алга</td></tr>';
      return;
    }
    reports.forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${r.staff}</strong></td>
        <td>${formatDateTime(r.shiftStart)} → ${formatDateTime(r.shiftEnd)}</td>
        <td>₮${(r.cash || 0).toLocaleString()}</td>
        <td>₮${(r.card || 0).toLocaleString()}</td>
        <td>₮${(r.transfer || 0).toLocaleString()}</td>
        <td><strong>₮${(r.total || 0).toLocaleString()}</strong></td>
      `;
      body.appendChild(tr);
    });
  });
}

// ==========================================
// RECENT RECORDS ("Сүүлийн бүртгэлүүд") + PAYMENT METHOD CORRECTION
// ==========================================
let recentLogs = {};
let editingLogKey = null;

// Admin can edit any record; an employee can edit the records they checked out themselves
function canEditRecord(record) {
  return currentRole === 'admin' || record.exitStaff === currentUser;
}

function renderActivityLog(historyData) {
  recentLogs = historyData;
  historyBody.innerHTML = '';
  Object.entries(historyData)
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
    .forEach(([key, record]) => {
      const row = document.createElement('tr');
      const methodText = PAYMENT_LABELS[record.paymentMethod] || '—';
      const editedMark = record.edits ? ' ✏️' : '';

      let actions = '';
      if (canEditRecord(record)) {
        actions += `<button onclick="openEditPayment('${key}')" class="btn-edit">Засах</button> `;
      }
      if (currentRole === 'admin') {
        actions += `<button onclick="deleteRecord('${key}')" class="btn-danger">Delete</button>`;
      }

      row.innerHTML = `
        <td><strong>${record.plate}</strong></td>
        <td>${record.entryStaff} / ${record.exitStaff}</td>
        <td><strong>₮${Number(record.fee).toLocaleString()}</strong><br><small style="color:#64748b;">${methodText}${editedMark}</small></td>
        <td>${actions}</td>
      `;
      historyBody.appendChild(row);
    });
}

function openEditPayment(key) {
  const record = recentLogs[key];
  if (!record) return;
  if (!canEditRecord(record)) {
    alert('Та зөвхөн өөрийн гаргасан машины бүртгэлийг засах боломжтой.');
    return;
  }
  editingLogKey = key;
  document.getElementById('edit-plate').textContent = record.plate;
  document.getElementById('edit-fee').textContent = '₮' + Number(record.fee).toLocaleString();
  document.getElementById('edit-current').textContent = PAYMENT_LABELS[record.paymentMethod] || '—';
  document.getElementById('edit-payment-modal').style.display = 'flex';
}

function closeEditPayment() {
  document.getElementById('edit-payment-modal').style.display = 'none';
  editingLogKey = null;
}

function changePaymentMethod(newMethod) {
  const key = editingLogKey;
  const record = recentLogs[key];
  if (!record) { closeEditPayment(); return; }
  if (!canEditRecord(record)) { closeEditPayment(); return; }
  if (record.paymentMethod === newMethod) { closeEditPayment(); return; }

  // The price this car originally had to pay (needed when changing back from "Free")
  let originalFee = null;
  if (record.calculatedFee != null) originalFee = Number(record.calculatedFee);
  else if (record.paymentMethod !== 'Free') originalFee = Number(record.fee);

  let newFee;
  if (newMethod === 'Free') {
    newFee = 0;
  } else if (originalFee === null) {
    alert('Энэ бүртгэлийн анхны үнэ хадгалагдаагүй тул "Үнэгүй"-ээс өөрчилж болохгүй. Админд хандана уу.');
    return;
  } else {
    newFee = originalFee;
  }

  const oldText = PAYMENT_LABELS[record.paymentMethod] || '—';
  const newText = PAYMENT_LABELS[newMethod];
  if (!confirm(`${record.plate}\n${oldText} → ${newText}\nДүн: ₮${newFee.toLocaleString()}\n\nӨөрчлөх үү?`)) return;

  const updates = {};
  updates[`history_log/${key}/paymentMethod`] = newMethod;
  updates[`history_log/${key}/fee`] = newFee;
  if (originalFee !== null) updates[`history_log/${key}/calculatedFee`] = originalFee;

  // Audit trail: who changed what, and when
  const editId = db.ref(`history_log/${key}/edits`).push().key;
  updates[`history_log/${key}/edits/${editId}`] = {
    from: record.paymentMethod || null,
    to: newMethod,
    feeBefore: Number(record.fee) || 0,
    feeAfter: newFee,
    by: currentUser,
    at: Date.now()
  };

  db.ref().update(updates)
    .then(closeEditPayment)
    .catch((err) => alert('Алдаа: ' + err.message));
}

init();

function init() {
  if (currentUser) {
    loginOverlay.style.display = 'none';
    currentUserDisplay.textContent = currentUser;
    roleBadge.textContent = currentRole.toUpperCase();
    roleBadge.className = `role-badge badge-${currentRole}`;

    if (currentRole === 'admin') {
      adminPanel.style.display = 'block';
      qrSection.style.display = 'block';
      generateQRCode();
    } else {
      adminPanel.style.display = 'none';
      qrSection.style.display = 'none';
    }
    renderActivityLog(recentLogs);
    loadShiftStart(currentUser).finally(listenShiftLogs);
    listenShiftReports();
  } else {
    loginOverlay.style.display = 'flex';
  }

  setupRealtimeListeners();
  runAutoCleanup();
}

// User Authentication (Login)
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;

  // Default master admin fallback account if database accounts are empty
  if (username === 'admin' && password === '1234') {
    loginUser('admin', 'admin');
    return;
  }

  // Check account against Firebase database
  const userAccount = accountsMap[username];
  if (userAccount && userAccount.password === password) {
    loginUser(username, userAccount.role || 'employee');
  } else {
    alert('Invalid username or password!');
  }
});

function loginUser(username, role) {
  currentUser = username;
  currentRole = role;
  localStorage.setItem('parking_user', currentUser);
  localStorage.setItem('parking_role', currentRole);

  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';

  // Display welcome message panel inside the overlay
  const loginOverlay = document.getElementById('login-overlay');
  loginOverlay.innerHTML = `
    <div style="background: white; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; margin: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
      <h2 style="color: #1e3a8a; margin-bottom: 0.5rem;">Амжилттай нэвтэрлээ!</h2>
      <p style="font-size: 1.15rem; color: #334155; margin-bottom: 1rem;">
        Өглөөний мэнд!, <strong>${currentUser}</strong>! Өнөөдөр үзүүлээд өгөөрэй!
      </p>
      <div style="font-size: 0.875rem; color: #64748b;">Loading workspace...</div>
    </div>
  `;

  // Wait 3 seconds before clearing overlay and initializing app view
  setTimeout(() => {
    loginOverlay.style.display = 'none';
    init();
  }, 3000);
}

// Logout with custom farewell panel
function logout() {
  const name = currentUser ? currentUser : 'User';

  // Clear local storage session
  localStorage.removeItem('parking_user');
  localStorage.removeItem('parking_shift_start');
  localStorage.removeItem('parking_role');
  currentUser = null;
  currentRole = 'employee';

  // Hide main app views
  document.getElementById('admin-panel').style.display = 'none';

  // Customize and show the farewell message overlay
  const loginOverlay = document.getElementById('login-overlay');
  loginOverlay.innerHTML = `
    <div style="background: white; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; margin: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
      <h2 style="color: #1e3a8a; margin-bottom: 0.5rem;">Амжилттай гарсан.</h2>
      <p style="font-size: 1.1rem; color: #334155; margin-bottom: 1rem;">
        <strong>${name}</strong>, Сайн ажиллаа. Өдрийг сайхан өнгрүүлээрэй!
      </p>
      <div style="font-size: 0.875rem; color: #64748b;">Redirecting to login...</div>
    </div>
  `;
  loginOverlay.style.display = 'flex';

  // Reload page after 3 seconds to reset to full login screen
  setTimeout(() => {
    window.location.reload();
  }, 3000);
}

// Account Creation (Admin Only)
createUserForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('new-username').value.trim().toLowerCase();
  const password = document.getElementById('new-password').value;

  if (username === 'admin') {
    alert('The username "admin" is reserved!');
    return;
  }

  db.ref(`accounts/${username}`).set({
    password: password,
    role: 'employee',
    createdAt: Date.now()
  });

  document.getElementById('new-username').value = '';
  document.getElementById('new-password').value = '';
  alert(`Account for "${username}" created successfully!`);
});

function deleteAccount(username) {
  if (confirm(`Are you sure you want to delete account "${username}"?`)) {
    db.ref(`accounts/${username}`).remove();
  }
}

function renderUsersTable() {
  usersTableBody.innerHTML = '';
  Object.entries(accountsMap).forEach(([username, acc]) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${username}</strong></td>
      <td>${acc.role || 'employee'}</td>
      <td><button onclick="deleteAccount('${username}')" class="btn-danger">Delete</button></td>
    `;
    usersTableBody.appendChild(row);
  });
}

// ==========================================
// FREE VEHICLES MANAGEMENT (ADMIN)
// ==========================================

// Listen for Realtime Updates from Firebase
db.ref('free_vehicles').on('value', (snapshot) => {
  freeVehiclesMap = snapshot.val() || {};
  renderFreeVehiclesList();
});

// Render Free Vehicles Table in Admin Panel
function renderFreeVehiclesList() {
  const tbody = document.getElementById('free-vehicles-list-body');
  if (!tbody) return;

  tbody.innerHTML = '';

  const keys = Object.keys(freeVehiclesMap);
  if (keys.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="padding: 12px; text-align: center; color: #64748b;">No free vehicles registered.</td></tr>';
    return;
  }

  keys.forEach((key) => {
    const item = freeVehiclesMap[key];
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid #f1f5f9';
    tr.innerHTML = `
      <td style="padding: 8px; font-weight: bold; text-transform: uppercase;">${item.plate}</td>
      <td style="padding: 8px; color: #475569;">${item.note || 'N/A'}</td>
      <td style="padding: 8px;">
        <button onclick="removeFreeVehicle('${key}')" style="background-color: #ef4444; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">
          Remove
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Auto-uppercase the free vehicle plate input as the admin types
const freePlateInput = document.getElementById('free-plate-input');
if (freePlateInput) {
  freePlateInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
}

// Handle Add Free Vehicle Form Submission
const addFreeVehicleForm = document.getElementById('add-free-vehicle-form');
if (addFreeVehicleForm) {
  addFreeVehicleForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const plateInput = document.getElementById('free-plate-input').value.trim().toUpperCase();
    const noteInput = document.getElementById('free-note-input').value.trim();

    if (!plateInput) return;

    // Mongolian Plate Format Regex: 4 digits + 3 uppercase letters (Latin or Cyrillic including Ө, Ү)
    const mongolianPlateRegex = /^\d{4}[A-ZА-ЯӨҮ]{3}$/i;

    if (!mongolianPlateRegex.test(plateInput)) {
      alert('Улсын Дугаар буруу байна!\n4 тоо, 3 үсэг форматаар бичнэ үү (жишээ нь: 1234АБВ эсвэл 1234ABC).');
      return;
    }

    const cleanKey = plateInput.replace(/[.#$\[\]]/g, '');

    db.ref(`free_vehicles/${cleanKey}`).set({
      plate: plateInput,
      note: noteInput,
      addedBy: currentUser,
      timestamp: Date.now()
    }).then(() => {
      document.getElementById('free-plate-input').value = '';
      document.getElementById('free-note-input').value = '';
    }).catch((err) => {
      alert('Error adding free vehicle: ' + err.message);
    });
  });
}

// Remove Free Vehicle
function removeFreeVehicle(key) {
  if (confirm(`Remove vehicle from free list?`)) {
    db.ref(`free_vehicles/${key}`).remove();
  }
}

// ==========================================
// RATE SETTINGS EDITOR (ADMIN)
// ==========================================
function normalizeLocks(raw) {
  return Object.values(raw || {})
    .map(l => ({ until: Number(l.until), price: Number(l.price) }))
    .filter(l => l.until > 0 && l.price >= 0)
    .sort((a, b) => a.until - b.until);
}

function minutesToText(m) {
  const h = Math.floor(m / 60), r = m % 60;
  if (!m || m <= 0) return '';
  return h > 0 ? `${h}ц ${r}м` : `${r}м`;
}

function renderRateEditor() {
  const body = document.getElementById('rate-locks-body');
  if (!body) return;

  document.getElementById('rate-first-min').value = rates.firstMinutes;
  document.getElementById('rate-first-fee').value = rates.firstFee;
  document.getElementById('rate-hour').value = rates.hourRate;

  body.innerHTML = '';
  locksDraft.forEach((l, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <input type="number" min="1" max="1440" value="${l.until}" data-i="${i}" data-f="until">
        <small class="lock-text" style="color:#64748b;">${minutesToText(l.until)} хүртэл</small>
      </td>
      <td><input type="number" min="0" value="${l.price}" data-i="${i}" data-f="price"></td>
      <td><button type="button" class="btn-danger" onclick="removeLock(${i})">✕</button></td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const i = Number(e.target.dataset.i), f = e.target.dataset.f;
      locksDraft[i][f] = Number(e.target.value);
      if (f === 'until') {
        e.target.parentElement.querySelector('.lock-text').textContent =
          minutesToText(locksDraft[i].until) + ' хүртэл';
      }
    });
  });
}

function removeLock(i) {
  locksDraft.splice(i, 1);
  renderRateEditor();
}

const addLockBtn = document.getElementById('add-lock-btn');
if (addLockBtn) {
  addLockBtn.addEventListener('click', () => {
    const last = locksDraft[locksDraft.length - 1];
    locksDraft.push({ until: last ? Math.min(1440, last.until + 60) : 720, price: last ? last.price : 20000 });
    renderRateEditor();
  });
}

// Handle Parking Rate Settings Form Submission (Admin)
const rateForm = document.getElementById('rate-settings-form');
if (rateForm) {
  rateForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const firstMinutes = parseInt(document.getElementById('rate-first-min').value, 10);
    const firstFee = parseInt(document.getElementById('rate-first-fee').value, 10);
    const hourRate = parseInt(document.getElementById('rate-hour').value, 10);
    const locks = locksDraft.map(l => ({ until: Number(l.until), price: Number(l.price) }));

    if (isNaN(firstMinutes) || firstMinutes < 0 || isNaN(firstFee) || firstFee < 0) {
      alert('Эхний хугацаа болон үнийг зөв оруулна уу.'); return;
    }
    if (isNaN(hourRate) || hourRate <= 0) { alert('Цаг тутмын үнийг зөв оруулна уу.'); return; }
    if (locks.length === 0) { alert('Хамгийн багадаа 1 мөр байх ёстой.'); return; }

    for (let i = 0; i < locks.length; i++) {
      const l = locks[i];
      if (!(l.until > 0) || l.until > 1440 || isNaN(l.price) || l.price < 0) {
        alert(`${i + 1}-р мөр буруу байна (хугацаа 1–1440 минут).`); return;
      }
      if (i > 0 && l.until <= locks[i - 1].until) {
        alert(`${i + 1}-р мөрийн хугацаа өмнөх мөрөөс их байх ёстой.`); return;
      }
      if (i > 0 && l.price < locks[i - 1].price) {
        alert(`${i + 1}-р мөрийн үнэ өмнөх мөрөөс бага байж болохгүй.`); return;
      }
    }
    if (locks[locks.length - 1].until !== 1440) {
      alert('Сүүлийн мөрийн хугацаа 1440 минут (24 цаг) байх ёстой. Энэ нь 24 цагийн үнэ болно.'); return;
    }

    db.ref('rate_settings').set({
      firstMinutes, firstFee, hourRate, locks,
      updatedBy: currentUser,
      timestamp: Date.now()
    }).then(() => alert('Үнэ амжилттай хадгалагдлаа!'))
      .catch((err) => alert('Алдаа: ' + err.message));
  });
}

renderRateEditor();

// Listen to Database
function setupRealtimeListeners() {
  if (listenersStarted) return; // init() runs twice after login, so only attach once
  listenersStarted = true;

  db.ref('accounts').on('value', (snap) => {
    accountsMap = snap.val() || {};
    if (currentRole === 'admin') renderUsersTable();
  });

  db.ref('rate_settings').on('value', (snap) => {
    const val = snap.val();
    const locks = val ? normalizeLocks(val.locks) : [];
    if (val && locks.length && val.hourRate != null) {
      rates = {
        firstMinutes: val.firstMinutes != null ? Number(val.firstMinutes) : DEFAULT_RATES.firstMinutes,
        firstFee: val.firstFee != null ? Number(val.firstFee) : DEFAULT_RATES.firstFee,
        hourRate: Number(val.hourRate),
        locks: locks
      };
    } else {
      rates = JSON.parse(JSON.stringify(DEFAULT_RATES)); // nothing saved in the new format yet
    }
    locksDraft = rates.locks.map(l => ({ ...l }));
    renderRateEditor();
  });

  db.ref('active_vehicles').on('value', (snap) => {
    activeVehiclesMap = snap.val() || {};
    renderActiveTable(document.getElementById('search-plate').value);
  });

  db.ref('history_log').limitToLast(3).on('value', (snapshot) => {
    const historyData = snapshot.val() || {};
    renderActivityLog(historyData);
  });
}

if (plateInput) {
  plateInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
}

// Entry & Exit Operations
checkinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const plate = plateInput.value.trim().toUpperCase();

  // Mongolian Plate Format Regex: 4 digits followed by 3 uppercase letters (Latin or Cyrillic including Ө, Ү)
  const mongolianPlateRegex = /^\d{4}[A-ZА-ЯӨҮ]{3}$/i;

  if (!mongolianPlateRegex.test(plate)) {
    alert('Invalid Mongolian Plate Number!\nFormat must be 4 digits followed by 3 letters (e.g., 1234АБВ or 1234ABC).');
    return;
  }

  const isParked = Object.values(activeVehiclesMap).some(v => v.plate === plate);
  if (isParked) {
    alert('This vehicle is already inside!');
    return;
  }

  db.ref('active_vehicles').push({
    plate: plate,
    entryTime: new Date().toISOString(),
    entryStaff: currentUser,
    timestamp: Date.now()
  });

  plateInput.value = '';
});

function renderActiveTable(filter = '') {
  tableBody.innerHTML = '';
  const entries = Object.entries(activeVehiclesMap);
  activeCount.textContent = entries.length;

  entries.forEach(([key, v]) => {
    if (filter && !v.plate.toLowerCase().includes(filter.toLowerCase())) return;

    const formattedTime = new Date(v.entryTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${v.plate}</strong></td>
      <td>${formattedTime}</td>
      <td>${v.entryStaff}${v.manualEntry ? ' <span title="Админ гараар бүртгэсэн">✏️</span>' : ''}</td>
      <td><button class="btn-danger" onclick="openCheckoutModal('${key}')">Гаргах</button></td>
    `;
    tableBody.appendChild(row);
  });
}

function filterVehicles() {
  const input = document.getElementById('search-plate');
  input.value = input.value.toUpperCase();
  renderActiveTable(input.value);
}

// Parking fee: every started hour costs hourRate, but the price is "locked" at each
// lock's price until that lock's time ends. A full 24h costs the last lock's price,
// and the same pattern repeats for every extra day.
function calculateParkingFee(totalMinutes, isFreeVehicle) {
  if (isFreeVehicle || totalMinutes <= 0) return 0;

  const { firstMinutes, firstFee, hourRate, locks } = rates;
  const DAY = 1440;
  const dayPrice = locks[locks.length - 1].price;

  const fullDays = Math.floor(totalMinutes / DAY);
  const rem = totalMinutes % DAY;
  if (rem === 0) return fullDays * dayPrice;

  let fee = dayPrice;
  if (fullDays === 0 && rem <= firstMinutes) {
    fee = firstFee; // only the very first minutes of the stay
  } else {
    let base = 0, start = 0;
    for (const lock of locks) {
      if (rem <= lock.until) {
        const hours = Math.ceil((rem - start) / 60);
        fee = Math.min(base + hours * hourRate, lock.price);
        break;
      }
      base = lock.price;
      start = lock.until;
    }
  }
  return fullDays * dayPrice + fee;
}

// ==========================================
// CHECKOUT WITH FROZEN PRICE
// ==========================================
// Builds a locked copy of everything needed for this checkout. Nothing in the
// database is changed, so pressing Cancel simply throws the copy away and the
// parking time keeps running from the original entry time.
function buildCheckoutSnapshot(key, vehicle) {
  const frozenAt = Date.now();
  const entryMs = new Date(vehicle.entryTime).getTime();
  const totalMinutes = Math.max(1, Math.ceil((frozenAt - entryMs) / 60000));

  const cleanPlate = vehicle.plate.replace(/[.#$\[\]]/g, '').toUpperCase();
  const isFreeVehicle = !!freeVehiclesMap[cleanPlate];
  const fee = calculateParkingFee(totalMinutes, isFreeVehicle);

  const days = Math.floor(totalMinutes / 1440);
  const hrs = Math.floor((totalMinutes % 1440) / 60);
  const mins = totalMinutes % 60;
  const durationText = days > 0 ? `${days}d ${hrs}h ${mins}m` : `${hrs}h ${mins}m`;

  return {
    key,
    plate: vehicle.plate,
    entryStaff: vehicle.entryStaff,
    frozenAt,
    totalMinutes,
    durationText,
    fee,
    isFreeVehicle
  };
}

function showCheckoutModal() {
  const snap = checkoutSnapshot;
  if (!snap) return;

  document.getElementById('modal-plate').textContent = snap.plate;
  document.getElementById('modal-duration').textContent = snap.durationText;
  document.getElementById('modal-fee').textContent = snap.isFreeVehicle
    ? '₮0 (Free / Exempt Vehicle)'
    : `₮${snap.fee.toLocaleString()}`;

  const note = document.getElementById('modal-frozen-note');
  if (note) {
    note.textContent = `🔒 Үнэ ${new Date(snap.frozenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} цагт хөлдсөн`;
  }
  document.getElementById('receipt-modal').style.display = 'flex';
}

function openCheckoutModal(key) {
  const vehicle = activeVehiclesMap[key];
  if (!vehicle) return;
  checkoutSnapshot = buildCheckoutSnapshot(key, vehicle);
  showCheckoutModal();
}

// Accepts the selected payment method ('Cash', 'Card', 'Transfer' or 'Free')
function confirmCheckout(paymentMethod) {
  const snap = checkoutSnapshot;
  if (!snap) return;

  const vehicle = activeVehiclesMap[snap.key];
  if (!vehicle) {
    alert('Энэ машин аль хэдийн гарсан байна.');
    closeModal();
    return;
  }

  // Safety: if the screen was left open for too long, refresh the price instead of undercharging
  if (Date.now() - snap.frozenAt > FREEZE_MAX_MINUTES * 60000) {
    checkoutSnapshot = buildCheckoutSnapshot(snap.key, vehicle);
    showCheckoutModal();
    alert(`Үнэ ${FREEZE_MAX_MINUTES} минутаас илүү хөлдсөн байсан тул шинэчлэгдлээ. Шинэ дүнг шалгаад дахин сонгоно уу.`);
    return;
  }

  // Second layer: confirm the chosen payment method before the vehicle leaves.
  // Pressing "Cancel" here keeps the frozen price on screen so another method can be chosen.
  const methodLabel = PAYMENT_LABELS[paymentMethod] || paymentMethod;
  const payAmount = paymentMethod === 'Free' ? 0 : snap.fee;
  if (!confirm(`Машин: ${snap.plate}\nДүн: ₮${payAmount.toLocaleString()}\nТөлбөрийн хэлбэр: ${methodLabel}\n\nЭнэ машиныг энэ хэлбэрээр гаргахдаа итгэлтэй байна уу?`)) return;

  db.ref('history_log').push({
    plate: snap.plate,
    entryStaff: snap.entryStaff,
    exitStaff: currentUser,
    duration: snap.durationText,
    fee: paymentMethod === 'Free' ? 0 : snap.fee,
    calculatedFee: snap.fee,      // original price, so a wrong 'Free' can be corrected later
    paymentMethod: paymentMethod, // Log payment method to Firebase
    exitTime: snap.frozenAt,      // the moment the price was frozen
    timestamp: Date.now()
  });

  db.ref(`active_vehicles/${snap.key}`).remove();
  closeModal();
}

// Cancel / close: the frozen copy is discarded, nothing was changed in the database
function closeModal() {
  document.getElementById('receipt-modal').style.display = 'none';
  checkoutSnapshot = null;
}

function deleteRecord(key) {
  if (confirm('Delete this transaction log?')) {
    db.ref(`history_log/${key}`).remove();
  }
}

function runAutoCleanup() {
  const cutoff = Date.now() - (PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000);
  db.ref('history_log').once('value', (snap) => {
    const logs = snap.val();
    if (logs) {
      Object.entries(logs).forEach(([key, r]) => {
        if (r.timestamp && r.timestamp < cutoff) db.ref(`history_log/${key}`).remove();
      });
    }
  });
}

function generateQRCode() {
  const container = document.getElementById('qrcode');
  container.innerHTML = '';
  new QRCode(container, { text: window.location.href, width: 120, height: 120 });
}

// Automatically cleanup logs older than 14 days (1,209,600,000 ms)
function cleanupOldLogs() {
  const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);

  db.ref('history_log')
    .orderByChild('timestamp')
    .endAt(fourteenDaysAgo)
    .once('value', (snapshot) => {
      const oldLogs = snapshot.val();
      if (oldLogs) {
        const updates = {};
        Object.keys(oldLogs).forEach((key) => {
          updates[`history_log/${key}`] = null; // null deletes the entry
        });

        db.ref().update(updates)
          .then(() => console.log('Old logs (>14 days) cleaned up successfully.'))
          .catch((err) => console.error('Error cleaning up logs:', err));
      }
    });
}

// ==========================================
// MANUAL VEHICLE REGISTRATION (ADMIN)
// ==========================================
function toLocalInputValue(date) {
  // datetime-local needs "YYYY-MM-DDTHH:MM" in LOCAL time (toISOString would give UTC)
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const manualEntryForm = document.getElementById('manual-entry-form');
const manualTimeInput = document.getElementById('manual-time-input');
const manualPlateInput = document.getElementById('manual-plate-input');

if (manualTimeInput) manualTimeInput.value = toLocalInputValue(new Date());

if (manualPlateInput) {
  manualPlateInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
  });
}

if (manualEntryForm) {
  manualEntryForm.addEventListener('submit', (e) => {
    e.preventDefault();

    if (currentRole !== 'admin') {
      alert('Зөвхөн админ гараар бүртгэх эрхтэй.');
      return;
    }

    const plate = manualPlateInput.value.trim().toUpperCase();
    const timeValue = manualTimeInput.value;
    const staffName = document.getElementById('manual-staff-input').value.trim().toLowerCase();

    const mongolianPlateRegex = /^\d{4}[A-ZА-ЯӨҮ]{3}$/i;
    if (!mongolianPlateRegex.test(plate)) {
      alert('Улсын Дугаар буруу байна!\n4 тоо, 3 үсэг форматаар бичнэ үү (жишээ нь: 1234АБВ эсвэл 1234ABC).');
      return;
    }

    if (!timeValue) {
      alert('Орсон цагийг сонгоно уу.');
      return;
    }

    const entryDate = new Date(timeValue);
    const now = new Date();

    if (entryDate > now) {
      alert('Орсон цаг ирээдүйд байж болохгүй.');
      return;
    }

    const hoursAgo = (now - entryDate) / (1000 * 60 * 60);
    if (hoursAgo > 24) {
      if (!confirm(`Энэ машин ${Math.floor(hoursAgo)} цагийн өмнө орсон гэж бүртгэгдэх гэж байна. Үргэлжлүүлэх үү?`)) return;
    }

    const isParked = Object.values(activeVehiclesMap).some(v => v.plate === plate);
    if (isParked) {
      alert('Энэ машин аль хэдийн зогсоолд бүртгэлтэй байна!');
      return;
    }

    db.ref('active_vehicles').push({
      plate: plate,
      entryTime: entryDate.toISOString(),
      entryStaff: staffName || currentUser,
      manualEntry: true,
      addedBy: currentUser,
      timestamp: Date.now()
    }).then(() => {
      manualPlateInput.value = '';
      document.getElementById('manual-staff-input').value = '';
      manualTimeInput.value = toLocalInputValue(new Date());
      alert(`${plate} амжилттай бүртгэгдлээ.`);
    }).catch((err) => alert('Бүртгэхэд алдаа гарлаа: ' + err.message));
  });
}

// Run cleanup every time the app initializes
cleanupOldLogs();
