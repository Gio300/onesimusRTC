import { getToken } from '/common.js'

let hostCodeRequired = false
const hostCodeWrap = document.getElementById('host-code-wrap')
const hostCodeInput = document.getElementById('host-code')
const joinError = document.getElementById('join-error')
const casterButton = document.getElementById('join-caster')

async function loadConfig() {
  try {
    const response = await fetch('/config')
    if (!response.ok) throw new Error('config_failed')
    const config = await response.json()
    hostCodeRequired = Boolean(config.hostCodeRequired)
    hostCodeWrap.hidden = !hostCodeRequired
  } catch {
    joinError.textContent = 'The meeting service is not reachable yet.'
  }
}

async function go(role) {
  const rawRoom = document.getElementById('room').value.trim() || 'main'
  const rawName = document.getElementById('name').value.trim()
  joinError.textContent = ''

  if (role === 'participant') {
    sessionStorage.removeItem('onesimusCasterSession')
    location.href = `/participant.html?room=${encodeURIComponent(rawRoom)}&name=${encodeURIComponent(rawName)}`
    return
  }

  const hostCode = hostCodeInput.value.trim()
  if (hostCodeRequired && !hostCode) {
    joinError.textContent = 'Enter the host access code to start the camera.'
    hostCodeInput.focus()
    return
  }

  casterButton.disabled = true
  casterButton.textContent = 'Starting...'
  try {
    const connection = await getToken(
      'caster',
      rawRoom,
      rawName,
      { hostCode },
    )
    sessionStorage.removeItem('onesimusHostCode')
    sessionStorage.setItem(
      'onesimusCasterSession',
      JSON.stringify(connection),
    )
    hostCodeInput.value = ''
    location.href = `/caster.html?room=${encodeURIComponent(connection.room)}&name=${encodeURIComponent(connection.name)}`
  } catch (error) {
    joinError.textContent = error.message
    casterButton.disabled = false
    casterButton.textContent = 'Start as caster (video)'
  }
}

document.getElementById('join-participant').onclick = () => go('participant')
casterButton.onclick = () => go('caster')
loadConfig()
