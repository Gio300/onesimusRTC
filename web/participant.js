import {
  LK,
  qs,
  getToken,
  makeRoom,
  encode,
  decode,
  setStatus,
  syncAudioButton,
} from '/common.js'

const { room: roomName, name } = qs()
document.getElementById('roompill').textContent = roomName

let room
let handUp = false
let hasVideo = false
let micInvitePending = false
let captionsVisible = true
let captionRecognition
let captionRecognitionActive = false
let captionRestartTimer
let captionHideTimer

const captionOverlay = document.getElementById('caption-overlay')

function appendChat(author, text, options = {}) {
  const log = document.getElementById('chat-log')
  log.querySelector('.chat-empty')?.remove()
  const message = document.createElement('div')
  message.className = 'chat-message'
  message.classList.toggle('own', Boolean(options.own))
  const who = document.createElement('strong')
  who.textContent = author
  const body = document.createElement('span')
  body.textContent = String(text || '').slice(0, 500)
  message.append(who, body)
  log.appendChild(message)
  log.scrollTop = log.scrollHeight
}

function showCaption(text, speaker = '') {
  if (!captionsVisible) return
  const clean = String(text || '').trim().slice(0, 220)
  if (!clean) return
  captionOverlay.textContent = speaker ? `${speaker}: ${clean}` : clean
  captionOverlay.hidden = false
  clearTimeout(captionHideTimer)
  captionHideTimer = setTimeout(() => {
    captionOverlay.hidden = true
  }, 6200)
}

function syncMicInvite() {
  const allowed = Boolean(room?.localParticipant.permissions?.canPublish)
  document.getElementById('mic-invite').hidden = !(micInvitePending && allowed)
}

async function publishViewerCaption(text, final) {
  await room?.localParticipant.publishData(
    encode({
      type: 'caption',
      text: String(text || '').slice(0, 220),
      final: Boolean(final),
      speaker: name || 'Viewer',
    }),
    { reliable: Boolean(final) },
  ).catch(() => {})
}

function createCaptionRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Recognition) return null
  const recognition = new Recognition()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = navigator.language || 'en-US'
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]
      const text = result[0]?.transcript?.trim()
      if (!text) continue
      showCaption(text, name || 'You')
      publishViewerCaption(text, result.isFinal)
    }
  }
  recognition.onerror = (event) => {
    if (!['aborted', 'no-speech'].includes(event.error)) {
      captionRecognitionActive = false
    }
  }
  recognition.onend = () => {
    if (
      !captionsVisible
      || !room?.localParticipant.isMicrophoneEnabled
    ) {
      captionRecognitionActive = false
      return
    }
    clearTimeout(captionRestartTimer)
    captionRestartTimer = setTimeout(() => {
      captionRecognition = createCaptionRecognition()
      if (!captionRecognition) return
      try {
        captionRecognition.start()
        captionRecognitionActive = true
      } catch {
        captionRecognitionActive = false
      }
    }, 350)
  }
  return recognition
}

function syncLocalCaptionRecognition() {
  const shouldRun =
    captionsVisible
    && Boolean(room?.localParticipant.isMicrophoneEnabled)
  if (!shouldRun) {
    clearTimeout(captionRestartTimer)
    if (captionRecognitionActive) captionRecognition?.stop()
    captionRecognitionActive = false
    captionRecognition = null
    return
  }
  if (captionRecognitionActive) return
  captionRecognition = createCaptionRecognition()
  if (!captionRecognition) return
  try {
    captionRecognition.start()
    captionRecognitionActive = true
  } catch {
    captionRecognitionActive = false
  }
}

function pruneDetachedAudio() {
  for (const element of document.querySelectorAll('#audio-sink audio')) {
    const tracks = element.srcObject?.getTracks?.() || []
    if (!tracks.some((track) => track.readyState === 'live')) element.remove()
  }
}

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
    ? room.localParticipant.isMicrophoneEnabled
      ? 'Your microphone is live. Tap again to mute it. Your camera remains blocked.'
      : 'The host approved your microphone. Tap Enable microphone so your browser can ask for access.'
    : handUp
      ? 'Your hand is raised. The host will invite you when it is your turn.'
      : 'You are listening with your camera blocked. Raise your hand when you want the host to enable your microphone.'
  syncMicInvite()
  syncLocalCaptionRecognition()
}

async function loadImageSource(file) {
  if (window.createImageBitmap) return createImageBitmap(file)
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

function canvasBlob(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality)
  })
}

