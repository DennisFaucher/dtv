let scanPollInterval = null;

// Verify Admin Session on Load
async function verifyAdmin() {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) {
      window.location.href = '/login.html';
      return;
    }
    
    const user = await response.json();
    if (!user.isAdmin) {
      window.location.href = '/';
      return;
    }

    // Load page data
    loadPendingUsers();
    loadAllUsers();
    loadFolders();
    loadScanIntervals();
    startScanStatusPolling();
  } catch (err) {
    window.location.href = '/login.html';
  }
}

// 1. PENDING USER REGISTRATIONS
async function loadPendingUsers() {
  const container = document.getElementById('pending-users-list');
  const countBadge = document.getElementById('pending-count');
  container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">Loading registration requests...</div>';

  try {
    const response = await fetch('/api/admin/users/pending');
    if (!response.ok) throw new Error('Failed to load pending users');
    const users = await response.json();

    countBadge.innerText = `${users.length} User${users.length === 1 ? '' : 's'}`;

    if (users.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); padding: 15px 0; font-size: 0.9rem;">No pending approvals. All registered users are approved.</div>';
      return;
    }

    container.innerHTML = '';
    users.forEach(user => {
      const dateStr = new Date(user.created_at).toLocaleString();
      const row = document.createElement('div');
      row.className = 'request-item';
      row.innerHTML = `
        <div class="request-info">
          <div class="request-email">${user.email}</div>
          <div class="request-date">Registered: ${dateStr}</div>
        </div>
        <div class="request-actions">
          <button class="btn btn-success btn-sm" onclick="approveUser(${user.id})">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="denyUser(${user.id})">Deny</button>
        </div>
      `;
      container.appendChild(row);
    });
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger); font-size: 0.9rem;">Error: ${err.message}</div>`;
  }
}

async function approveUser(id) {
  try {
    const response = await fetch(`/api/admin/users/${id}/approve`, { method: 'POST' });
    if (response.ok) {
      loadPendingUsers();
    } else {
      const data = await response.json();
      alert(`Approval failed: ${data.error}`);
    }
  } catch (err) {
    alert('Server communication error.');
  }
}

async function denyUser(id) {
  if (!confirm('Are you sure you want to deny and delete this registration request?')) return;
  try {
    const response = await fetch(`/api/admin/users/${id}/deny`, { method: 'POST' });
    if (response.ok) {
      loadPendingUsers();
    } else {
      const data = await response.json();
      alert(`Denial failed: ${data.error}`);
    }
  } catch (err) {
    alert('Server communication error.');
  }
}

// 2. USER MANAGEMENT
async function loadAllUsers() {
  const container = document.getElementById('users-list');
  const countBadge = document.getElementById('user-count');
  container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">Loading users...</div>';

  try {
    const res = await fetch('/api/admin/users');
    if (!res.ok) throw new Error('Failed to load users');
    const users = await res.json();

    countBadge.innerText = `${users.length} User${users.length === 1 ? '' : 's'}`;

    container.innerHTML = '';
    users.forEach(user => {
      const row = document.createElement('div');
      row.className = 'request-item';
      const badges = [];
      if (user.is_admin) badges.push(`<span class="folder-type" style="background:rgba(99,102,241,0.15);color:var(--accent-primary);margin:0;">Admin</span>`);
      if (!user.is_approved) badges.push(`<span class="folder-type" style="background:rgba(239,68,68,0.15);color:var(--danger);margin:0;">Pending</span>`);
      row.innerHTML = `
        <div class="request-info">
          <div class="request-email" style="display:flex;align-items:center;gap:8px;">
            ${user.email}
            ${badges.join('')}
          </div>
          <div class="request-date">Registered: ${new Date(user.created_at).toLocaleString()}</div>
        </div>
        <div class="request-actions">
          ${!user.is_admin ? `<button class="btn btn-danger btn-sm" onclick="removeUser(${user.id}, '${user.email}')">Remove</button>` : ''}
        </div>
      `;
      container.appendChild(row);
    });
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger); font-size: 0.9rem;">Error: ${err.message}</div>`;
  }
}

async function removeUser(id, email) {
  if (!confirm(`Remove user "${email}"? This cannot be undone.`)) return;
  try {
    const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { alert(data.error); return; }
    loadAllUsers();
  } catch {
    alert('Server communication error.');
  }
}

// 4. FOLDER MANAGEMENT
async function loadFolders() {
  const container = document.getElementById('folders-list');
  container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem;">Loading folders...</div>';

  try {
    const response = await fetch('/api/admin/folders');
    if (!response.ok) throw new Error('Failed to load folders');
    const folders = await response.json();

    if (folders.length === 0) {
      container.innerHTML = '<div style="color: var(--text-muted); font-size: 0.9rem; padding: 10px 0;">No folders configured. Set up scan libraries above.</div>';
      return;
    }

    container.innerHTML = '';
    folders.forEach(folder => {
      const row = document.createElement('div');
      row.className = 'folder-item';
      row.innerHTML = `
        <div class="folder-path" title="${folder.path}">${folder.path}</div>
        <div style="display: flex; align-items: center;">
          <span class="folder-type">${folder.type}</span>
          <button class="btn btn-danger btn-sm" onclick="removeFolder(${folder.id})" style="padding: 4px 8px; font-size: 0.75rem;">Remove</button>
        </div>
      `;
      container.appendChild(row);
    });
  } catch (err) {
    container.innerHTML = `<div style="color: var(--danger); font-size: 0.9rem;">Error: ${err.message}</div>`;
  }
}

