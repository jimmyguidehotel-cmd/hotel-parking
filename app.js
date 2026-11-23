// 1. Firebase Credentials
2
const firebaseConfig = {
3
  apiKey: "AIzaSyC6eDR2AqfSoj-EjoczcnOFX_R1AS1d_8Y",
4
  authDomain: "parking-lot-registration.firebaseapp.com",
5
  databaseURL: "https://parking-lot-registration-default-rtdb.asia-southeast1.firebasedatabase.app",
6
  projectId: "parking-lot-registration",
7
  storageBucket: "parking-lot-registration.firebasestorage.app",
8


  messagingSenderId: "1031026900719",
9
  appId: "1:1031026900719:web:b8642e24d22842e71f251a",
10
  measurementId: "G-BFCQJ9MC1T"
11
};
12

13
firebase.initializeApp(firebaseConfig);
14
const db = firebase.database();
15

16
const PURGE_AFTER_DAYS = 2; // Auto cleanup interval
17

18
// App State
19
let currentUser = localStorage.getItem('parking_user') || null;
20
let currentRole = localStorage.getItem('parking_role') || 'АЖИЛТАН';
21
let accountsMap = {};
22
let activeVehiclesMap = {};
23
let historyLogMap = {};
24
let freeVehiclesMap = {};
25
let listenersStarted = false; // prevents duplicate Firebase listeners
26

27
// Checkout "freeze": price and time are locked the moment the exit button is pressed
28
let checkoutSnapshot = null;
29
const FREEZE_MAX_MINUTES = 10; // a frozen price is refreshed if the modal stays open longer than this
30

31
// Rate settings: first short period, then a price per started hour, with "locks" (caps)
32
const DEFAULT_RATES = {
33
  firstMinutes: 10,
34
  firstFee: 1500,
35
  hourRate: 3000,
36
  locks: [
37
    { until: 720,  price: 20000 },  // price grows until it hits 20000, stays locked until 12h
38
    { until: 1440, price: 40000 }   // then grows until 40000, locked until 24h
39
  ]
40
};
41

42
let rates = JSON.parse(JSON.stringify(DEFAULT_RATES));
43
let locksDraft = DEFAULT_RATES.locks.map(l => ({ ...l }));
44

45
// DOM Elements
46
const loginOverlay = document.getElementById('login-overlay');
47
const loginForm = document.getElementById('login-form');
48
const createUserForm = document.getElementById('create-user-form');
49
const usersTableBody = document.getElementById('users-table-body');
50
const currentUserDisplay = document.getElementById('current-user-display');
51
const roleBadge = document.getElementById('role-badge');
52
const checkinForm = document.getElementById('checkin-form');
53
const plateInput = document.getElementById('plate-input');
54
const tableBody = document.getElementById('vehicle-table-body');
55
const historyBody = document.getElementById('history-table-body');
56
const activeCount = document.getElementById('active-count');
57
const adminPanel = document.getElementById('admin-panel');
58
const qrSection = document.getElementById('qr-section');
59

60
// ==========================================
61
// SHIFT SUMMARY & REPORTS
62
// ==========================================
63
const PAYMENT_LABELS = {
64
  Cash: 'Бэлэн мөнгө',
65
  Card: 'Карт',
66
  Transfer: 'Данс',
67
  Free: 'Үнэгүй'
68
};
69

70
let shiftLogsMap = {};
71
let shiftListenerRef = null;
72

73
function startOfToday() {
74
  const d = new Date();
75
  d.setHours(0, 0, 0, 0);
76
  return d.getTime();
77
}
78

79
let shiftStartTs = parseInt(localStorage.getItem('parking_shift_start'), 10) || null;
80

81
function getShiftStart() {
82
  return shiftStartTs || startOfToday();
83
}
84

85
// Resume the employee's open shift from Firebase, or start a new one
86
function loadShiftStart(username) {
87
  const ref = db.ref(`active_shifts/${username}`);
88
  return ref.once('value').then((snap) => {
89
    const saved = snap.val();
90
    if (saved && saved.start) {
91
      shiftStartTs = saved.start;            // resume the earlier shift
92
    } else {
93
      shiftStartTs = Date.now();             // first login of a new shift
94
      ref.set({ start: shiftStartTs });
95
    }
96
    localStorage.setItem('parking_shift_start', String(shiftStartTs));
97
  });
98
}
99

100
function formatDateTime(ts) {
101
  return new Date(ts).toLocaleString([], {
102
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
103
  });
104
}
105

106
// Listen only to logs since shift start (separate from the "last 3" listener)
107
function listenShiftLogs() {
108
  if (!currentUser) return;
109
  if (shiftListenerRef) shiftListenerRef.off('value');
110

111
  shiftListenerRef = db.ref('history_log').orderByChild('timestamp').startAt(getShiftStart());
112
  shiftListenerRef.on('value', (snap) => {
113
    shiftLogsMap = snap.val() || {};
114
    renderShiftSummary();
115
  });
116
}
117

118
function computeShiftSummary() {
119
  const summary = {
120
    Cash: { count: 0, amount: 0 },
121
    Card: { count: 0, amount: 0 },
122
    Transfer: { count: 0, amount: 0 },
123
    Free: { count: 0, amount: 0 }
124
  };
125

126
  Object.values(shiftLogsMap).forEach((r) => {
127
    if (r.exitStaff !== currentUser) return;
128
    const method = summary[r.paymentMethod] ? r.paymentMethod : null;
129
    if (!method) return;
130
    summary[method].count += 1;
131
    // Free exits never count as revenue
132
    if (method !== 'Free') summary[method].amount += Number(r.fee) || 0;
133
  });
134

135
  const total = summary.Cash.amount + summary.Card.amount + summary.Transfer.amount;
136
  const totalCount = Object.values(summary).reduce((s, x) => s + x.count, 0);
137
  return { summary, total, totalCount };
138
}
139

