// ============================================
// Browser Wallet — Design Prototype App
// ============================================

// --- BIP 177 ₿-only Format ---
// Amounts stored as integers (base units). Displayed as ₿ + comma-separated integer.
// No decimals, no "sats" terminology. See: bitcoin.design/guide/designing-products/units-and-symbols
function formatBtc(satoshis) {
  return '₿' + Number(satoshis).toLocaleString('en-US')
}

// --- Hash Router ---
const routes = ['home', 'send', 'send-review', 'send-success', 'activity', 'settings', 'advanced', 'open-channel', 'close-channel', 'peers']
const overlays = ['receive']

function navigate(hash) {
  window.location.hash = hash
}

function getRoute() {
  const hash = window.location.hash.slice(1) || 'home'
  return hash
}

function updateScreen() {
  const route = getRoute()

  // Handle overlays (receive modal)
  overlays.forEach((id) => {
    const el = document.getElementById(id)
    if (el) el.classList.toggle('active', route === id)
  })

  // If overlay is active, don't change underlying screens
  if (overlays.includes(route)) return

  // Handle screens
  document.querySelectorAll('.screen').forEach((screen) => {
    screen.classList.toggle('active', screen.id === route)
  })

  // Update tab bar active state
  const walletRoutes = ['home', 'send', 'send-review', 'send-success']
  document.querySelectorAll('.tab-bar__tab').forEach((tab) => {
    const tabRoute = tab.dataset.route
    if (tabRoute === 'home') {
      tab.classList.toggle('active', walletRoutes.includes(route))
    } else {
      tab.classList.toggle('active', tabRoute === route)
    }
  })
}

window.addEventListener('hashchange', updateScreen)

// --- Numpad Logic ---
let sendAmount = ''
const MAX_DIGITS = 8

function updateAmountDisplay() {
  const display = document.getElementById('send-amount-value')
  const nextBtn = document.getElementById('numpad-next')
  if (!display) return

  const satoshis = sendAmount ? Number(sendAmount) : 0
  display.textContent = formatBtc(satoshis)

  // Update remaining balance display
  const remaining = document.querySelector('.send__remaining')
  if (remaining) {
    const available = 100000000 - satoshis
    remaining.textContent = formatBtc(Math.max(0, available)) + ' available'
  }

  // Scale down for large numbers
  const amountEl = document.querySelector('.send__amount')
  if (amountEl) {
    amountEl.classList.toggle('send__amount--small', sendAmount.length > 5)
  }

  // Enable/disable next button
  if (nextBtn) {
    nextBtn.disabled = !sendAmount || sendAmount === '0'
  }
}

function onNumpadKey(key) {
  if (key === 'backspace') {
    sendAmount = sendAmount.slice(0, -1)
  } else if (key === 'dot') {
    return
  } else {
    if (sendAmount.length >= MAX_DIGITS) return
    if (sendAmount === '0' && key === '0') return
    if (sendAmount === '' && key === '0') {
      sendAmount = '0'
    } else if (sendAmount === '0') {
      sendAmount = key
    } else {
      sendAmount += key
    }
  }
  updateAmountDisplay()
}

function goToReview() {
  if (!sendAmount || sendAmount === '0') return

  const amountNum = Number(sendAmount)
  const fee = 245
  const total = amountNum + fee

  document.getElementById('review-amount').textContent = formatBtc(amountNum)
  document.getElementById('review-fee').textContent = formatBtc(fee)
  document.getElementById('review-total').textContent = formatBtc(total)
  document.getElementById('success-amount').textContent = formatBtc(amountNum)

  navigate('send-review')
}

function confirmSend() {
  navigate('send-success')
}

function resetSend() {
  sendAmount = ''
  updateAmountDisplay()
  navigate('home')
}

// --- Balance Toggle ---
let balanceVisible = localStorage.getItem('balance-visible') !== 'false'

function toggleBalance() {
  balanceVisible = !balanceVisible
  localStorage.setItem('balance-visible', balanceVisible)
  updateBalanceDisplay()
}

function updateBalanceDisplay() {
  const shown = document.getElementById('balance-shown')
  const hidden = document.getElementById('balance-hidden')
  const toggleLabel = document.getElementById('balance-toggle-label')
  const toggleIcon = document.getElementById('balance-toggle-icon')

  if (!shown || !hidden) return

  shown.style.display = balanceVisible ? '' : 'none'
  hidden.style.display = balanceVisible ? 'none' : ''
  if (toggleLabel) toggleLabel.textContent = balanceVisible ? 'Hide balance' : 'Show balance'
  if (toggleIcon) toggleIcon.innerHTML = balanceVisible ? eyeOffSvg : eyeSvg
}

// --- Copy Address ---
function copyAddress() {
  const addr = document.getElementById('receive-address-text')
  const btn = document.getElementById('copy-btn')
  if (!addr || !btn) return

  navigator.clipboard.writeText(addr.dataset.full).then(() => {
    const original = btn.textContent
    btn.textContent = 'Copied!'
    setTimeout(() => {
      btn.textContent = original
    }, 1500)
  })
}

// --- SVG Icons ---
const eyeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`

const eyeOffSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  if (!window.location.hash) {
    window.location.hash = 'home'
  }
  updateScreen()
  updateBalanceDisplay()
  updateAmountDisplay()

  document.querySelectorAll('.numpad__key').forEach((key) => {
    key.addEventListener('click', () => {
      const val = key.dataset.key
      if (val) onNumpadKey(val)
    })
  })
})