async function handleAddFolder(event) {
  event.preventDefault();
  const pathInput = document.getElementById('folder-path');
  const typeSelect = document.getElementById('folder-type');
  const alertBox = document.getElementById('folder-alert');

  alertBox.style.display = 'none';
  alertBox.className = 'alert';

  try {
    const response = await fetch('/api/admin/folders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path: pathInput.value,
        type: typeSelect.value
      })
    });

    const data = await response.json();

    if (response.ok) {
      alertBox.innerText = data.message;
      alertBox.className = 'alert alert-success';
      alertBox.style.display = 'block';
      pathInput.value = '';
      loadFolders();
    } else {
      alertBox.innerText = data.error;
      alertBox.className = 'alert alert-danger';
      alertBox.style.display = 'block';
    }
  } catch (err) {
    alertBox.innerText = 'Failed to connect to server.';
    alertBox.className = 'alert alert-danger';
    alertBox.style.display = 'block';
  }
}

async function removeFolder(id) {
  if (!confirm('Are you sure you want to remove this folder? (Media files in DB linked to this folder will be swept during the next scan)')) return;
  try {
    const response = await fetch(`/api/admin/folders/${id}`, { method: 'DELETE' });
    if (response.ok) {
      loadFolders();
    } else {
      const data = await response.json();
      alert(`Removal failed: ${data.error}`);
    }
  } catch (err) {
    alert('Server communication error.');
  }
}

// 3. MEDIA SCANNER MANAGEMENT
async function triggerScan() {
  const triggerBtn = document.getElementById('scan-trigger-btn');
  triggerBtn.disabled = true;

  try {
    const response = await fetch('/api/admin/scan', { method: 'POST' });
    if (response.ok) {
      startScanStatusPolling();
    } else {
      const data = await response.json();
      alert(`Failed to trigger scan: ${data.error}`);
      triggerBtn.disabled = false;
    }
  } catch (err) {
    alert('Server communication error.');
    triggerBtn.disabled = false;
  }
}

function startScanStatusPolling() {
  if (scanPollInterval) clearInterval(scanPollInterval);
  
  // Poll immediately, then every 1.5 seconds
  pollScanStatus();
  scanPollInterval = setInterval(pollScanStatus, 1500);
}

async function pollScanStatus() {
  const badge = document.getElementById('scan-status-badge');
  const fill = document.getElementById('scan-progress-fill');
  const statProcessed = document.getElementById('stat-processed');
  const statAdded = document.getElementById('stat-added');
  const statRemoved = document.getElementById('stat-removed');
  const triggerBtn = document.getElementById('scan-trigger-btn');
  const errContainer = document.getElementById('scan-errors-container');
  const errList = document.getElementById('scan-errors-list');

  try {
    const response = await fetch('/api/admin/scan/status');
    if (!response.ok) throw new Error('Status poll failed');
    const status = await response.json();

    // Update status badge
    badge.innerText = status.status.toUpperCase();
    if (status.status === 'scanning') {
      badge.style.background = 'rgba(99, 102, 241, 0.2)';
      badge.style.color = 'var(--accent-primary)';
      triggerBtn.disabled = true;
      triggerBtn.innerText = 'Scanning...';
    } else if (status.status === 'completed') {
      badge.style.background = 'rgba(16, 185, 129, 0.15)';
      badge.style.color = 'var(--success)';
      triggerBtn.disabled = false;
      triggerBtn.innerText = 'Scan Media Libraries';
      clearInterval(scanPollInterval); // Stop polling when done
      scanPollInterval = null;
    } else if (status.status === 'error') {
      badge.style.background = 'rgba(239, 68, 68, 0.15)';
      badge.style.color = 'var(--danger)';
      triggerBtn.disabled = false;
      triggerBtn.innerText = 'Scan Media Libraries';
      clearInterval(scanPollInterval);
      scanPollInterval = null;
    } else {
      badge.style.background = 'rgba(255, 255, 255, 0.05)';
      badge.style.color = 'var(--text-muted)';
      triggerBtn.disabled = false;
      triggerBtn.innerText = 'Scan Media Libraries';
    }

    // Update progress bar
    if (status.totalFiles > 0) {
      const percentage = Math.round((status.processedFiles / status.totalFiles) * 100);
      fill.style.width = `${percentage}%`;
    } else {
      fill.style.width = status.status === 'completed' ? '100%' : '0%';
    }

    // Update stats values
    statProcessed.innerText = status.processedFiles;
    statAdded.innerText = status.added;
    statRemoved.innerText = status.removed;

    // Render error logs
    if (status.errors && status.errors.length > 0) {
      errList.innerHTML = '';
      status.errors.forEach(err => {
        const li = document.createElement('li');
        li.innerText = err;
        errList.appendChild(li);
      });
      errContainer.style.display = 'block';
    } else {
      errContainer.style.display = 'none';
    }

  } catch (err) {
    console.error('Scan polling error:', err);
  }
}

// 4. SCAN INTERVALS
async function loadScanIntervals() {
  try {
    const res = await fetch('/api/admin/scan-intervals');
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('interval-movie').value = String(data.movie || 0);
    document.getElementById('interval-tv').value = String(data.tv || 0);
    document.getElementById('interval-music').value = String(data.music || 0);
  } catch {}
}

async function saveScanIntervals() {
  const msg = document.getElementById('interval-save-msg');
  msg.style.display = 'none';
  try {
    const res = await fetch('/api/admin/scan-intervals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        movie: parseInt(document.getElementById('interval-movie').value, 10),
        tv:    parseInt(document.getElementById('interval-tv').value, 10),
        music: parseInt(document.getElementById('interval-music').value, 10),
      })
    });
    if (!res.ok) throw new Error();
    msg.style.display = 'inline';
    setTimeout(() => msg.style.display = 'none', 3000);
  } catch {
    alert('Failed to save intervals.');
  }
}

document.addEventListener('DOMContentLoaded', verifyAdmin);