140
function renderShiftSummary() {
141
  const body = document.getElementById('shift-summary-body');
142
  const label = document.getElementById('shift-start-label');
143
  if (!body) return;
144

145
  label.textContent = `Ээлж эхэлсэн: ${formatDateTime(getShiftStart())}`;
146

147
  const { summary, total, totalCount } = computeShiftSummary();
148
  body.innerHTML = '';
149

150
  Object.keys(PAYMENT_LABELS).forEach((m) => {
151
    const tr = document.createElement('tr');
152
    tr.innerHTML = `
153
      <td>${PAYMENT_LABELS[m]}</td>
154
      <td>${summary[m].count}</td>
155
      <td><strong>${m === 'Free' ? '—' : '₮' + summary[m].amount.toLocaleString()}</strong></td>
156
    `;
157
    body.appendChild(tr);
158
  });
159

160
  const totalRow = document.createElement('tr');
161
  totalRow.style.background = '#f1f5f9';
162
  totalRow.innerHTML = `
163
    <td><strong>НИЙТ</strong></td>
164
    <td><strong>${totalCount}</strong></td>
165
    <td><strong>₮${total.toLocaleString()}</strong></td>
166
  `;
167
  body.appendChild(totalRow);
168
}
169

170
// ==========================================
171
// TELEGRAM NOTIFICATION
172
// ==========================================
173
const TELEGRAM_BOT_TOKEN = '8909979204:AAH9IQfyZsOf2N0rKSRO51zvivz2E5i7oVU';
174
const TELEGRAM_CHAT_ID = '8383510896';
175

176
function buildReportText(report) {
177
  const money = (n) => '₮' + (Number(n) || 0).toLocaleString();
178
  return [
179
    '📋 Ээлжийн тайлан',
180
    `👤 Ажилтан: ${report.staff}`,
181
    `🕒 ${formatDateTime(report.shiftStart)} → ${formatDateTime(report.shiftEnd)}`,
182
    '',
183
    `💵 Бэлэн мөнгө: ${money(report.cash)} (${report.counts.cash})`,
184
    `💳 Карт: ${money(report.card)} (${report.counts.card})`,
185
    `🏦 Данс: ${money(report.transfer)} (${report.counts.transfer})`,
186
    `🆓 Үнэгүй: ${report.counts.free} машин`,
187
    '',
188
    `💰 НИЙТ: ${money(report.total)}`,
189
    `🚗 Зогсоолд үлдсэн: ${report.carsStillInside} машин`
190
  ].join('\n');
191
}
192

193
function sendTelegramReport(report) {
194
  return fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
195
    method: 'POST',
196
    headers: { 'Content-Type': 'application/json' },
197
    body: JSON.stringify({
198
      chat_id: TELEGRAM_CHAT_ID,
199
      text: buildReportText(report)
200
    })
201
  }).then((res) => {
202
    if (!res.ok) throw new Error('Telegram error ' + res.status);
203
  });
204
}
205

206
// Send end-of-shift report to Firebase + Telegram
207
const sendReportBtn = document.getElementById('send-report-btn');
208
if (sendReportBtn) {
209
  sendReportBtn.addEventListener('click', () => {
210
    const { summary, total, totalCount } = computeShiftSummary();
211

212
    if (totalCount === 0) {
213
      alert('Энэ ээлжид гаргасан машин алга байна.');
214
      return;
215
    }
216
    if (!confirm('Ээлжийн тайланг илгээх үү?\nИлгээсний дараа тоолуур шинэчлэгдэнэ.')) return;
217

218
    const now = Date.now();
219
    const report = {
220
      staff: currentUser,
221
      shiftStart: getShiftStart(),
222
      shiftEnd: now,
223
      cash: summary.Cash.amount,
224
      card: summary.Card.amount,
225
      transfer: summary.Transfer.amount,
226
      total: total,
227
      counts: {
228
        cash: summary.Cash.count,
229
        card: summary.Card.count,
230
        transfer: summary.Transfer.count,
231
        free: summary.Free.count
232
      },
233
      carsStillInside: Object.keys(activeVehiclesMap).length,
234
      timestamp: now
235
    };
236

237
    sendReportBtn.disabled = true;
238

239
    // 1) Save the permanent record first
240
    db.ref('shift_reports').push(report)
241
      .then(() => {
242
        // 2) Then notify Telegram (a failure here doesn't lose the report)
243
        return sendTelegramReport(report)
244
          .then(() => alert('Тайлан амжилттай илгээгдлээ!'))
245
          .catch(() => alert('Тайлан хадгалагдлаа, гэхдээ Telegram руу илгээж чадсангүй.'));
246
      })
247
      .then(() => {
248
        // Report sent = shift over, so the next shift starts from now
249
        shiftStartTs = now;
250
        localStorage.setItem('parking_shift_start', String(now));
251
        db.ref(`active_shifts/${currentUser}`).set({ start: now });
252
        listenShiftLogs();
253
      })
254
      .catch((err) => alert('Тайлан илгээхэд алдаа гарлаа: ' + err.message))
255
      .finally(() => { sendReportBtn.disabled = false; });
256
  });
257
}
258

259
// Admin: view submitted reports
260
function listenShiftReports() {
261
  if (currentRole !== 'admin') return;
262
  const ref = db.ref('shift_reports').limitToLast(20);
263
  ref.off('value');
264
  ref.on('value', (snap) => {
265
    const body = document.getElementById('shift-reports-body');
266
    if (!body) return;
267
    const reports = Object.values(snap.val() || {}).sort((a, b) => b.timestamp - a.timestamp);
268
    body.innerHTML = '';
269
    if (reports.length === 0) {
270
      body.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">Тайлан алга</td></tr>';
271
      return;
272
    }
273
    reports.forEach((r) => {
274
      const tr = document.createElement('tr');
275
      tr.innerHTML = `
276
        <td><strong>${r.staff}</strong></td>
277
        <td>${formatDateTime(r.shiftStart)} → ${formatDateTime(r.shiftEnd)}</td>
278
        <td>₮${(r.cash || 0).toLocaleString()}</td>
279
        <td>₮${(r.card || 0).toLocaleString()}</td>
280
        <td>₮${(r.transfer || 0).toLocaleString()}</td>
281
        <td><strong>₮${(r.total || 0).toLocaleString()}</strong></td>
282
      `;
283
      body.appendChild(tr);
284
    });
285
  });
286
}
287

