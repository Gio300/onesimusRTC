import {
  LK,
  qs,
  makeRoom,
  decode,
  setStatus,
  setSpeakerPermission,
  encode,
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
let publishedVideoTrack
let cameraSourceTrack
let outgoingVideoTrack
let presentationStream
let screenShareTrack
let mediaAudioPublication
let mediaAudioTrack
let mediaAudioContext
let mediaAudioSource
let mediaAudioDestination
let renderFrame
let lastRenderAt = 0
let mode = 'camera'
let speakerVisible = true
let videoMuted = false
let activeIndex = -1
let nextQueueId = 1
const queue = []

const localVideo = document.getElementById('local')
const sourceCamera = document.getElementById('source-camera')
const sourceMedia = document.getElementById('source-media')
const sourceImage = document.getElementById('source-image')
const presentationCanvas = document.getElementById('presentation-canvas')
const presentationContext = presentationCanvas.getContext('2d', { alpha: false })
const modeBadge = document.getElementById('presentation-mode')
const presenterHelp = document.getElementById('presenter-help')
const weeklyStudyUrl = 'https://www.jw.org/en/library/jw-meeting-workbook/'

function pruneDetachedAudio() {
  for (const element of document.querySelectorAll('#audio-sink audio')) {
    const tracks = element.srcObject?.getTracks?.() || []
    if (!tracks.some((track) => track.readyState === 'live')) element.remove()
  }
}

function activeItem() {
  return queue[activeIndex] || null
}

function itemKindLabel(kind) {
  return {
    image: 'Picture',
    video: 'Video',
    link: 'JW link',
  }[kind] || 'Media'
}

function cleanItemName(name) {
  return String(name || 'Study material')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, 90) || 'Study material'
}

function officialJwUrl(value) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:'
      || !(
        host === 'jw.org'
        || host.endsWith('.jw.org')
      )
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function updateControlState() {
  const hasItems = queue.length > 0
  const presenting = mode === 'presentation'
  document.getElementById('present-slide').disabled = !hasItems
  document.getElementById('previous-slide').disabled = !hasItems || activeIndex <= 0
  document.getElementById('next-slide').disabled = !hasItems || activeIndex >= queue.length - 1
  document.getElementById('return-camera').disabled = mode === 'camera'
  document.getElementById('speaker-pip').disabled = !presenting
  document.getElementById('speaker-pip').textContent = speakerVisible
    ? 'Hide speaker'
    : 'Show speaker'
  document.getElementById('clear-queue').hidden = !hasItems
  document.getElementById('queue-count').textContent = String(queue.length)
  modeBadge.textContent = mode === 'camera'
    ? 'Camera live'
    : mode === 'screen'
      ? 'Screen live'
      : 'Presenting'
  modeBadge.classList.toggle('live', mode !== 'camera')
  document.getElementById('cam').textContent = presenting
    ? speakerVisible ? 'Hide speaker' : 'Show speaker'
    : videoMuted ? 'Start video' : 'Stop video'
}

function renderQueue() {
  const list = document.getElementById('presentation-queue')
  list.innerHTML = ''

  if (!queue.length) {
    const empty = document.createElement('li')
    empty.className = 'queue-empty'
    empty.textContent = 'Add this week\u2019s pictures or videos, then tap Present.'
    list.appendChild(empty)
    activeIndex = -1
    updateControlState()
    return
  }

  queue.forEach((item, index) => {
    const row = document.createElement('li')
    row.classList.toggle('active', index === activeIndex)

    const thumb = document.createElement('span')
    thumb.className = 'queue-thumb'
    if (item.kind === 'image') {
      const image = document.createElement('img')
      image.src = item.url
      image.alt = ''
      thumb.appendChild(image)
    } else {
      thumb.textContent = item.kind === 'video' ? 'Video' : 'JW'
    }

    const copy = document.createElement('span')
    copy.className = 'queue-copy'
    const title = document.createElement('strong')
    title.textContent = item.title
    const kind = document.createElement('small')
    kind.textContent = itemKindLabel(item.kind)
    copy.append(title, kind)

    const select = document.createElement('button')
    select.className = 'queue-select'
    select.type = 'button'
    select.title = `Select ${item.title}`
    select.setAttribute('aria-label', `Select ${item.title}`)
    select.textContent = index === activeIndex ? '\u2713' : '\u25b6'
    select.onclick = async () => {
      activeIndex = index
      renderQueue()
      if (mode === 'presentation') await presentActiveItem()
    }

    const remove = document.createElement('button')
    remove.className = 'queue-remove'
    remove.type = 'button'
    remove.title = `Remove ${item.title}`
    remove.setAttribute('aria-label', `Remove ${item.title}`)
    remove.textContent = '\u00d7'
    remove.onclick = async () => {
      const wasActive = index === activeIndex
      if (item.objectUrl) URL.revokeObjectURL(item.url)
      queue.splice(index, 1)
      if (!queue.length) {
        activeIndex = -1
        if (mode === 'presentation') await returnToCamera()
      } else if (index < activeIndex || activeIndex >= queue.length) {
        activeIndex = Math.max(0, activeIndex - 1)
      }
      renderQueue()
      if (wasActive && mode === 'presentation' && queue.length) {
        await presentActiveItem()
      }
    }

    row.append(thumb, copy, select, remove)
    list.appendChild(row)
  })

  updateControlState()
}

