import { LK, qs, getToken, makeRoom, decode, setStatus } from '/common.js'

const { room: roomName, name } = qs()
document.getElementById('roompill').textContent = roomName

const hands = new Map()      // identity -> { name, up }
let room

function renderRoster() {
  const ul = document.getElementById('people')
  const people = [...room.remoteParticipants.values()]
  document.getElementById('count').textContent = String(people.length)
  ul.innerHTML = ''
  for (const p of people) {
    const li = document.createElement('li')
    const h = hands.get(p.identity)
    const raised = h?.up
    li.textContent = (p.name || p.identity) + (raised ? '  ✋' : '')
    if (raised) li.className = 'hand'
    else if (p.isSpeaking) li.className = 'speaking'
    ul.appendChild(li)
  }
}

async function start() {
  const L = LK()
  const { token, livekitUrl } = await getToken('caster', roomName, name)
  room = makeRoom()

  room
    .on(L.RoomEvent.ParticipantConnected, renderRoster)
    .on(L.RoomEvent.ParticipantDisconnected, (p) => { hands.delete(p.identity); renderRoster() })
    .on(L.RoomEvent.ActiveSpeakersChanged, renderRoster)
    .on(L.RoomEvent.DataReceived, (payload, participant) => {
      const msg = decode(payload)
      if (msg?.type === 'hand') {
        hands.set(participant.identity, { name: participant?.name, up: !!msg.up })
        renderRoster()
      }
    })
    .on(L.RoomEvent.Disconnected, () => setStatus('disconnected'))

  await room.connect(livekitUrl, token)
  setStatus('live')

  // Low-bandwidth publish: 360p simulcast so weak viewers auto-drop to the small
  // layer; modest bitrate keeps the caster uplink light too.
  await room.localParticipant.enableCameraAndMicrophone()
  const camPub = room.localParticipant.getTrackPublication(L.Track.Source.Camera)
  const el = document.getElementById('local')
  if (camPub?.track) camPub.track.attach(el)

  renderRoster()
}

document.getElementById('mic').onclick = async () => {
  const on = room.localParticipant.isMicrophoneEnabled
  await room.localParticipant.setMicrophoneEnabled(!on)
  document.getElementById('mic').textContent = on ? 'Unmute mic' : 'Mute mic'
}
document.getElementById('cam').onclick = async () => {
  const on = room.localParticipant.isCameraEnabled
  await room.localParticipant.setCameraEnabled(!on)
  document.getElementById('cam').textContent = on ? 'Start video' : 'Stop video'
}
document.getElementById('leave').onclick = async () => {
  await room?.disconnect(); location.href = '/'
}

start().catch((e) => { console.error(e); setStatus('error: ' + e.message) })