288
// ==========================================
289
// RECENT RECORDS ("Сүүлийн бүртгэлүүд") + PAYMENT METHOD CORRECTION
290
// ==========================================
291
let recentLogs = {};
292
let editingLogKey = null;
293

294
// Admin can edit any record; an employee can edit the records they checked out themselves
295
function canEditRecord(record) {
296
  return currentRole === 'admin' || record.exitStaff === currentUser;
297
}
298

299
function renderActivityLog(historyData) {
300
  recentLogs = historyData;
301
  historyBody.innerHTML = '';
302
  Object.entries(historyData)
303
    .sort((a, b) => b[1].timestamp - a[1].timestamp)
304
    .forEach(([key, record]) => {
305
      const row = document.createElement('tr');
306
      const methodText = PAYMENT_LABELS[record.paymentMethod] || '—';
307
      const editedMark = record.edits ? ' ✏️' : '';
308

309
      let actions = '';
310
      if (canEditRecord(record)) {
311
        actions += `<button onclick="openEditPayment('${key}')" class="btn-edit">Засах</button> `;
312
      }
313
      if (currentRole === 'admin') {
314
        actions += `<button onclick="deleteRecord('${key}')" class="btn-danger">Delete</button>`;
315
      }
316

317
      row.innerHTML = `
318
        <td><strong>${record.plate}</strong></td>
319
        <td>${record.entryStaff} / ${record.exitStaff}</td>
320
        <td><strong>₮${Number(record.fee).toLocaleString()}</strong><br><small style="color:#64748b;">${methodText}${editedMark}</small></td>
321
        <td>${actions}</td>
322
      `;
323
      historyBody.appendChild(row);
324
    });
325
}
326

327
function openEditPayment(key) {
328
  const record = recentLogs[key];
329
  if (!record) return;
330
  if (!canEditRecord(record)) {
331
    alert('Та зөвхөн өөрийн гаргасан машины бүртгэлийг засах боломжтой.');
332
    return;
333
  }
334
  editingLogKey = key;
335
  document.getElementById('edit-plate').textContent = record.plate;
336
  document.getElementById('edit-fee').textContent = '₮' + Number(record.fee).toLocaleString();
337
  document.getElementById('edit-current').textContent = PAYMENT_LABELS[record.paymentMethod] || '—';
338
  document.getElementById('edit-payment-modal').style.display = 'flex';
339
}
340

341
function closeEditPayment() {
342
  document.getElementById('edit-payment-modal').style.display = 'none';
343
  editingLogKey = null;
344
}
345

346
function changePaymentMethod(newMethod) {
347
  const key = editingLogKey;
348
  const record = recentLogs[key];
349
  if (!record) { closeEditPayment(); return; }
350
  if (!canEditRecord(record)) { closeEditPayment(); return; }
351
  if (record.paymentMethod === newMethod) { closeEditPayment(); return; }
352

353
  // The price this car originally had to pay (needed when changing back from "Free")
354
  let originalFee = null;
355
  if (record.calculatedFee != null) originalFee = Number(record.calculatedFee);
356
  else if (record.paymentMethod !== 'Free') originalFee = Number(record.fee);
357

358
  let newFee;
359
  if (newMethod === 'Free') {
360
    newFee = 0;
361
  } else if (originalFee === null) {
362
    alert('Энэ бүртгэлийн анхны үнэ хадгалагдаагүй тул "Үнэгүй"-ээс өөрчилж болохгүй. Админд хандана уу.');
363
    return;
364
  } else {
365
    newFee = originalFee;
366
  }
367

368
  const oldText = PAYMENT_LABELS[record.paymentMethod] || '—';
369
  const newText = PAYMENT_LABELS[newMethod];
370
  if (!confirm(`${record.plate}\n${oldText} → ${newText}\nДүн: ₮${newFee.toLocaleString()}\n\nӨөрчлөх үү?`)) return;
371

372
  const updates = {};
373
  updates[`history_log/${key}/paymentMethod`] = newMethod;
374
  updates[`history_log/${key}/fee`] = newFee;
375
  if (originalFee !== null) updates[`history_log/${key}/calculatedFee`] = originalFee;
376

377
  // Audit trail: who changed what, and when
378
  const editId = db.ref(`history_log/${key}/edits`).push().key;
379
  updates[`history_log/${key}/edits/${editId}`] = {
380
    from: record.paymentMethod || null,
381
    to: newMethod,
382
    feeBefore: Number(record.fee) || 0,
383
    feeAfter: newFee,
384
    by: currentUser,
385
    at: Date.now()
386
  };
387

388
  db.ref().update(updates)
389
    .then(closeEditPayment)
390
    .catch((err) => alert('Алдаа: ' + err.message));
391
}
392

393
init();
394

395
function init() {
396
  if (currentUser) {
397
    loginOverlay.style.display = 'none';
398
    currentUserDisplay.textContent = currentUser;
399
    roleBadge.textContent = currentRole.toUpperCase();
400
    roleBadge.className = `role-badge badge-${currentRole}`;
401

402
    if (currentRole === 'admin') {
403
      adminPanel.style.display = 'block';
404
      qrSection.style.display = 'block';
405
      generateQRCode();
406
    } else {
407
      adminPanel.style.display = 'none';
408
      qrSection.style.display = 'none';
409
    }
410
    renderActivityLog(recentLogs);
411
    loadShiftStart(currentUser).finally(listenShiftLogs);
412
    listenShiftReports();
413
  } else {
414
    loginOverlay.style.display = 'flex';
415
  }
416

417
  setupRealtimeListeners();
418
  runAutoCleanup();
419
}
420