function addFiles(files) {
  for (const file of files) {
    const kind = file.type.startsWith('image/')
      ? 'image'
      : file.type.startsWith('video/')
        ? 'video'
        : null
    if (!kind) continue
    queue.push({
      id: nextQueueId++,
      kind,
      title: cleanItemName(file.name),
      url: URL.createObjectURL(file),
      objectUrl: true,
    })
  }
  if (activeIndex < 0 && queue.length) activeIndex = 0
  renderQueue()
}

function addLink(url) {
  let title = 'JW study material'
  try {
    const parsed = new URL(url)
    const lastPart = parsed.pathname.split('/').filter(Boolean).pop()
    if (lastPart) title = cleanItemName(decodeURIComponent(lastPart))
  } catch {}
  queue.push({
    id: nextQueueId++,
    kind: 'link',
    title,
    url,
    objectUrl: false,
  })
  if (activeIndex < 0) activeIndex = 0
  renderQueue()
}

function containRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  if (!sourceWidth || !sourceHeight) {
    return { x: 0, y: 0, width: targetWidth, height: targetHeight }
  }
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  }
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath()
  if (typeof context.roundRect === 'function') {
    context.roundRect(x, y, width, height, radius)
    return
  }
  const corner = Math.min(radius, width / 2, height / 2)
  context.moveTo(x + corner, y)
  context.lineTo(x + width - corner, y)
  context.quadraticCurveTo(x + width, y, x + width, y + corner)
  context.lineTo(x + width, y + height - corner)
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - corner,
    y + height,
  )
  context.lineTo(x + corner, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - corner)
  context.lineTo(x, y + corner)
  context.quadraticCurveTo(x, y, x + corner, y)
  context.closePath()
}

function drawContain(element, sourceWidth, sourceHeight) {
  const rect = containRect(
    sourceWidth,
    sourceHeight,
    presentationCanvas.width,
    presentationCanvas.height,
  )
  presentationContext.drawImage(element, rect.x, rect.y, rect.width, rect.height)
}

