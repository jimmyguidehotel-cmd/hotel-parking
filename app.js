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

let hourlyRate = 5.00;
let minFee = 2.00;

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
  currentRole = 'employee';

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

// Settings Update (Admin Only)
function saveRates() {
  hourlyRate = parseFloat(document.getElementById('setting-rate').value) || 5;
  minFee = parseFloat(document.getElementById('setting-min').value) || 2;
  db.ref('settings').set({ hourlyRate, minFee });
  alert('Pricing updated successfully!');
}

// Listen to Database
function setupRealtimeListeners() {
  db.ref('accounts').on('value', (snap) => {
    accountsMap = snap.val() || {};
    if (currentRole === 'admin') renderUsersTable();
  });

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

function filterVehicles() {
  const query = document.getElementById('search-plate').value;
  renderActiveTable(query);
}

function openCheckoutModal(plate, entryTime, duration, fee) {
  const modalOverlay = document.getElementById('checkout-modal-overlay');
  
  modalOverlay.innerHTML = `
    <div style="background: white; padding: 2rem; border-radius: 12px; text-align: center; max-width: 420px; margin: auto; box-shadow: 0 10px 25px rgba(0,0,0,0.2);">
      <h2 style="color: #1e3a8a; margin-bottom: 0.5rem;">Vehicle Exit & Payment</h2>
      <p style="font-size: 1.1rem; color: #334155; margin-bottom: 1rem;">
        Plate: <strong>${plate}</strong><br>
        Total Fee: <strong style="color: #16a34a; font-size: 1.25rem;">$${fee}</strong>
      </p>

      <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 1.5rem;">
        <button onclick="completeCheckout('${plate}', 'Cash', ${fee})" style="background-color: #16a34a; color: white; padding: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">
          💵 Cash & Complete
        </button>
        
        <button onclick="completeCheckout('${plate}', 'Card', ${fee})" style="background-color: #2563eb; color: white; padding: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">
          💳 Card & Complete
        </button>
        
        <button onclick="completeCheckout('${plate}', 'Transfer', ${fee})" style="background-color: #9333ea; color: white; padding: 12px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">
          📲 Transfer & Complete
        </button>

        <button onclick="closeCheckoutModal()" style="background-color: #64748b; color: white; padding: 10px; border: none; border-radius: 8px; margin-top: 5px; cursor: pointer;">
          Cancel
        </button>
      </div>
    </div>
  `;
  
  modalOverlay.style.display = 'flex';
}

function closeCheckoutModal() {
  const modalOverlay = document.getElementById('checkout-modal-overlay');
  if (modalOverlay) modalOverlay.style.display = 'none';
}
function completeCheckout(plate, paymentMethod, fee) {
  // 1. Remove vehicle from active_vehicles node
  firebase.database().ref('active_vehicles/' + plate).remove();

  // 2. Add entry to recent activity logs
  const logRef = firebase.database().ref('activity_logs').push();
  logRef.set({
    plate: plate,
    exitTime: new Date().toISOString(),
    fee: fee,
    paymentMethod: paymentMethod,
    processedBy: currentUser || 'Staff'
  });

  // 3. Close modal
  closeCheckoutModal();
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