421
// User Authentication (Login)
422
loginForm.addEventListener('submit', (e) => {
423
  e.preventDefault();
424
  const username = document.getElementById('login-username').value.trim().toLowerCase();
425
  const password = document.getElementById('login-password').value;
426

427
  // Default master admin fallback account if database accounts are empty
428
  if (username === 'admin' && password === '1234') {
429
    loginUser('admin', 'admin');
430
    return;
431
  }
432

433
  // Check account against Firebase database
434
  const userAccount = accountsMap[username];
435
  if (userAccount && userAccount.password === password) {
436
    loginUser(username, userAccount.role || 'employee');
437
  } else {
438
    alert('Invalid username or password!');
439
  }
440
});
441

442
function loginUser(username, role) {
443
  currentUser = username;
444
  currentRole = role;
445
  localStorage.setItem('parking_user', currentUser);
446
  localStorage.setItem('parking_role', currentRole);
447

448
  document.getElementById('login-username').value = '';
449
  document.getElementById('login-password').value = '';
450

451
  // Display welcome message panel inside the overlay
452
  const loginOverlay = document.getElementById('login-overlay');
453
  loginOverlay.innerHTML = `
454
    <div style="background: white; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; margin: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
455
      <h2 style="color: #1e3a8a; margin-bottom: 0.5rem;">Амжилттай нэвтэрлээ!</h2>
456
      <p style="font-size: 1.15rem; color: #334155; margin-bottom: 1rem;">
457
        Өглөөний мэнд!, <strong>${currentUser}</strong>! Өнөөдөр үзүүлээд өгөөрэй!
458
      </p>
459
      <div style="font-size: 0.875rem; color: #64748b;">Loading workspace...</div>
460
    </div>
461
  `;
462

463
  // Wait 3 seconds before clearing overlay and initializing app view
464
  setTimeout(() => {
465
    loginOverlay.style.display = 'none';
466
    init();
467
  }, 3000);
468
}
469

470
// Logout with custom farewell panel
471
function logout() {
472
  const name = currentUser ? currentUser : 'User';
473

474
  // Clear local storage session
475
  localStorage.removeItem('parking_user');
476
  localStorage.removeItem('parking_shift_start');
477
  localStorage.removeItem('parking_role');
478
  currentUser = null;
479
  currentRole = 'employee';
480

481
  // Hide main app views
482
  document.getElementById('admin-panel').style.display = 'none';
483

484
  // Customize and show the farewell message overlay
485
  const loginOverlay = document.getElementById('login-overlay');
486
  loginOverlay.innerHTML = `
487
    <div style="background: white; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; margin: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
488
      <h2 style="color: #1e3a8a; margin-bottom: 0.5rem;">Амжилттай гарсан.</h2>
489
      <p style="font-size: 1.1rem; color: #334155; margin-bottom: 1rem;">
490
        <strong>${name}</strong>, Сайн ажиллаа. Өдрийг сайхан өнгрүүлээрэй!
491
      </p>
492
      <div style="font-size: 0.875rem; color: #64748b;">Redirecting to login...</div>
493
    </div>
494
  `;
495
  loginOverlay.style.display = 'flex';
496

497
  // Reload page after 3 seconds to reset to full login screen
498
  setTimeout(() => {
499
    window.location.reload();
500
  }, 3000);
501
}
502

503
// Account Creation (Admin Only)
504
createUserForm.addEventListener('submit', (e) => {
505
  e.preventDefault();
506
  const username = document.getElementById('new-username').value.trim().toLowerCase();
507
  const password = document.getElementById('new-password').value;
508

509
  if (username === 'admin') {
510
    alert('The username "admin" is reserved!');
511
    return;
512
  }
513

514
  db.ref(`accounts/${username}`).set({
515
    password: password,
516
    role: 'employee',
517
    createdAt: Date.now()
518
  });
519

520
  document.getElementById('new-username').value = '';
521
  document.getElementById('new-password').value = '';
522
  alert(`Account for "${username}" created successfully!`);
523
});
524

525
function deleteAccount(username) {
526
  if (confirm(`Are you sure you want to delete account "${username}"?`)) {
527
    db.ref(`accounts/${username}`).remove();
528
  }
529
}
530

531
function renderUsersTable() {
532
  usersTableBody.innerHTML = '';
533
  Object.entries(accountsMap).forEach(([username, acc]) => {
534
    const row = document.createElement('tr');
535
    row.innerHTML = `
536
      <td><strong>${username}</strong></td>
537
      <td>${acc.role || 'employee'}</td>
538
      <td><button onclick="deleteAccount('${username}')" class="btn-danger">Delete</button></td>
539
    `;
540
    usersTableBody.appendChild(row);
541
  });
542
}
543

544
// ==========================================
545
// FREE VEHICLES MANAGEMENT (ADMIN)
546
// ==========================================
547

548
// Listen for Realtime Updates from Firebase
549
db.ref('free_vehicles').on('value', (snapshot) => {
550
  freeVehiclesMap = snapshot.val() || {};
551
  renderFreeVehiclesList();
552
});
553