function wrapCanvasText(text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text).split(/\s+/)
  const lines = []
  let line = ''
  for (const word of words) {
    const test = line ? `${line} ${word}` : word
    if (presentationContext.measureText(test).width > maxWidth && line) {
      lines.push(line)
      line = word
      if (lines.length >= maxLines) break
    } else {
      line = test
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  lines.forEach((value, index) => {
    presentationContext.fillText(value, x, y + index * lineHeight)
  })
}

function drawLinkCard(item) {
  const width = presentationCanvas.width
  const height = presentationCanvas.height
  presentationContext.fillStyle = '#101725'
  presentationContext.fillRect(0, 0, width, height)

  presentationContext.fillStyle = '#23c98a'
  presentationContext.fillRect(58, 64, 8, 302)
  presentationContext.fillStyle = '#8fa7c8'
  presentationContext.font = '700 18px system-ui, sans-serif'
  presentationContext.fillText('OFFICIAL JW.ORG MATERIAL', 94, 102)
  presentationContext.fillStyle = '#f4f7fb'
  presentationContext.font = '700 44px system-ui, sans-serif'
  wrapCanvasText(item.title, 94, 174, 700, 54, 3)
  presentationContext.fillStyle = '#a9b8ce'
  presentationContext.font = '20px system-ui, sans-serif'
  wrapCanvasText(item.url, 94, 348, 700, 28, 3)
}

function drawSpeakerPip() {
  if (!speakerVisible || sourceCamera.readyState < 2 || !cameraSourceTrack?.enabled) {
    return
  }
  const width = 250
  const height = 142
  const x = presentationCanvas.width - width - 24
  const y = presentationCanvas.height - height - 52

  presentationContext.save()
  roundedRect(presentationContext, x, y, width, height, 14)
  presentationContext.clip()

  const sourceWidth = sourceCamera.videoWidth || 640
  const sourceHeight = sourceCamera.videoHeight || 360
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  presentationContext.drawImage(
    sourceCamera,
    x + (width - drawWidth) / 2,
    y + (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  )
  presentationContext.restore()

  presentationContext.strokeStyle = '#ffffff'
  presentationContext.lineWidth = 3
  roundedRect(presentationContext, x, y, width, height, 14)
  presentationContext.stroke()
}

function drawPresentationFrame(now = performance.now()) {
  if (mode !== 'presentation') {
    renderFrame = null
    return
  }
  renderFrame = requestAnimationFrame(drawPresentationFrame)
  if (now - lastRenderAt < 80) return
  lastRenderAt = now

  const item = activeItem()
  const width = presentationCanvas.width
  const height = presentationCanvas.height
  presentationContext.fillStyle = '#05070b'
  presentationContext.fillRect(0, 0, width, height)

  if (!item) {
    presentationContext.fillStyle = '#e8edf6'
    presentationContext.font = '700 32px system-ui, sans-serif'
    presentationContext.fillText('Choose an item to present', 52, 92)
  } else if (item.kind === 'image' && sourceImage.complete) {
    drawContain(sourceImage, sourceImage.naturalWidth, sourceImage.naturalHeight)
  } else if (item.kind === 'video' && sourceMedia.readyState >= 2) {
    drawContain(sourceMedia, sourceMedia.videoWidth, sourceMedia.videoHeight)
  } else if (item.kind === 'link') {
    drawLinkCard(item)
  }

  if (item?.kind !== 'link') {
    const barHeight = 42
    presentationContext.fillStyle = 'rgba(4, 8, 14, .78)'
    presentationContext.fillRect(0, height - barHeight, width, barHeight)
    presentationContext.fillStyle = '#e8edf6'
    presentationContext.font = '600 18px system-ui, sans-serif'
    presentationContext.fillText(item?.title || 'Study material', 20, height - 15)
  }

  drawSpeakerPip()
}

async function stopMediaAudio() {
  if (mediaAudioPublication?.track) {
    await room.localParticipant.unpublishTrack(mediaAudioPublication.track, true)
      .catch(() => {})
  }
  mediaAudioTrack?.stop()
  mediaAudioTrack = null
  mediaAudioPublication = null
  mediaAudioSource?.disconnect()
  mediaAudioDestination?.disconnect()
  mediaAudioDestination = null
}

async function startMediaAudio() {
  await stopMediaAudio()
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass || !sourceMedia.src) return

  try {
    if (!mediaAudioContext) mediaAudioContext = new AudioContextClass()
    await mediaAudioContext.resume()
    if (!mediaAudioSource) {
      mediaAudioSource = mediaAudioContext.createMediaElementSource(sourceMedia)
    }
    mediaAudioDestination = mediaAudioContext.createMediaStreamDestination()
    mediaAudioSource.connect(mediaAudioDestination)
    const track = mediaAudioDestination.stream.getAudioTracks()[0]
    if (!track) return
    const L = LK()
    mediaAudioTrack = new L.LocalAudioTrack(track, undefined, true, mediaAudioContext)
    mediaAudioTrack.source = L.Track.Source.ScreenShareAudio
    mediaAudioPublication = await room.localParticipant.publishTrack(
      mediaAudioTrack,
      { name: 'study-media-audio', source: L.Track.Source.ScreenShareAudio },
    )
  } catch (error) {
    console.warn('Media audio could not be published', error)
    await stopMediaAudio()
  }
}

async function loadActiveSource() {
  const item = activeItem()
  sourceMedia.pause()
  sourceMedia.removeAttribute('src')
  sourceMedia.load()
  sourceImage.removeAttribute('src')
  await stopMediaAudio()

  if (!item) return
  if (item.kind === 'image') {
    sourceImage.src = item.url
    await sourceImage.decode().catch(() => {})
  } else if (item.kind === 'video') {
    sourceMedia.src = item.url
    sourceMedia.muted = false
    await new Promise((resolve) => {
      const done = () => {
        sourceMedia.removeEventListener('loadedmetadata', done)
        resolve()
      }
      sourceMedia.addEventListener('loadedmetadata', done)
      sourceMedia.load()
    })
    await startMediaAudio()
    await sourceMedia.play()
  }
}

async function replaceOutgoingVideo(nextTrack) {
  const previous = outgoingVideoTrack
  await publishedVideoTrack.replaceTrack(nextTrack, { userProvidedTrack: true })
  outgoingVideoTrack = nextTrack
  if (
    previous
    && previous !== nextTrack
    && previous !== cameraSourceTrack
    && previous.readyState !== 'ended'
  ) {
    previous.stop()
  }
}

async function broadcastPresentationState() {
  const item = activeItem()
  await room.localParticipant.publishData(
    encode({
      type: 'presentation',
      mode,
      title: mode === 'presentation' ? item?.title : '',
    }),
    { reliable: true },
  ).catch(() => {})
}

async function presentActiveItem() {
  if (!publishedVideoTrack || !queue.length) return
  if (activeIndex < 0) activeIndex = 0
  await loadActiveSource()

  if (!presentationCanvas.captureStream) {
    throw new Error('This browser cannot cast pictures. Use Share screen instead.')
  }

  const alreadyPresenting = mode === 'presentation'
  mode = 'presentation'
  if (!renderFrame) drawPresentationFrame(performance.now())
  if (
    !alreadyPresenting
    || presentationStream?.getVideoTracks()[0]?.readyState !== 'live'
  ) {
    presentationStream = presentationCanvas.captureStream(12)
    const track = presentationStream.getVideoTracks()[0]
    if (!track) throw new Error('The presentation video could not start.')
    await replaceOutgoingVideo(track)
  }
  videoMuted = false
  await publishedVideoTrack.unmute()
  presenterHelp.textContent = activeItem()?.kind === 'link'
    ? 'The official link is on screen. Open it on this phone, or use Share screen to show the page itself.'
    : 'Presentation is live. Use the arrows to move through the queue without interrupting the room.'
  renderQueue()
  await broadcastPresentationState()
}

async function returnToCamera() {
  if (!publishedVideoTrack || !cameraSourceTrack) return
  sourceMedia.pause()
  await stopMediaAudio()

  const cameraSendTrack = cameraSourceTrack.clone()
  cameraSendTrack.enabled = true
  await replaceOutgoingVideo(cameraSendTrack)
  mode = 'camera'
  if (renderFrame) cancelAnimationFrame(renderFrame)
  renderFrame = null
  presentationStream = null
  screenShareTrack = null
  videoMuted = false
  await publishedVideoTrack.unmute()
  presenterHelp.textContent = 'Camera is live. Your presentation queue stays ready for the next item.'
  renderQueue()
  await broadcastPresentationState()
}

async function shareScreen() {
  const L = LK()
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen sharing is not available in this browser. Add pictures or video instead.')
  }
  const tracks = await L.createLocalScreenTracks({
    audio: false,
    resolution: L.ScreenSharePresets.h720fps15?.resolution,
  })
  const video = tracks.find((track) => track.kind === 'video')
  if (!video) throw new Error('No screen was selected.')
  const mediaTrack = video.mediaStreamTrack
  mediaTrack.addEventListener('ended', () => {
    if (mode === 'screen') returnToCamera().catch((error) => setStatus(error.message))
  }, { once: true })
  sourceMedia.pause()
  await stopMediaAudio()
  screenShareTrack = mediaTrack
  await replaceOutgoingVideo(mediaTrack)
  mode = 'screen'
  if (renderFrame) cancelAnimationFrame(renderFrame)
  renderFrame = null
  presentationStream = null
  videoMuted = false
  presenterHelp.textContent = 'Screen is live. Return here and tap Camera when you are finished.'
  renderQueue()
  await broadcastPresentationState()
}

