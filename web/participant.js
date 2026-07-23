import { LK, qs, getToken, makeRoom, encode, setStatus } from '/common.js'

const { room: roomName, name } = qs()
document.getElementById('roompill').textContent = roomName

let room
let handUp = false

async function start() {
  const L = LK()
  const { token, livekitUrl } = await getToken('participant', roomName, name)
  room = makeRoom()

  room
    .on(L.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'video') {
        track.attach(document.getElementById('remote'))
        setStatus('live')
      } else if (track.kind === 'audio') {
        const el = track.attach()          // <audio> element
        el.autoplay = true
        document.getElementById('audio-sink').appendChild(el)
      }
    })
    .on(L.RoomEvent.Disconnected, () => setStatus('disconnected'))

  await room.connect(livekitUrl, token)
  setStatus('connected — waiting for caster video')
  // mic starts OFF (voice-back is opt-in / push to talk)
  await room.localParticipant.setMicrophoneEnabled(false)
}

// Talk = toggle mic. Green = you are heard.
document.getElementById('talk').onclick = async () => {
  const btn = document.getElementById('talk')
  const on = room.localParticipant.isMicrophoneEnabled
  await room.localParticipant.setMicrophoneEnabled(!on)
  btn.classList.toggle('live', !on)
  btn.textContent = on ? 'Tap to talk' : 'Live — tap to mute'
}

// Raise hand = a reliable data message the caster sees in the roster.
document.getElementById('hand').onclick = async () => {
  handUp = !handUp
  await room.localParticipant.publishData(
    encode({ type: 'hand', up: handUp, name }),
    { reliable: true },
  )
  const btn = document.getElementById('hand')
  btn.textContent = handUp ? 'Lower hand' : 'Raise hand ✋'
  btn.classList.toggle('talk', handUp)
}

document.getElementById('leave').onclick = async () => {
  await room?.disconnect(); location.href = '/'
}

start().catch((e) => { console.error(e); setStatus('error: ' + e.message) })