554
// Render Free Vehicles Table in Admin Panel
555
function renderFreeVehiclesList() {
556
  const tbody = document.getElementById('free-vehicles-list-body');
557
  if (!tbody) return;
558

559
  tbody.innerHTML = '';
560

561
  const keys = Object.keys(freeVehiclesMap);
562
  if (keys.length === 0) {
563
    tbody.innerHTML = '<tr><td colspan="3" style="padding: 12px; text-align: center; color: #64748b;">No free vehicles registered.</td></tr>';
564
    return;
565
  }
566

567
  keys.forEach((key) => {
568
    const item = freeVehiclesMap[key];
569
    const tr = document.createElement('tr');
570
    tr.style.borderBottom = '1px solid #f1f5f9';
571
    tr.innerHTML = `
572
      <td style="padding: 8px; font-weight: bold; text-transform: uppercase;">${item.plate}</td>
573
      <td style="padding: 8px; color: #475569;">${item.note || 'N/A'}</td>
574
      <td style="padding: 8px;">
575
        <button onclick="removeFreeVehicle('${key}')" style="background-color: #ef4444; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">
576
          Remove
577
        </button>
578
      </td>
579
    `;
580
    tbody.appendChild(tr);
581
  });
582
}
583

584
// Auto-uppercase the free vehicle plate input as the admin types
585
const freePlateInput = document.getElementById('free-plate-input');
586
if (freePlateInput) {
587
  freePlateInput.addEventListener('input', (e) => {
588
    e.target.value = e.target.value.toUpperCase();
589
  });
590
}
591