async function clearQueue() {
  for (const item of queue) {
    if (item.objectUrl) URL.revokeObjectURL(item.url)
  }
  queue.splice(0)
  activeIndex = -1
  if (mode === 'presentation') await returnToCamera()
  renderQueue()
}

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
    .on(L.RoomEvent.TrackUnsubscribed, (track) => {
      for (const element of track.detach()) element.remove()
      setTimeout(pruneDetachedAudio, 0)
    })
    .on(L.RoomEvent.TrackUnpublished, () => {
      setTimeout(pruneDetachedAudio, 100)
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
    publishedVideoTrack = cameraPublication.track
    outgoingVideoTrack = publishedVideoTrack.mediaStreamTrack
    cameraSourceTrack = outgoingVideoTrack.clone()
    sourceCamera.srcObject = new MediaStream([cameraSourceTrack])
    await sourceCamera.play().catch(() => {})
    publishedVideoTrack.attach(localVideo)
  }

  document.getElementById('screen-share').hidden = !navigator.mediaDevices?.getDisplayMedia
  syncAudioButton(room, document.getElementById('audio'))
  renderRoster()
  renderQueue()
}

document.getElementById('mic').onclick = async () => {
  const enabled = room.localParticipant.isMicrophoneEnabled
  await room.localParticipant.setMicrophoneEnabled(!enabled)
  document.getElementById('mic').textContent = enabled ? 'Unmute mic' : 'Mute mic'
}

