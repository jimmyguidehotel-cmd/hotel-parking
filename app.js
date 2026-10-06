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
let currentRole = localStorage.getItem('parking_role') || 'employee';
let accountsMap = {};
let activeVehiclesMap = {};
let historyLogMap = {};
let selectedVehicleKey = null;
let freeVehiclesMap = {};

let rates = {
  halfHourRate: 1000,
  cap5to12Hrs: 10000,
  dayRate: 20000
};

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
const adminColHeader = document.getElementById('admin-col-header');

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
      adminColHeader.style.display = 'table-cell';
      generateQRCode();
    } else {
      adminPanel.style.display = 'none';
      qrSection.style.display = 'none';
      adminColHeader.style.display = 'none';
    }
  } else {
    loginOverlay.style.display = 'flex';
  }

  setupRealtimeListeners();
  runAutoCleanup();
}

// User Authentication (Login)
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
      <h2 style="color: #1e3a8a; margin-bottom: 0.5rem;">Welcome Back!</h2>
      <p style="font-size: 1.15rem; color: #334155; margin-bottom: 1rem;">
        Good morning, <strong>${currentUser}</strong>! Let's crush it today!
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

// Dedicated Logout Function
// Logout with custom farewell panel
function logout() {
  const name = currentUser ? currentUser : 'User';
  
  // Clear local storage session
  localStorage.removeItem('parking_user');
  localStorage.removeItem('parking_role');
  currentUser = null;
  currentRole = 'ажилтан';

  // Hide main app views
  document.getElementById('admin-panel').style.display = 'none';

  // Customize and show the farewell message overlay
  const loginOverlay = document.getElementById('login-overlay');
  loginOverlay.innerHTML = `
    <div style="background: white; padding: 2rem; border-radius: 12px; text-align: center; max-width: 400px; margin: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
      <h2 style="color: #1e3a8a; margin-bottom: 0.5rem;">Logged Out</h2>
      <p style="font-size: 1.1rem; color: #334155; margin-bottom: 1rem;">
        <strong>${name}</strong>, you have logged out. Have a great day!
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
      alert('Invalid Mongolian Plate Number!\nFormat must be 4 digits followed by 3 letters (e.g., 1234АБВ or 1234ABC).');
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

// Handle Parking Rate Settings Form Submission (Admin)
const rateForm = document.getElementById('rate-settings-form');
if (rateForm) {
  rateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const halfHour = parseInt(document.getElementById('rate-30min').value, 10);
    const cap5h = parseInt(document.getElementById('rate-5to12h').value, 10);
    const dayCap = parseInt(document.getElementById('rate-24h').value, 10);

    db.ref('rate_settings').set({
      halfHourRate: halfHour,
      cap5to12Hrs: cap5h,
      dayRate: dayCap,
      updatedBy: currentUser,
      timestamp: Date.now()
    }).then(() => {
      alert('Parking rates updated successfully!');
    }).catch((err) => {
      alert('Error saving rates: ' + err.message);
    });
  });
}



// Listen to Database
function setupRealtimeListeners() {
  db.ref('accounts').on('value', (snap) => {
    accountsMap = snap.val() || {};
    if (currentRole === 'admin') renderUsersTable();
  });

  db.ref('rate_settings').on('value', (snap) => {
    const val = snap.val();
    if (val) {
      rates = { ...rates, ...val };
      
      const rate30Input = document.getElementById('rate-30min');
      const rate5to12Input = document.getElementById('rate-5to12h');
      const rate24Input = document.getElementById('rate-24h');

      if (rate30Input) rate30Input.value = rates.halfHourRate || 1000;
      if (rate5to12Input) rate5to12Input.value = rates.cap5to12Hrs || 10000;
      if (rate24Input) rate24Input.value = rates.dayRate || 20000;
    }
  });

  db.ref('active_vehicles').on('value', (snap) => {
    activeVehiclesMap = snap.val() || {};
    renderActiveTable();
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
      <td>${v.entryStaff}</td>
      <td><button class="btn-danger" onclick="openCheckoutModal('${key}')">Exit</button></td>
    `;
    tableBody.appendChild(row);
  });
}

function filterVehicles() {
  const query = document.getElementById('search-plate').value;
  renderActiveTable(query);
}


