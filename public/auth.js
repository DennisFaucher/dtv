// Handle Login/Register Tab Toggling
function switchTab(mode) {
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const tabLogin = document.getElementById('tab-login');
  const tabRegister = document.getElementById('tab-register');
  const alertBox = document.getElementById('alert-box');

  // Clear alerts
  alertBox.style.display = 'none';
  alertBox.className = 'alert';

  if (mode === 'login') {
    loginForm.style.display = 'block';
    registerForm.style.display = 'none';
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
  } else {
    loginForm.style.display = 'none';
    registerForm.style.display = 'block';
    tabLogin.classList.remove('active');
    tabRegister.classList.add('active');
  }
}

// Display Alerts
function showAlert(message, type = 'danger') {
  const alertBox = document.getElementById('alert-box');
  alertBox.innerText = message;
  alertBox.className = `alert alert-${type}`;
  alertBox.style.display = 'block';
}

// Handle Login Form Submission
async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.ok) {
      // Login successful, redirect to dashboard
      window.location.href = '/';
    } else {
      showAlert(data.error || 'Login failed. Please check credentials.', 'danger');
    }
  } catch (err) {
    showAlert('Server connection error. Please try again.', 'danger');
  }
}

// Handle Register Form Submission
async function handleRegister(event) {
  event.preventDefault();
  const email = document.getElementById('register-email').value;
  const password = document.getElementById('register-password').value;

  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (response.ok) {
      showAlert(data.message, 'success');
      // Clear forms
      document.getElementById('register-form').reset();
      // Switch back to login after showing success
      setTimeout(() => {
        switchTab('login');
      }, 5000);
    } else {
      showAlert(data.error || 'Registration failed.', 'danger');
    }
  } catch (err) {
    showAlert('Server connection error. Please try again.', 'danger');
  }
}

// Check session on page load
async function checkSession() {
  try {
    const response = await fetch('/api/auth/me');
    if (response.ok) {
      // Already logged in, redirect to main page
      window.location.href = '/';
    }
  } catch (err) {
    // Ignore error, session just not established
  }
}

document.addEventListener('DOMContentLoaded', checkSession);