document.getElementById('cam').onclick = async () => {
  if (mode === 'presentation') {
    speakerVisible = !speakerVisible
    updateControlState()
    return
  }
  videoMuted = !videoMuted
  if (videoMuted) {
    await publishedVideoTrack.mute()
  } else {
    await publishedVideoTrack.unmute()
  }
  updateControlState()
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
  await stopMediaAudio()
  if (mediaAudioContext) await mediaAudioContext.close().catch(() => {})
  if (renderFrame) cancelAnimationFrame(renderFrame)
  for (const item of queue) {
    if (item.objectUrl) URL.revokeObjectURL(item.url)
  }
  cameraSourceTrack?.stop()
  outgoingVideoTrack?.stop()
  await room?.disconnect()
  sessionStorage.removeItem('onesimusCasterSession')
  location.href = '/'
}

document.getElementById('weekly-study').onclick = () => {
  window.open(weeklyStudyUrl, '_blank', 'noopener,noreferrer')
}

document.getElementById('media-files').onchange = (event) => {
  addFiles([...event.target.files])
  event.target.value = ''
}

document.getElementById('show-link-form').onclick = () => {
  const form = document.getElementById('link-form')
  form.hidden = !form.hidden
  if (!form.hidden) document.getElementById('study-link').focus()
}

document.getElementById('link-form').onsubmit = (event) => {
  event.preventDefault()
  const input = document.getElementById('study-link')
  const error = document.getElementById('link-error')
  const url = officialJwUrl(input.value.trim())
  if (!url) {
    error.textContent = 'Paste an official https://www.jw.org link.'
    return
  }
  error.textContent = ''
  addLink(url)
  input.value = ''
  event.currentTarget.hidden = true
}

document.getElementById('present-slide').onclick = () => {
  presentActiveItem().catch((error) => setStatus(error.message))
}

document.getElementById('previous-slide').onclick = () => {
  if (activeIndex <= 0) return
  activeIndex -= 1
  renderQueue()
  if (mode === 'presentation') {
    presentActiveItem().catch((error) => setStatus(error.message))
  }
}

document.getElementById('next-slide').onclick = () => {
  if (activeIndex >= queue.length - 1) return
  activeIndex += 1
  renderQueue()
  if (mode === 'presentation') {
    presentActiveItem().catch((error) => setStatus(error.message))
  }
}

document.getElementById('return-camera').onclick = () => {
  returnToCamera().catch((error) => setStatus(error.message))
}

document.getElementById('speaker-pip').onclick = () => {
  speakerVisible = !speakerVisible
  updateControlState()
}

document.getElementById('screen-share').onclick = () => {
  shareScreen().catch((error) => setStatus(error.message))
}

document.getElementById('clear-queue').onclick = () => {
  clearQueue().catch((error) => setStatus(error.message))
}

start().catch((error) => {
  console.error(error)
  setStatus(`error: ${error.message}`)
})