// Updated Checkout Modal Handler
// Dynamic parking fee calculation helper
function calculateParkingFee(totalMinutes, isFreeVehicle) {
  if (isFreeVehicle || totalMinutes <= 0) return 0;

  const HALF_HOUR_RATE = rates.halfHourRate || 1000;
  const CAP_5_TO_12_HRS = rates.cap5to12Hrs || 10000;
  const DAY_RATE = rates.dayRate || 20000;

  const fullDays = Math.floor(totalMinutes / (24 * 60));
  const remainingMinutes = totalMinutes % (24 * 60);

  let remainingFee = 0;

  if (remainingMinutes > 0) {
    // 0 to 5 hours (0 - 300 mins)
    if (remainingMinutes <= 300) {
      const halfHourBlocks = Math.ceil(remainingMinutes / 30);
      remainingFee = halfHourBlocks * HALF_HOUR_RATE;
    } 
    // 5 to 12 hours (301 - 720 mins)
    else if (remainingMinutes <= 720) {
      remainingFee = CAP_5_TO_12_HRS;
    } 
    // 12 to 17 hours (721 - 1020 mins)
    else if (remainingMinutes <= 1020) {
      const extraMinutes = remainingMinutes - 720;
      const extraBlocks = Math.ceil(extraMinutes / 30);
      remainingFee = CAP_5_TO_12_HRS + (extraBlocks * HALF_HOUR_RATE);
    } 
    // 17 to 24 hours (1021 - 1440 mins)
    else {
      remainingFee = DAY_RATE;
    }
  }

  return (fullDays * DAY_RATE) + remainingFee;
}

// Updated Checkout Modal Handler
function openCheckoutModal(key) {
  selectedVehicleKey = key;
  const vehicle = activeVehiclesMap[key];
  
  const entryTime = new Date(vehicle.entryTime);
  const exitTime = new Date();
  const totalMinutes = Math.max(1, Math.ceil((exitTime - entryTime) / (1000 * 60)));

  const cleanPlate = vehicle.plate.replace(/[.#$\[\]]/g, '').toUpperCase();
  const isFreeVehicle = !!freeVehiclesMap[cleanPlate];

  // Dynamic fee calculation using Admin rate tiers
  const fee = calculateParkingFee(totalMinutes, isFreeVehicle);

  const days = Math.floor(totalMinutes / (24 * 60));
  const hrs = Math.floor((totalMinutes % (24 * 60)) / 60);
  const mins = totalMinutes % 60;

  let durationString = `${hrs}h ${mins}m`;
  if (days > 0) {
    durationString = `${days}d ${hrs}h ${mins}m`;
  }

  document.getElementById('modal-plate').textContent = vehicle.plate;
  document.getElementById('modal-duration').textContent = durationString;
  
  if (isFreeVehicle) {
    document.getElementById('modal-fee').textContent = `₮0 (Free / Exempt Vehicle)`;
  } else {
    document.getElementById('modal-fee').textContent = `₮${fee.toLocaleString()}`;
  }
  
  vehicle.calculatedFee = fee;
  vehicle.durationText = durationString;
  document.getElementById('receipt-modal').style.display = 'flex';
}

// Updated to accept the selected payment method ('Cash', 'Card', or 'Transfer')
function confirmCheckout(paymentMethod) {
  if (selectedVehicleKey && activeVehiclesMap[selectedVehicleKey]) {
    const v = activeVehiclesMap[selectedVehicleKey];
    
    db.ref('history_log').push({
      plate: v.plate,
      entryStaff: v.entryStaff,
      exitStaff: currentUser,
      duration: v.durationText,
      fee: v.calculatedFee,
      paymentMethod: paymentMethod, // Log payment method to Firebase
      timestamp: Date.now()
    });

    db.ref(`active_vehicles/${selectedVehicleKey}`).remove();
    closeModal();
  }
}

function closeModal() {
  document.getElementById('receipt-modal').style.display = 'none';
  selectedVehicleKey = null;
}
function renderHistoryTable() {
  historyBody.innerHTML = '';
  const history = Object.entries(historyLogMap).sort((a,b) => b[1].timestamp - a[1].timestamp);

  history.slice(0, 10).forEach(([key, record]) => {
    const row = document.createElement('tr');
    let deleteBtn = currentRole === 'admin' 
      ? `<td><button onclick="deleteRecord('${key}')" class="btn-danger">Delete</button></td>` 
      : '';

    row.innerHTML = `
      <td><strong>${record.plate}</strong></td>
      <td>${record.entryStaff} / ${record.exitStaff}</td>
      <td><strong>$${record.fee.toFixed(2)}</strong></td>
      ${deleteBtn}
    `;
    historyBody.appendChild(row);
  });
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

// Run cleanup every time the app initializes
cleanupOldLogs();
