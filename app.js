// 1. Firebase Credentials
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const ADMIN_PIN = "1234"; // Default Admin PIN
const PURGE_AFTER_DAYS = 2; // Auto cleanup interval

// App State
let currentUser = localStorage.getItem('parking_user') || null;
let currentRole = localStorage.getItem('parking_role') || 'employee';
let activeVehiclesMap = {};
let historyLogMap = {};
let selectedVehicleKey = null;

let hourlyRate = 5.00;
let minFee = 2.00;

// DOM Elements
const loginOverlay = document.getElementById('login-overlay');
const loginForm = document.getElementById('login-form');
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

function toggleAdminPinInput() {
  const role = document.getElementById('user-role').value;
  document.getElementById('pin-group').style.display = role === 'admin' ? 'block' : 'none';
}

// Authentication
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const role = document.getElementById('user-role').value;
  const name = document.getElementById('employee-name').value.trim();
  const pin = document.getElementById('admin-pin').value;

  if (role === 'admin' && pin !== ADMIN_PIN) {
    alert('Incorrect Admin PIN!');
    return;
  }

  currentUser = name;
  currentRole = role;
  localStorage.setItem('parking_user', currentUser);
  localStorage.setItem('parking_role', currentRole);
  init();
});

function logout() {
  localStorage.removeItem('parking_user');
  localStorage.removeItem('parking_role');
  currentUser = null;
  init();
}

// Settings Update (Admin Only)
function saveRates() {
  hourlyRate = parseFloat(document.getElementById('setting-rate').value) || 5;
  minFee = parseFloat(document.getElementById('setting-min').value) || 2;
  db.ref('settings').set({ hourlyRate, minFee });
  alert('Pricing updated successfully!');
}

// Listen to Database
function setupRealtimeListeners() {
  db.ref('settings').on('value', (snap) => {
    const val = snap.val();
    if (val) {
      hourlyRate = val.hourlyRate || 5;
      minFee = val.minFee || 2;
      document.getElementById('setting-rate').value = hourlyRate;
      document.getElementById('setting-min').value = minFee;
    }
  });

  db.ref('active_vehicles').on('value', (snap) => {
    activeVehiclesMap = snap.val() || {};
    renderActiveTable();
  });

  db.ref('history_log').on('value', (snap) => {
    historyLogMap = snap.val() || {};
    renderHistoryTable();
  });
}

// Entry & Exit Operations
checkinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const plate = plateInput.value.trim().toUpperCase();

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

function openCheckoutModal(key) {
  selectedVehicleKey = key;
  const vehicle = activeVehiclesMap[key];
  
  const entryTime = new Date(vehicle.entryTime);
  const exitTime = new Date();
  const totalMinutes = Math.ceil((exitTime - entryTime) / (1000 * 60));
  const totalHours = Math.ceil(totalMinutes / 60);

  let fee = Math.max(totalHours * hourlyRate, minFee);
  const hrs = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;

  document.getElementById('modal-plate').textContent = vehicle.plate;
  document.getElementById('modal-duration').textContent = `${hrs}h ${mins}m`;
  document.getElementById('modal-fee').textContent = `$${fee.toFixed(2)}`;
  
  vehicle.calculatedFee = fee;
  vehicle.durationText = `${hrs}h ${mins}m`;
  document.getElementById('receipt-modal').style.display = 'flex';
}

function confirmCheckout() {
  if (selectedVehicleKey && activeVehiclesMap[selectedVehicleKey]) {
    const v = activeVehiclesMap[selectedVehicleKey];
    db.ref('history_log').push({
      plate: v.plate,
      entryStaff: v.entryStaff,
      exitStaff: currentUser,
      duration: v.durationText,
      fee: v.calculatedFee,
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