async function prepareSharedImage(file) {
  if (!file?.type?.startsWith('image/')) {
    throw new Error('Choose a picture file.')
  }
  const source = await loadImageSource(file)
  const sourceWidth = source.width || source.naturalWidth
  const sourceHeight = source.height || source.naturalHeight
  const scale = Math.min(1, 1024 / Math.max(sourceWidth, sourceHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const context = canvas.getContext('2d', { alpha: false })
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  source.close?.()

  let blob = await canvasBlob(canvas, 0.76)
  if (blob?.size > 430000) blob = await canvasBlob(canvas, 0.52)
  if (!blob || blob.size > 450000) {
    throw new Error('That picture is too large. Choose a smaller one or take a screenshot.')
  }
  return blob
}

function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function sendSharedImage(file) {
  if (!room) throw new Error('The room is not connected yet.')
  const status = document.getElementById('upload-status')
  status.textContent = 'Preparing picture...'
  const blob = await prepareSharedImage(file)
  const base64 = await blobBase64(blob)
  const chunkSize = 9000
  const chunks = []
  for (let offset = 0; offset < base64.length; offset += chunkSize) {
    chunks.push(base64.slice(offset, offset + chunkSize))
  }
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const safeName = String(file.name || 'Shared picture').slice(0, 90)
  await room.localParticipant.publishData(
    encode({
      type: 'media-start',
      id,
      total: chunks.length,
      size: blob.size,
      mime: blob.type,
      name: safeName,
    }),
    { reliable: true },
  )
  for (let index = 0; index < chunks.length; index += 1) {
    status.textContent = `Sending picture ${index + 1} of ${chunks.length}...`
    await room.localParticipant.publishData(
      encode({
        type: 'media-chunk',
        id,
        index,
        data: chunks[index],
      }),
      { reliable: true },
    )
  }
  await room.localParticipant.publishData(
    encode({ type: 'media-end', id }),
    { reliable: true },
  )
  status.textContent = 'Picture sent. The host can add it to the screen.'
  appendChat(
    name || 'You',
    `${safeName} was shared with the host.`,
    { own: true },
  )
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
      for (const element of track.detach()) element.remove()
      setTimeout(pruneDetachedAudio, 0)
      if (track.kind === 'video') {
        hasVideo = false
        syncVideoStatus()
      }
    })
    .on(L.RoomEvent.TrackUnpublished, () => {
      setTimeout(pruneDetachedAudio, 100)
    })
    .on(L.RoomEvent.DataReceived, (payload, participant) => {
      const message = decode(payload)
      if (typeof message?.type !== 'string') return
      if (message?.type === 'presentation') {
        const label = document.getElementById('presentation-title')
        const presenting = message.mode === 'presentation'
        label.hidden = !presenting
        label.textContent = presenting
          ? String(message.title || 'Study material').slice(0, 80)
          : ''
        if (!presenting) setTimeout(pruneDetachedAudio, 250)
        return
      }
      if (message?.type === 'mic-invite') {
        micInvitePending = Boolean(message.allowed)
        if (!micInvitePending && room.localParticipant.isMicrophoneEnabled) {
          room.localParticipant.setMicrophoneEnabled(false).catch(() => {})
        }
        syncMicInvite()
        syncSpeakPermission()
        return
      }
      if (message?.type === 'caption') {
        showCaption(
          message.text,
          String(message.speaker || participant?.name || 'Speaker').slice(0, 64),
        )
        return
      }
      if (message?.type === 'chat') {
        appendChat(participant?.name || participant?.identity || 'Host', message.text)
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
  document.getElementById('captions').classList.toggle('talk', captionsVisible)
}

async function toggleMicrophone(forceEnable = false) {
  const button = document.getElementById('talk')
  const enabled = room.localParticipant.isMicrophoneEnabled
  try {
    await room.localParticipant.setMicrophoneEnabled(forceEnable ? true : !enabled)
    if (room.localParticipant.isMicrophoneEnabled) {
      micInvitePending = false
      handUp = false
      document.getElementById('hand').textContent = 'Raise hand'
      document.getElementById('hand').classList.remove('talk')
      await room.localParticipant.publishData(
        encode({ type: 'hand', up: false, name }),
        { reliable: true },
      ).catch(() => {})
    }
    await syncSpeakPermission()
  } catch (error) {
    const denied = error?.name === 'NotAllowedError'
    setStatus(denied ? 'microphone permission was blocked' : error.message)
    document.getElementById('voice-help').textContent = denied
      ? 'Microphone access was blocked. Open this site in Chrome settings, allow Microphone, then tap Enable microphone again.'
      : `The microphone could not start: ${error.message}`
    button.disabled = false
  }
}

document.getElementById('talk').onclick = () => toggleMicrophone()

document.getElementById('accept-mic').onclick = () => toggleMicrophone(true)

document.getElementById('hand').onclick = async () => {
  handUp = !handUp
  await room.localParticipant.publishData(
    encode({ type: 'hand', up: handUp, name }),
    { reliable: true },
  )
  const button = document.getElementById('hand')
  button.textContent = handUp ? 'Lower hand' : 'Raise hand'
  button.classList.toggle('talk', handUp)
  await syncSpeakPermission()
}

document.getElementById('audio').onclick = async () => {
  await room.startAudio()
  syncAudioButton(room, document.getElementById('audio'))
}

document.getElementById('captions').onclick = () => {
  captionsVisible = !captionsVisible
  const button = document.getElementById('captions')
  button.textContent = captionsVisible ? 'Captions on' : 'Captions off'
  button.classList.toggle('talk', captionsVisible)
  if (!captionsVisible) captionOverlay.hidden = true
  syncLocalCaptionRecognition()
}

document.getElementById('chat-form').onsubmit = async (event) => {
  event.preventDefault()
  const input = document.getElementById('chat-message')
  const text = input.value.trim()
  if (!text || !room) return
  input.value = ''
  appendChat(name || 'You', text, { own: true })
  await room.localParticipant.publishData(
    encode({ type: 'chat', text }),
    { reliable: true },
  ).catch((error) => setStatus(error.message))
}

document.getElementById('chat-image').onchange = (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  sendSharedImage(file).catch((error) => {
    document.getElementById('upload-status').textContent = error.message
  })
}

document.getElementById('leave').onclick = async () => {
  captionsVisible = false
  clearTimeout(captionRestartTimer)
  captionRecognition?.abort()
  await room?.disconnect()
  location.href = '/'
}

start().catch((error) => {
  console.error(error)
  setStatus(`error: ${error.message}`)
})
