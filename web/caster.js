import {
  LK,
  qs,
  makeRoom,
  decode,
  setStatus,
  setSpeakerPermission,
  syncAudioButton,
} from '/common.js'

const { room: roomName } = qs()
const storedSession = sessionStorage.getItem('onesimusCasterSession')
let casterSession = null
try {
  casterSession = storedSession ? JSON.parse(storedSession) : null
} catch {
  sessionStorage.removeItem('onesimusCasterSession')
}
const moderatorToken = casterSession?.moderatorToken || ''
sessionStorage.removeItem('onesimusHostCode')
document.getElementById('roompill').textContent = roomName

const hands = new Map()
let room

function renderRoster() {
  if (!room) return

  const list = document.getElementById('people')
  const people = [...room.remoteParticipants.values()]
  document.getElementById('count').textContent = String(people.length)
  list.innerHTML = ''

  for (const participant of people) {
    const item = document.createElement('li')
    const hand = hands.get(participant.identity)
    const raised = Boolean(hand?.up)
    const allowed = Boolean(participant.permissions?.canPublish)

    if (raised) item.classList.add('hand')
    if (participant.isSpeaking) item.classList.add('speaking')

    const details = document.createElement('span')
    details.className = 'person-details'

    const personName = document.createElement('strong')
    personName.textContent = participant.name || participant.identity

    const state = document.createElement('small')
    state.textContent = raised
      ? 'Hand raised'
      : allowed
        ? 'Mic allowed'
        : 'Listening'

    details.append(personName, state)

    const button = document.createElement('button')
    button.className = allowed ? 'mute-person' : 'allow-person'
    button.textContent = allowed ? 'Mute' : 'Allow mic'
    button.onclick = async () => {
      button.disabled = true
      try {
        await setSpeakerPermission(
          roomName,
          participant.identity,
          !allowed,
          moderatorToken,
        )
        if (!allowed) hands.set(participant.identity, { ...hand, up: false })
      } catch (error) {
        setStatus(error.message)
      } finally {
        button.disabled = false
        renderRoster()
      }
    }

    item.append(details, button)
    list.appendChild(item)
  }
}

async function start() {
  const L = LK()
  if (
    !casterSession
    || casterSession.role !== 'caster'
    || casterSession.room !== roomName
    || !casterSession.token
    || !casterSession.livekitUrl
    || !moderatorToken
  ) {
    throw new Error('Host session missing. Return home and enter the host access code.')
  }
  const { token, livekitUrl } = casterSession
  room = makeRoom('caster')

  room
    .on(L.RoomEvent.ParticipantConnected, renderRoster)
    .on(L.RoomEvent.ParticipantDisconnected, (participant) => {
      hands.delete(participant.identity)
      renderRoster()
    })
    .on(L.RoomEvent.ActiveSpeakersChanged, renderRoster)
    .on(L.RoomEvent.ParticipantPermissionsChanged, renderRoster)
    .on(L.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'audio') {
        const element = track.attach()
        element.autoplay = true
        document.getElementById('audio-sink').appendChild(element)
      }
    })
    .on(L.RoomEvent.DataReceived, (payload, participant) => {
      const message = decode(payload)
      if (message?.type === 'hand') {
        hands.set(participant.identity, {
          name: participant.name,
          up: Boolean(message.up),
        })
        renderRoster()
      }
    })
    .on(L.RoomEvent.AudioPlaybackStatusChanged, () => {
      syncAudioButton(room, document.getElementById('audio'))
    })
    .on(L.RoomEvent.Reconnecting, () => setStatus('reconnecting...'))
    .on(L.RoomEvent.Reconnected, () => setStatus('live'))
    .on(L.RoomEvent.Disconnected, () => setStatus('disconnected'))

  await room.connect(livekitUrl, token)
  setStatus('live')

  await room.localParticipant.enableCameraAndMicrophone()
  const cameraPublication = room.localParticipant.getTrackPublication(
    L.Track.Source.Camera,
  )
  if (cameraPublication?.track) {
    cameraPublication.track.attach(document.getElementById('local'))
  }

  syncAudioButton(room, document.getElementById('audio'))
  renderRoster()
}

document.getElementById('mic').onclick = async () => {
  const enabled = room.localParticipant.isMicrophoneEnabled
  await room.localParticipant.setMicrophoneEnabled(!enabled)
  document.getElementById('mic').textContent = enabled ? 'Unmute mic' : 'Mute mic'
}

document.getElementById('cam').onclick = async () => {
  const enabled = room.localParticipant.isCameraEnabled
  await room.localParticipant.setCameraEnabled(!enabled)
  document.getElementById('cam').textContent = enabled ? 'Start video' : 'Stop video'
}

document.getElementById('audio').onclick = async () => {
  await room.startAudio()
  syncAudioButton(room, document.getElementById('audio'))
}

document.getElementById('share').onclick = async () => {
  const url = new URL('/participant.html', location.origin)
  url.searchParams.set('room', roomName)
  const button = document.getElementById('share')
  await navigator.clipboard.writeText(url.toString())
  button.textContent = 'Viewer link copied'
  setTimeout(() => { button.textContent = 'Copy viewer link' }, 1800)
}

document.getElementById('leave').onclick = async () => {
  await room?.disconnect()
  sessionStorage.removeItem('onesimusCasterSession')
  location.href = '/'
}

start().catch((error) => {
  console.error(error)
  setStatus(`error: ${error.message}`)
})