592
// Handle Add Free Vehicle Form Submission
593
const addFreeVehicleForm = document.getElementById('add-free-vehicle-form');
594
if (addFreeVehicleForm) {
595
  addFreeVehicleForm.addEventListener('submit', (e) => {
596
    e.preventDefault();
597
    const plateInput = document.getElementById('free-plate-input').value.trim().toUpperCase();
598
    const noteInput = document.getElementById('free-note-input').value.trim();
599

600
    if (!plateInput) return;
601

602
    // Mongolian Plate Format Regex: 4 digits + 3 uppercase letters (Latin or Cyrillic including Ө, Ү)
603
    const mongolianPlateRegex = /^\d{4}[A-ZА-ЯӨҮ]{3}$/i;
604

605
    if (!mongolianPlateRegex.test(plateInput)) {
606
      alert('Улсын Дугаар буруу байна!\n4 тоо, 3 үсэг форматаар бичнэ үү (жишээ нь: 1234АБВ эсвэл 1234ABC).');
607
      return;
608
    }
609

610
    const cleanKey = plateInput.replace(/[.#$\[\]]/g, '');
611

612
    db.ref(`free_vehicles/${cleanKey}`).set({
613
      plate: plateInput,
614
      note: noteInput,
615
      addedBy: currentUser,
616
      timestamp: Date.now()
617
    }).then(() => {
618
      document.getElementById('free-plate-input').value = '';
619
      document.getElementById('free-note-input').value = '';
620
    }).catch((err) => {
621
      alert('Error adding free vehicle: ' + err.message);
622
    });
623
  });
624
}
625

626
// Remove Free Vehicle
627
function removeFreeVehicle(key) {
628
  if (confirm(`Remove vehicle from free list?`)) {
629
    db.ref(`free_vehicles/${key}`).remove();
630
  }
631
}
632

633
// ==========================================
634
// RATE SETTINGS EDITOR (ADMIN)
635
// ==========================================
636
function normalizeLocks(raw) {
637
  return Object.values(raw || {})
638
    .map(l => ({ until: Number(l.until), price: Number(l.price) }))
639
    .filter(l => l.until > 0 && l.price >= 0)
640
    .sort((a, b) => a.until - b.until);
641
}
642

643
function minutesToText(m) {
644
  const h = Math.floor(m / 60), r = m % 60;
645
  if (!m || m <= 0) return '';
646
  return h > 0 ? `${h}ц ${r}м` : `${r}м`;
647
}
648

649
function renderRateEditor() {
650
  const body = document.getElementById('rate-locks-body');
651
  if (!body) return;
652

653
  document.getElementById('rate-first-min').value = rates.firstMinutes;
654
  document.getElementById('rate-first-fee').value = rates.firstFee;
655
  document.getElementById('rate-hour').value = rates.hourRate;
656

657
  body.innerHTML = '';
658
  locksDraft.forEach((l, i) => {
659
    const tr = document.createElement('tr');
660
    tr.innerHTML = `
661
      <td>
662
        <input type="number" min="1" max="1440" value="${l.until}" data-i="${i}" data-f="until">
663
        <small class="lock-text" style="color:#64748b;">${minutesToText(l.until)} хүртэл</small>
664
      </td>
665
      <td><input type="number" min="0" value="${l.price}" data-i="${i}" data-f="price"></td>
666
      <td><button type="button" class="btn-danger" onclick="removeLock(${i})">✕</button></td>
667
    `;
668
    body.appendChild(tr);
669
  });
670

671
  body.querySelectorAll('input').forEach(inp => {
672
    inp.addEventListener('input', (e) => {
673
      const i = Number(e.target.dataset.i), f = e.target.dataset.f;
674
      locksDraft[i][f] = Number(e.target.value);
675
      if (f === 'until') {
676
        e.target.parentElement.querySelector('.lock-text').textContent =
677
          minutesToText(locksDraft[i].until) + ' хүртэл';
678
      }
679
    });
680
  });
681
}
682

683
function removeLock(i) {
684
  locksDraft.splice(i, 1);
685
  renderRateEditor();
686
}
687

688
const addLockBtn = document.getElementById('add-lock-btn');
689
if (addLockBtn) {
690
  addLockBtn.addEventListener('click', () => {
691
    const last = locksDraft[locksDraft.length - 1];
692
    locksDraft.push({ until: last ? Math.min(1440, last.until + 60) : 720, price: last ? last.price : 20000 });
693
    renderRateEditor();
694
  });
695
}
696

697
// Handle Parking Rate Settings Form Submission (Admin)
698
const rateForm = document.getElementById('rate-settings-form');
699
if (rateForm) {
700
  rateForm.addEventListener('submit', (e) => {
701
    e.preventDefault();
702

703
    const firstMinutes = parseInt(document.getElementById('rate-first-min').value, 10);
704
    const firstFee = parseInt(document.getElementById('rate-first-fee').value, 10);
705
    const hourRate = parseInt(document.getElementById('rate-hour').value, 10);
706
    const locks = locksDraft.map(l => ({ until: Number(l.until), price: Number(l.price) }));
707

708
    if (isNaN(firstMinutes) || firstMinutes < 0 || isNaN(firstFee) || firstFee < 0) {
709
      alert('Эхний хугацаа болон үнийг зөв оруулна уу.'); return;
710
    }
711
    if (isNaN(hourRate) || hourRate <= 0) { alert('Цаг тутмын үнийг зөв оруулна уу.'); return; }
712
    if (locks.length === 0) { alert('Хамгийн багадаа 1 мөр байх ёстой.'); return; }
713

714
    for (let i = 0; i < locks.length; i++) {
715
      const l = locks[i];
716
      if (!(l.until > 0) || l.until > 1440 || isNaN(l.price) || l.price < 0) {
717
        alert(`${i + 1}-р мөр буруу байна (хугацаа 1–1440 минут).`); return;
718
      }
719
      if (i > 0 && l.until <= locks[i - 1].until) {
720
        alert(`${i + 1}-р мөрийн хугацаа өмнөх мөрөөс их байх ёстой.`); return;
721
      }
722
      if (i > 0 && l.price < locks[i - 1].price) {
723
        alert(`${i + 1}-р мөрийн үнэ өмнөх мөрөөс бага байж болохгүй.`); return;
724
      }
725
    }
726
    if (locks[locks.length - 1].until !== 1440) {
727
      alert('Сүүлийн мөрийн хугацаа 1440 минут (24 цаг) байх ёстой. Энэ нь 24 цагийн үнэ болно.'); return;
728
    }
729

730
    db.ref('rate_settings').set({
731
      firstMinutes, firstFee, hourRate, locks,
732
      updatedBy: currentUser,
733
      timestamp: Date.now()
734
    }).then(() => alert('Үнэ амжилттай хадгалагдлаа!'))
735
      .catch((err) => alert('Алдаа: ' + err.message));
736
  });
737
}
738

739
renderRateEditor();
740

741
// Listen to Database
742
function setupRealtimeListeners() {
743
  if (listenersStarted) return; // init() runs twice after login, so only attach once
744
  listenersStarted = true;
745

746
  db.ref('accounts').on('value', (snap) => {
747
    accountsMap = snap.val() || {};
748
    if (currentRole === 'admin') renderUsersTable();
749
  });
750

751
  db.ref('rate_settings').on('value', (snap) => {
752
    const val = snap.val();
753
    const locks = val ? normalizeLocks(val.locks) : [];
754
    if (val && locks.length && val.hourRate != null) {
755
      rates = {
756
        firstMinutes: val.firstMinutes != null ? Number(val.firstMinutes) : DEFAULT_RATES.firstMinutes,
757
        firstFee: val.firstFee != null ? Number(val.firstFee) : DEFAULT_RATES.firstFee,
758
        hourRate: Number(val.hourRate),
759
        locks: locks
760
      };
761
    } else {
762
      rates = JSON.parse(JSON.stringify(DEFAULT_RATES)); // nothing saved in the new format yet
763
    }
764
    locksDraft = rates.locks.map(l => ({ ...l }));
765
    renderRateEditor();
766
  });
767

768
  db.ref('active_vehicles').on('value', (snap) => {
769
    activeVehiclesMap = snap.val() || {};
770
    renderActiveTable(document.getElementById('search-plate').value);
771
  });
772

773
  db.ref('history_log').limitToLast(3).on('value', (snapshot) => {
774
    const historyData = snapshot.val() || {};
775
    renderActivityLog(historyData);
776
  });
777
}
778

779
if (plateInput) {
780
  plateInput.addEventListener('input', (e) => {
781
    e.target.value = e.target.value.toUpperCase();
782
  });
783
}
784

785
// Entry & Exit Operations
786
checkinForm.addEventListener('submit', (e) => {
787
  e.preventDefault();
788
  const plate = plateInput.value.trim().toUpperCase();
789

790
  // Mongolian Plate Format Regex: 4 digits followed by 3 uppercase letters (Latin or Cyrillic including Ө, Ү)
791
  const mongolianPlateRegex = /^\d{4}[A-ZА-ЯӨҮ]{3}$/i;
792

793
  if (!mongolianPlateRegex.test(plate)) {
794
    alert('Invalid Mongolian Plate Number!\nFormat must be 4 digits followed by 3 letters (e.g., 1234АБВ or 1234ABC).');
795
    return;
796
  }
797

798
  const isParked = Object.values(activeVehiclesMap).some(v => v.plate === plate);
799
  if (isParked) {
800
    alert('This vehicle is already inside!');
801
    return;
802
  }
803

804
  db.ref('active_vehicles').push({
805
    plate: plate,
806
    entryTime: new Date().toISOString(),
807
    entryStaff: currentUser,
808
    timestamp: Date.now()
809
  });
810

811
  plateInput.value = '';
812
});
813

814
function renderActiveTable(filter = '') {
815
  tableBody.innerHTML = '';
816
  const entries = Object.entries(activeVehiclesMap);
817
  activeCount.textContent = entries.length;
818

819
  entries.forEach(([key, v]) => {
820
    if (filter && !v.plate.toLowerCase().includes(filter.toLowerCase())) return;
821

822
    const formattedTime = new Date(v.entryTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
823
    const row = document.createElement('tr');
824
    row.innerHTML = `
825
      <td><strong>${v.plate}</strong></td>
826
      <td>${formattedTime}</td>
827
      <td>${v.entryStaff}${v.manualEntry ? ' <span title="Админ гараар бүртгэсэн">✏️</span>' : ''}</td>
828
      <td><button class="btn-danger" onclick="openCheckoutModal('${key}')">Гаргах</button></td>
829
    `;
830
    tableBody.appendChild(row);
831
  });
832
}
833

834
function filterVehicles() {
835
  const input = document.getElementById('search-plate');
836
  input.value = input.value.toUpperCase();
837
  renderActiveTable(input.value);
838
}
839

840
// Parking fee: every started hour costs hourRate, but the price is "locked" at each
841
// lock's price until that lock's time ends. A full 24h costs the last lock's price,
842
// and the same pattern repeats for every extra day.
843
function calculateParkingFee(totalMinutes, isFreeVehicle) {
844
  if (isFreeVehicle || totalMinutes <= 0) return 0;
845

846
  const { firstMinutes, firstFee, hourRate, locks } = rates;
847
  const DAY = 1440;
848
  const dayPrice = locks[locks.length - 1].price;
849

850
  const fullDays = Math.floor(totalMinutes / DAY);
851
  const rem = totalMinutes % DAY;
852
  if (rem === 0) return fullDays * dayPrice;
853

854
  let fee = dayPrice;
855
  if (fullDays === 0 && rem <= firstMinutes) {
856
    fee = firstFee; // only the very first minutes of the stay
857
  } else {
858
    let base = 0, start = 0;
859
    for (const lock of locks) {
860
      if (rem <= lock.until) {
861
        const hours = Math.ceil((rem - start) / 60);
862
        fee = Math.min(base + hours * hourRate, lock.price);
863
        break;
864
      }
865
      base = lock.price;
866
      start = lock.until;
867
    }
868
  }
869
  return fullDays * dayPrice + fee;
870
}
871

872
// ==========================================
873
// CHECKOUT WITH FROZEN PRICE
874
// ==========================================
875
// Builds a locked copy of everything needed for this checkout. Nothing in the
876
// database is changed, so pressing Cancel simply throws the copy away and the
877
// parking time keeps running from the original entry time.
878
function buildCheckoutSnapshot(key, vehicle) {
879
  const frozenAt = Date.now();
880
  const entryMs = new Date(vehicle.entryTime).getTime();
881
  const totalMinutes = Math.max(1, Math.ceil((frozenAt - entryMs) / 60000));
882

883
  const cleanPlate = vehicle.plate.replace(/[.#$\[\]]/g, '').toUpperCase();
884
  const isFreeVehicle = !!freeVehiclesMap[cleanPlate];
885
  const fee = calculateParkingFee(totalMinutes, isFreeVehicle);
886

887
  const days = Math.floor(totalMinutes / 1440);
888
  const hrs = Math.floor((totalMinutes % 1440) / 60);
889
  const mins = totalMinutes % 60;
890
  const durationText = days > 0 ? `${days}d ${hrs}h ${mins}m` : `${hrs}h ${mins}m`;
891

892
  return {
893
    key,
894
    plate: vehicle.plate,
895
    entryStaff: vehicle.entryStaff,
896
    frozenAt,
897
    totalMinutes,
898
    durationText,
899
    fee,
900
    isFreeVehicle
901
  };
902
}
903

904
function showCheckoutModal() {
905
  const snap = checkoutSnapshot;
906
  if (!snap) return;
907

908
  document.getElementById('modal-plate').textContent = snap.plate;
909
  document.getElementById('modal-duration').textContent = snap.durationText;
910
  document.getElementById('modal-fee').textContent = snap.isFreeVehicle
911
    ? '₮0 (Free / Exempt Vehicle)'
912
    : `₮${snap.fee.toLocaleString()}`;
913

914
  const note = document.getElementById('modal-frozen-note');
915
  if (note) {
916
    note.textContent = `🔒 Үнэ ${new Date(snap.frozenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} цагт хөлдсөн`;
917
  }
918
  document.getElementById('receipt-modal').style.display = 'flex';
919
}
920

921
function openCheckoutModal(key) {
922
  const vehicle = activeVehiclesMap[key];
923
  if (!vehicle) return;
924
  checkoutSnapshot = buildCheckoutSnapshot(key, vehicle);
925
  showCheckoutModal();
926
}
927

928
// Accepts the selected payment method ('Cash', 'Card', 'Transfer' or 'Free')
929
function confirmCheckout(paymentMethod) {
930
  const snap = checkoutSnapshot;
931
  if (!snap) return;
932

933
  const vehicle = activeVehiclesMap[snap.key];
934
  if (!vehicle) {
935
    alert('Энэ машин аль хэдийн гарсан байна.');
936
    closeModal();
937
    return;
938
  }
939

940
  // Safety: if the screen was left open for too long, refresh the price instead of undercharging
941
  if (Date.now() - snap.frozenAt > FREEZE_MAX_MINUTES * 60000) {
942
    checkoutSnapshot = buildCheckoutSnapshot(snap.key, vehicle);
943
    showCheckoutModal();
944
    alert(`Үнэ ${FREEZE_MAX_MINUTES} минутаас илүү хөлдсөн байсан тул шинэчлэгдлээ. Шинэ дүнг шалгаад дахин сонгоно уу.`);
945
    return;
946
  }
947

948
  // Second layer: confirm the chosen payment method before the vehicle leaves.
949
  // Pressing "Cancel" here keeps the frozen price on screen so another method can be chosen.
950
  const methodLabel = PAYMENT_LABELS[paymentMethod] || paymentMethod;
951
  const payAmount = paymentMethod === 'Free' ? 0 : snap.fee;
952
  if (!confirm(`Машин: ${snap.plate}\nДүн: ₮${payAmount.toLocaleString()}\nТөлбөрийн хэлбэр: ${methodLabel}\n\nЭнэ машиныг энэ хэлбэрээр гаргахдаа итгэлтэй байна уу?`)) return;
953

954
  db.ref('history_log').push({
955
    plate: snap.plate,
956
    entryStaff: snap.entryStaff,
957
    exitStaff: currentUser,
958
    duration: snap.durationText,
959
    fee: paymentMethod === 'Free' ? 0 : snap.fee,
960
    calculatedFee: snap.fee,      // original price, so a wrong 'Free' can be corrected later
961
    paymentMethod: paymentMethod, // Log payment method to Firebase
962
    exitTime: snap.frozenAt,      // the moment the price was frozen
963
    timestamp: Date.now()
964
  });
965

966
  db.ref(`active_vehicles/${snap.key}`).remove();
967
  closeModal();
968
}
969

970
// Cancel / close: the frozen copy is discarded, nothing was changed in the database
971
function closeModal() {
972
  document.getElementById('receipt-modal').style.display = 'none';
973
  checkoutSnapshot = null;
974
}
975

976
function deleteRecord(key) {
977
  if (confirm('Delete this transaction log?')) {
978
    db.ref(`history_log/${key}`).remove();
979
  }
980
}
981

982
function runAutoCleanup() {
983
  const cutoff = Date.now() - (PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000);
984
  db.ref('history_log').once('value', (snap) => {
985
    const logs = snap.val();
986
    if (logs) {
987
      Object.entries(logs).forEach(([key, r]) => {
988
        if (r.timestamp && r.timestamp < cutoff) db.ref(`history_log/${key}`).remove();
989
      });
990
    }
991
  });
992
}
993

994
function generateQRCode() {
995
  const container = document.getElementById('qrcode');
996
  container.innerHTML = '';
997
  new QRCode(container, { text: window.location.href, width: 120, height: 120 });
998
}
999

1000
// Automatically cleanup logs older than 14 days (1,209,600,000 ms)
1001
function cleanupOldLogs() {
1002
  const fourteenDaysAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
1003

1004
  db.ref('history_log')
1005
    .orderByChild('timestamp')
1006
    .endAt(fourteenDaysAgo)
1007
    .once('value', (snapshot) => {
1008
      const oldLogs = snapshot.val();
1009
      if (oldLogs) {
1010
        const updates = {};
1011
        Object.keys(oldLogs).forEach((key) => {
1012
          updates[`history_log/${key}`] = null; // null deletes the entry
1013
        });
1014

1015
        db.ref().update(updates)
1016
          .then(() => console.log('Old logs (>14 days) cleaned up successfully.'))
1017
          .catch((err) => console.error('Error cleaning up logs:', err));
1018
      }
1019
    });
1020
}
1021

1022
// ==========================================
1023
// MANUAL VEHICLE REGISTRATION (ADMIN)
1024
// ==========================================
1025
function toLocalInputValue(date) {
1026
  // datetime-local needs "YYYY-MM-DDTHH:MM" in LOCAL time (toISOString would give UTC)
1027
  const pad = (n) => String(n).padStart(2, '0');
1028
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
1029
         `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
1030
}
1031

1032
const manualEntryForm = document.getElementById('manual-entry-form');
1033
const manualTimeInput = document.getElementById('manual-time-input');
1034
const manualPlateInput = document.getElementById('manual-plate-input');
1035

1036
if (manualTimeInput) manualTimeInput.value = toLocalInputValue(new Date());
1037

1038
if (manualPlateInput) {
1039
  manualPlateInput.addEventListener('input', (e) => {
1040
    e.target.value = e.target.value.toUpperCase();
1041
  });
1042
}
1043

1044
if (manualEntryForm) {
1045
  manualEntryForm.addEventListener('submit', (e) => {
1046
    e.preventDefault();
1047

1048
    if (currentRole !== 'admin') {
1049
      alert('Зөвхөн админ гараар бүртгэх эрхтэй.');
1050
      return;
1051
    }
1052

1053
    const plate = manualPlateInput.value.trim().toUpperCase();
1054
    const timeValue = manualTimeInput.value;
1055
    const staffName = document.getElementById('manual-staff-input').value.trim().toLowerCase();
1056

1057
    const mongolianPlateRegex = /^\d{4}[A-ZА-ЯӨҮ]{3}$/i;
1058
    if (!mongolianPlateRegex.test(plate)) {
1059
      alert('Улсын Дугаар буруу байна!\n4 тоо, 3 үсэг форматаар бичнэ үү (жишээ нь: 1234АБВ эсвэл 1234ABC).');
1060
      return;
1061
    }
1062

1063
    if (!timeValue) {
1064
      alert('Орсон цагийг сонгоно уу.');
1065
      return;
1066
    }
1067

1068
    const entryDate = new Date(timeValue);
1069
    const now = new Date();
1070

1071
    if (entryDate > now) {
1072
      alert('Орсон цаг ирээдүйд байж болохгүй.');
1073
      return;
1074
    }
1075

1076
    const hoursAgo = (now - entryDate) / (1000 * 60 * 60);
1077
    if (hoursAgo > 24) {
1078
      if (!confirm(`Энэ машин ${Math.floor(hoursAgo)} цагийн өмнө орсон гэж бүртгэгдэх гэж байна. Үргэлжлүүлэх үү?`)) return;
1079
    }
1080

1081
    const isParked = Object.values(activeVehiclesMap).some(v => v.plate === plate);
1082
    if (isParked) {
1083
      alert('Энэ машин аль хэдийн зогсоолд бүртгэлтэй байна!');
1084
      return;
1085
    }
1086

1087
    db.ref('active_vehicles').push({
1088
      plate: plate,
1089
      entryTime: entryDate.toISOString(),
1090
      entryStaff: staffName || currentUser,
1091
      manualEntry: true,
1092
      addedBy: currentUser,
1093
      timestamp: Date.now()
1094
    }).then(() => {
1095
      manualPlateInput.value = '';
1096
      document.getElementById('manual-staff-input').value = '';
1097
      manualTimeInput.value = toLocalInputValue(new Date());
1098
      alert(`${plate} амжилттай бүртгэгдлээ.`);
1099
    }).catch((err) => alert('Бүртгэхэд алдаа гарлаа: ' + err.message));
1100
  });
1101
}
1102

1103
// Run cleanup every time the app initializes
1104
cleanupOldLogs();
1105
