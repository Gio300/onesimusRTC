import {
  LK,
  qs,
  getToken,
  makeRoom,
  encode,
  setStatus,
  syncAudioButton,
} from '/common.js'

const { room: roomName, name } = qs()
document.getElementById('roompill').textContent = roomName

let room
let handUp = false
let hasVideo = false

function syncVideoStatus() {
  setStatus(hasVideo ? 'live' : 'connected - waiting for caster video')
}

async function syncSpeakPermission() {
  const allowed = Boolean(room?.localParticipant.permissions?.canPublish)
  const button = document.getElementById('talk')
  const help = document.getElementById('voice-help')

  if (!allowed && room?.localParticipant.isMicrophoneEnabled) {
    await room.localParticipant.setMicrophoneEnabled(false).catch(() => {})
  }

  button.disabled = !allowed
  button.classList.toggle(
    'live',
    allowed && room?.localParticipant.isMicrophoneEnabled,
  )
  button.textContent = !allowed
    ? 'Waiting for host'
    : room.localParticipant.isMicrophoneEnabled
      ? 'Live - tap to mute'
      : 'Tap to talk'
  help.textContent = allowed
    ? 'Your microphone is approved. Your camera remains blocked.'
    : 'You are listening with your camera blocked. Raise your hand when you want the host to enable your microphone.'
}

async function start() {
  const L = LK()
  const { token, livekitUrl } = await getToken(
    'participant',
    roomName,
    name,
  )
  room = makeRoom('participant')

  room
    .on(L.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'video') {
        hasVideo = true
        track.attach(document.getElementById('remote'))
        syncVideoStatus()
      } else if (track.kind === 'audio') {
        const element = track.attach()
        element.autoplay = true
        document.getElementById('audio-sink').appendChild(element)
      }
    })
    .on(L.RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === 'video') {
        hasVideo = false
        syncVideoStatus()
      }
    })
    .on(L.RoomEvent.ParticipantPermissionsChanged, (_previous, participant) => {
      if (participant === room.localParticipant) syncSpeakPermission()
    })
    .on(L.RoomEvent.AudioPlaybackStatusChanged, () => {
      syncAudioButton(room, document.getElementById('audio'))
    })
    .on(L.RoomEvent.Reconnecting, () => setStatus('reconnecting...'))
    .on(L.RoomEvent.Reconnected, () => setStatus('connected'))
    .on(L.RoomEvent.Disconnected, () => setStatus('disconnected'))

  await room.connect(livekitUrl, token)
  syncVideoStatus()
  syncAudioButton(room, document.getElementById('audio'))
  await syncSpeakPermission()
}

document.getElementById('talk').onclick = async () => {
  const button = document.getElementById('talk')
  const enabled = room.localParticipant.isMicrophoneEnabled
  try {
    await room.localParticipant.setMicrophoneEnabled(!enabled)
    await syncSpeakPermission()
  } catch (error) {
    setStatus(error.message)
    button.disabled = true
  }
}

document.getElementById('hand').onclick = async () => {
  handUp = !handUp
  await room.localParticipant.publishData(
    encode({ type: 'hand', up: handUp, name }),
    { reliable: true },
  )
  const button = document.getElementById('hand')
  button.textContent = handUp ? 'Lower hand' : 'Raise hand'
  button.classList.toggle('talk', handUp)
}

document.getElementById('audio').onclick = async () => {
  await room.startAudio()
  syncAudioButton(room, document.getElementById('audio'))
}

document.getElementById('leave').onclick = async () => {
  await room?.disconnect()
  location.href = '/'
}

start().catch((error) => {
  console.error(error)
  setStatus(`error: ${error.message}`)
})
