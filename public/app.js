// ===== MeetUp - WebRTC Video Conferencing Client =====

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// ===== Mobile Detection =====
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// ===== Shared State =====
let localStream = null;
let micEnabled = true;
let camEnabled = true;

// ===== Utility =====
function generateRoomCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 10; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function showToast(message) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// Safe play helper — handles autoplay restrictions on mobile
function safePlay(videoEl) {
  if (!videoEl) return;
  const playPromise = videoEl.play();
  if (playPromise !== undefined) {
    playPromise.catch(() => {
      // Autoplay blocked — retry on first user interaction
      document.addEventListener('click', () => videoEl.play(), { once: true });
    });
  }
}

// ===== Detect which page we are on =====
const isLobby = document.body.classList.contains('lobby-page');
const isRoom = document.body.classList.contains('room-page');

// ============================================================
//  LOBBY PAGE LOGIC
// ============================================================
if (isLobby) {
  const previewVideo = document.getElementById('preview-video');
  const previewPlaceholder = document.getElementById('preview-placeholder');
  const toggleMicBtn = document.getElementById('toggle-preview-mic');
  const toggleCamBtn = document.getElementById('toggle-preview-cam');
  const newMeetingBtn = document.getElementById('new-meeting-btn');
  const joinBtn = document.getElementById('join-btn');
  const roomCodeInput = document.getElementById('room-code-input');

  // Request camera/mic for preview
  async function startPreview() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      previewVideo.srcObject = localStream;
      safePlay(previewVideo);
      previewPlaceholder.classList.add('hidden');
    } catch (err) {
      console.warn('Could not access camera/mic:', err.message);
      previewPlaceholder.classList.remove('hidden');
    }
  }

  startPreview();

  // Toggle mic in preview
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      micEnabled = !micEnabled;
      audioTrack.enabled = micEnabled;
      toggleMicBtn.classList.toggle('muted', !micEnabled);
      toggleMicBtn.querySelector('.material-icons').textContent = micEnabled ? 'mic' : 'mic_off';
    }
  });

  // Toggle camera in preview
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      camEnabled = !camEnabled;
      videoTrack.enabled = camEnabled;
      toggleCamBtn.classList.toggle('muted', !camEnabled);
      toggleCamBtn.querySelector('.material-icons').textContent = camEnabled ? 'videocam' : 'videocam_off';
      if (camEnabled) {
        previewPlaceholder.classList.add('hidden');
      } else {
        previewPlaceholder.classList.remove('hidden');
      }
    }
  });

  // New Meeting
  newMeetingBtn.addEventListener('click', () => {
    const code = generateRoomCode();
    // Stop preview tracks before navigating
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    window.location.href = `room.html?room=${code}&mic=${micEnabled}&cam=${camEnabled}`;
  });

  // Enable/disable Join button based on input
  roomCodeInput.addEventListener('input', () => {
    const val = roomCodeInput.value.trim();
    joinBtn.disabled = val.length === 0;
  });

  // Join existing meeting
  joinBtn.addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toLowerCase();
    if (!code) return;
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    window.location.href = `room.html?room=${code}&mic=${micEnabled}&cam=${camEnabled}`;
  });

  // Allow Enter key to join
  roomCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !joinBtn.disabled) {
      joinBtn.click();
    }
  });
}

// ============================================================
//  ROOM PAGE LOGIC
// ============================================================
if (isRoom) {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  const initialMic = params.get('mic') !== 'false';
  const initialCam = params.get('cam') !== 'false';

  if (!roomId) {
    window.location.href = 'index.html';
  }

  // State
  let myPeerId = null;
  let ws = null;
  let peers = {}; // peerId -> { pc, stream, iceCandidateBuffer }
  let isScreenSharing = false;
  let originalVideoTrack = null;
  let startTime = Date.now();
  let timerInterval = null;
  let wsReconnectTimer = null;
  let intentionalLeave = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let recordingStream = null;
  let speechRecognition = null;
  let isTranscribing = false;
  let transcriptLines = [];

  // DOM Elements
  const videoGrid = document.getElementById('video-grid');
  const localVideo = document.getElementById('local-video');
  const localMuteIcon = document.getElementById('local-mute-icon');
  const meetingCodeEl = document.getElementById('meeting-code');
  const elapsedTimeEl = document.getElementById('elapsed-time');
  const participantCountEl = document.getElementById('participant-count');
  const toggleMicBtn = document.getElementById('toggle-mic');
  const toggleCamBtn = document.getElementById('toggle-cam');
  const shareScreenBtn = document.getElementById('share-screen');
  const toggleChatBtn = document.getElementById('toggle-chat');
  const copyLinkBtn = document.getElementById('copy-link');
  const recordBtn = document.getElementById('record-btn');
  const recordingIndicator = document.getElementById('recording-indicator');
  const leaveBtn = document.getElementById('leave-btn');
  const chatPanel = document.getElementById('chat-panel');
  const closeChatBtn = document.getElementById('close-chat');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const sendChatBtn = document.getElementById('send-chat-btn');

  // Minutes panel DOM
  const minutesPanel = document.getElementById('minutes-panel');
  const closeMinutesBtn = document.getElementById('close-minutes');
  const toggleMinutesBtn = document.getElementById('toggle-minutes');
  const toggleTranscriptionBtn = document.getElementById('toggle-transcription');
  const transcriptContent = document.getElementById('transcript-content');
  const generateMinutesBtn = document.getElementById('generate-minutes-btn');
  const generatedMinutes = document.getElementById('generated-minutes');
  const speechLangSelect = document.getElementById('speech-lang');
  const transcriptBanner = document.getElementById('transcript-banner');
  const bannerText = document.getElementById('banner-text');

  // Hide screen share button on mobile (getDisplayMedia not supported)
  if (isMobile && shareScreenBtn) {
    shareScreenBtn.style.display = 'none';
  }

  // Set meeting code display
  meetingCodeEl.textContent = roomId;

  // Timer
  function updateTimer() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    elapsedTimeEl.textContent = `${mins}:${secs}`;
  }
  timerInterval = setInterval(updateTimer, 1000);

  // Update participant count
  function updateParticipantCount() {
    const count = Object.keys(peers).length + 1; // +1 for self
    participantCountEl.textContent = count;
  }

  // Update video grid layout — count actual .video-tile elements
  function updateGridLayout() {
    const tileCount = videoGrid.querySelectorAll('.video-tile').length;
    videoGrid.className = 'video-grid';

    if (tileCount <= 1) videoGrid.classList.add('grid-1');
    else if (tileCount === 2) videoGrid.classList.add('grid-2');
    else if (tileCount <= 4) videoGrid.classList.add('grid-3-4');
    else if (tileCount <= 6) videoGrid.classList.add('grid-5-6');
    else videoGrid.classList.add('grid-many');
  }

  // Generate display name from peer ID
  function peerDisplayName(peerId) {
    return 'User ' + peerId.substring(0, 4).toUpperCase();
  }

  // ===== Get Local Media =====
  async function getLocalMedia() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localVideo.srcObject = localStream;
      safePlay(localVideo);

      // Apply initial mic/cam state from lobby
      micEnabled = initialMic;
      camEnabled = initialCam;

      const audioTrack = localStream.getAudioTracks()[0];
      const videoTrack = localStream.getVideoTracks()[0];

      if (audioTrack) {
        audioTrack.enabled = micEnabled;
        toggleMicBtn.classList.toggle('muted', !micEnabled);
        toggleMicBtn.querySelector('.material-icons').textContent = micEnabled ? 'mic' : 'mic_off';
        localMuteIcon.style.display = micEnabled ? 'none' : 'inline';
      }

      if (videoTrack) {
        videoTrack.enabled = camEnabled;
        toggleCamBtn.classList.toggle('muted', !camEnabled);
        toggleCamBtn.querySelector('.material-icons').textContent = camEnabled ? 'videocam' : 'videocam_off';
      }
    } catch (err) {
      console.error('Failed to get local media:', err);
      showToast('Could not access camera/microphone');
    }
  }

  // ===== Create Peer Connection =====
  function createPeerConnection(remotePeerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Create remote stream and tile FIRST, before any events can fire
    const remoteStream = new MediaStream();
    createRemoteTile(remotePeerId, remoteStream);

    // Add local tracks
    if (localStream) {
      localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
      });
    }

    // ICE candidate buffer — queue candidates until remote description is set
    const iceCandidateBuffer = [];

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        wsSend({
          type: 'ice-candidate',
          targetPeerId: remotePeerId,
          candidate: event.candidate,
        });
      }
    };

    // Handle remote tracks — tile already exists so videoEl is guaranteed
    pc.ontrack = (event) => {
      remoteStream.addTrack(event.track);
      const videoEl = document.querySelector(`#tile-${remotePeerId} video`);
      if (videoEl) {
        videoEl.srcObject = remoteStream;
        safePlay(videoEl);
      }
    };

    // Negotiation needed handler
    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        wsSend({
          type: 'offer',
          targetPeerId: remotePeerId,
          offer: pc.localDescription,
        });
      } catch (err) {
        console.warn('Negotiation needed error:', err);
      }
    };

    // Connection state logging
    pc.onconnectionstatechange = () => {
      console.log(`[Peer ${remotePeerId}] Connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        console.warn(`Peer ${remotePeerId} connection ${pc.connectionState}`);
      }
    };

    peers[remotePeerId] = { pc, stream: remoteStream, iceCandidateBuffer };

    updateParticipantCount();
    updateGridLayout();

    return pc;
  }

  // Flush buffered ICE candidates after remote description is set
  async function flushIceCandidates(peerId) {
    const peer = peers[peerId];
    if (!peer) return;
    const buffer = peer.iceCandidateBuffer;
    while (buffer.length > 0) {
      const candidate = buffer.shift();
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Failed to add buffered ICE candidate:', err);
      }
    }
  }

  // ===== Create Remote Video Tile =====
  function createRemoteTile(peerId, stream) {
    // Don't create duplicate tiles
    if (document.getElementById(`tile-${peerId}`)) return;

    const tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${peerId}`;
    tile.dataset.peer = peerId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;

    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';

    const name = document.createElement('span');
    name.className = 'tile-name';
    name.textContent = peerDisplayName(peerId);

    const muteIcon = document.createElement('span');
    muteIcon.className = 'tile-mute-icon material-icons';
    muteIcon.id = `mute-icon-${peerId}`;
    muteIcon.textContent = 'mic_off';
    muteIcon.style.display = 'none';

    overlay.appendChild(name);
    overlay.appendChild(muteIcon);
    tile.appendChild(video);
    tile.appendChild(overlay);
    videoGrid.appendChild(tile);

    // Ensure playback starts (handles autoplay restriction)
    safePlay(video);
  }

  // ===== Remove Remote Tile =====
  function removePeer(peerId) {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      tile.style.animation = 'tileIn 0.2s ease reverse';
      setTimeout(() => tile.remove(), 200);
    }

    if (peers[peerId]) {
      peers[peerId].pc.close();
      delete peers[peerId];
    }

    updateParticipantCount();
    setTimeout(updateGridLayout, 250);
  }

  // ===== WebSocket =====
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      // Clear any pending reconnect timer
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
      wsSend({ type: 'join', roomId });
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      await handleSignalingMessage(msg);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      // Auto-reconnect after 2 seconds unless we left intentionally
      if (!intentionalLeave) {
        wsReconnectTimer = setTimeout(() => connectWebSocket(), 2000);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  function wsSend(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  // ===== Handle Signaling Messages =====
  async function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        myPeerId = msg.peerId;
        console.log('My peer ID:', myPeerId);
        break;

      case 'room-joined':
        console.log(`Joined room ${msg.roomId} with peers:`, msg.peers);
        showToast(`Joined meeting: ${msg.roomId}`);
        // Create offers to all existing peers (I'm the newcomer)
        for (const peerId of msg.peers) {
          await createOfferForPeer(peerId);
        }
        break;

      case 'peer-joined':
        console.log(`New peer joined: ${msg.peerId}`);
        showToast(`${peerDisplayName(msg.peerId)} joined the meeting`);
        // Wait for them to send us an offer (they are the newcomer)
        break;

      case 'offer': {
        console.log(`Received offer from ${msg.peerId}`);
        // Create peer connection and tile FIRST
        const pc = createPeerConnection(msg.peerId);
        // Now set remote description — ontrack may fire here but tile already exists
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
        // Flush any ICE candidates that arrived before remote description was set
        await flushIceCandidates(msg.peerId);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        wsSend({
          type: 'answer',
          targetPeerId: msg.peerId,
          answer: answer,
        });
        break;
      }

      case 'answer': {
        console.log(`Received answer from ${msg.peerId}`);
        const peer = peers[msg.peerId];
        if (peer) {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
          // Flush any ICE candidates that arrived before remote description was set
          await flushIceCandidates(msg.peerId);
        }
        break;
      }

      case 'ice-candidate': {
        const peer = peers[msg.peerId];
        if (peer) {
          // Buffer candidates if remote description isn't set yet
          if (!peer.pc.remoteDescription) {
            peer.iceCandidateBuffer.push(msg.candidate);
          } else {
            try {
              await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } catch (err) {
              console.warn('Failed to add ICE candidate:', err);
            }
          }
        } else {
          // Peer connection doesn't exist yet — this can happen if ICE arrives before offer
          // We can't buffer without a peer object, so log and drop
          console.warn(`ICE candidate received for unknown peer ${msg.peerId}, dropping`);
        }
        break;
      }

      case 'peer-left':
        console.log(`Peer left: ${msg.peerId}`);
        showToast(`${peerDisplayName(msg.peerId)} left the meeting`);
        removePeer(msg.peerId);
        break;

      case 'transcript': {
        // Received transcript line from any peer (including self)
        const senderName = msg.peerId === myPeerId ? 'You' : peerDisplayName(msg.peerId);
        const ts = typeof msg.time === 'number'
          ? new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : msg.time;
        // Only add to transcriptLines if not already from local (avoid duplicates)
        if (msg.peerId !== myPeerId) {
          transcriptLines.push({ time: ts, text: msg.text, speaker: senderName });
          addTranscriptLine(ts, msg.text, senderName);
        }
        break;
      }

      case 'chat':
        addChatMessage(msg.peerId, msg.message, msg.timestamp);
        break;

      case 'error':
        console.error('Server error:', msg.message);
        break;
    }
  }

  // ===== Create Offer =====
  async function createOfferForPeer(peerId) {
    const pc = createPeerConnection(peerId);
    // Remove the onnegotiationneeded handler for this initial offer
    // to avoid duplicate offers, since we are creating one explicitly
    pc.onnegotiationneeded = null;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({
      type: 'offer',
      targetPeerId: peerId,
      offer: offer,
    });
  }

  // ===== Controls =====

  // Toggle Mic
  toggleMicBtn.addEventListener('click', () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    micEnabled = !micEnabled;
    audioTrack.enabled = micEnabled;

    toggleMicBtn.classList.toggle('muted', !micEnabled);
    toggleMicBtn.querySelector('.material-icons').textContent = micEnabled ? 'mic' : 'mic_off';
    localMuteIcon.style.display = micEnabled ? 'none' : 'inline';
  });

  // Toggle Camera
  toggleCamBtn.addEventListener('click', () => {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    camEnabled = !camEnabled;
    videoTrack.enabled = camEnabled;

    toggleCamBtn.classList.toggle('muted', !camEnabled);
    toggleCamBtn.querySelector('.material-icons').textContent = camEnabled ? 'videocam' : 'videocam_off';
  });

  // Screen Share — disabled on mobile
  shareScreenBtn.addEventListener('click', async () => {
    if (isMobile) return;

    if (!isScreenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screenStream.getVideoTracks()[0];

        // Save original camera track
        originalVideoTrack = localStream.getVideoTracks()[0];

        // Replace track in all peer connections
        for (const peerId of Object.keys(peers)) {
          const sender = peers[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) {
            await sender.replaceTrack(screenTrack);
          }
        }

        // Show screen share in local preview
        localVideo.srcObject = new MediaStream([screenTrack, ...localStream.getAudioTracks()]);
        safePlay(localVideo);
        document.getElementById('local-tile').classList.add('screen-share');

        isScreenSharing = true;
        shareScreenBtn.classList.add('sharing');
        showToast('You are sharing your screen');

        // Handle when user stops sharing via browser UI
        screenTrack.onended = () => stopScreenShare();
      } catch (err) {
        console.warn('Screen share cancelled or failed:', err.message);
      }
    } else {
      stopScreenShare();
    }
  });

  async function stopScreenShare() {
    if (!originalVideoTrack) return;

    // Replace screen track back with camera track
    for (const peerId of Object.keys(peers)) {
      const sender = peers[peerId].pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(originalVideoTrack);
      }
    }

    localVideo.srcObject = localStream;
    safePlay(localVideo);
    document.getElementById('local-tile').classList.remove('screen-share');
    isScreenSharing = false;
    shareScreenBtn.classList.remove('sharing');
    originalVideoTrack = null;
    showToast('Screen sharing stopped');
  }

  // Toggle Chat
  toggleChatBtn.addEventListener('click', () => {
    chatPanel.classList.toggle('open');
    toggleChatBtn.classList.toggle('active');
    // Close minutes if open
    if (chatPanel.classList.contains('open')) {
      minutesPanel.classList.remove('open');
      toggleMinutesBtn.classList.remove('active');
    }
  });

  closeChatBtn.addEventListener('click', () => {
    chatPanel.classList.remove('open');
    toggleChatBtn.classList.remove('active');
  });

  // ===== Recording =====
  function createRecordingStream() {
    // Combine all audio+video into one stream for recording
    const audioCtx = new AudioContext();
    const destination = audioCtx.createMediaStreamDestination();

    // Add local audio
    if (localStream) {
      const localAudioTracks = localStream.getAudioTracks();
      if (localAudioTracks.length > 0) {
        const localSource = audioCtx.createMediaStreamSource(
          new MediaStream(localAudioTracks)
        );
        localSource.connect(destination);
      }
    }

    // Add remote audio from all peers
    for (const peerId of Object.keys(peers)) {
      const remoteStream = peers[peerId].stream;
      const remoteAudioTracks = remoteStream.getAudioTracks();
      if (remoteAudioTracks.length > 0) {
        const remoteSource = audioCtx.createMediaStreamSource(
          new MediaStream(remoteAudioTracks)
        );
        remoteSource.connect(destination);
      }
    }

    // Use local video track (or screen share if active)
    const videoTrack = localVideo.srcObject
      ? localVideo.srcObject.getVideoTracks()[0]
      : null;

    const tracks = [...destination.stream.getTracks()];
    if (videoTrack) tracks.push(videoTrack);

    return { stream: new MediaStream(tracks), audioCtx };
  }

  function startRecording() {
    try {
      const { stream, audioCtx } = createRecordingStream();
      recordingStream = { stream, audioCtx };
      recordedChunks = [];

      // Pick supported mime type
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
          ? 'video/webm;codecs=vp8,opus'
          : 'video/webm';

      mediaRecorder = new MediaRecorder(stream, { mimeType });

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        downloadRecording();
        // Clean up audio context
        if (recordingStream && recordingStream.audioCtx) {
          recordingStream.audioCtx.close().catch(() => {});
        }
        recordingStream = null;
      };

      mediaRecorder.start(1000); // Collect data every second
      isRecording = true;
      recordBtn.classList.add('recording');
      recordBtn.querySelector('.material-icons').textContent = 'stop';
      recordingIndicator.classList.add('active');
      showToast('Recording started');
    } catch (err) {
      console.error('Failed to start recording:', err);
      showToast('Could not start recording');
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    isRecording = false;
    recordBtn.classList.remove('recording');
    recordBtn.querySelector('.material-icons').textContent = 'fiber_manual_record';
    recordingIndicator.classList.remove('active');
    showToast('Recording stopped — downloading file');
  }

  async function downloadRecording() {
    if (recordedChunks.length === 0) return;

    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    recordedChunks = [];

    showToast('Converting to MP4...');

    try {
      const formData = new FormData();
      formData.append('video', blob, 'recording.webm');

      const response = await fetch('/api/convert', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Conversion failed');

      const mp4Blob = await response.blob();
      const url = URL.createObjectURL(mp4Blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `MeetUp-Recording-${timestamp}.mp4`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('MP4 recording downloaded!');
    } catch (err) {
      console.error('MP4 conversion failed, falling back to WebM:', err);
      // Fallback: download as WebM
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `MeetUp-Recording-${timestamp}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Downloaded as WebM (MP4 conversion unavailable)');
    }
  }

  recordBtn.addEventListener('click', () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  // Copy Link
  copyLinkBtn.addEventListener('click', () => {
    const url = `${window.location.origin}/room.html?room=${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      showToast('Meeting link copied to clipboard');
    }).catch(() => {
      // Fallback
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      showToast('Meeting link copied to clipboard');
    });
  });

  // Leave Meeting
  leaveBtn.addEventListener('click', () => {
    leaveMeeting();
  });

  function leaveMeeting() {
    intentionalLeave = true;

    // Stop transcription
    if (isTranscribing) {
      stopTranscription();
    }

    // Auto-stop recording and download before leaving
    if (isRecording) {
      stopRecording();
    }

    // Clear reconnect timer
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }

    // Close all peer connections
    for (const peerId of Object.keys(peers)) {
      peers[peerId].pc.close();
    }
    peers = {};

    // Stop local tracks
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
    }

    // Tell server we're leaving
    wsSend({ type: 'leave' });

    // Close WebSocket
    if (ws) ws.close();

    // Clear timer
    clearInterval(timerInterval);

    // Navigate back to lobby
    window.location.href = 'index.html';
  }

  // ===== Chat =====
  function addChatMessage(senderId, message, timestamp) {
    // Remove the empty state placeholder
    const empty = chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();

    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message';

    const isMe = senderId === myPeerId;
    const senderName = isMe ? 'You' : peerDisplayName(senderId);
    const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    msgEl.innerHTML = `
      <div class="chat-message-header">
        <span class="chat-sender">${senderName}</span>
        <span class="chat-time">${time}</span>
      </div>
      <div class="chat-text">${escapeHtml(message)}</div>
    `;

    chatMessages.appendChild(msgEl);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Send chat message
  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    wsSend({ type: 'chat', message: text });
    chatInput.value = '';
  }

  sendChatBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  // ===== Minutes Panel =====
  toggleMinutesBtn.addEventListener('click', () => {
    minutesPanel.classList.toggle('open');
    toggleMinutesBtn.classList.toggle('active');
    // Close chat if open
    if (minutesPanel.classList.contains('open')) {
      chatPanel.classList.remove('open');
      toggleChatBtn.classList.remove('active');
    }
  });

  closeMinutesBtn.addEventListener('click', () => {
    minutesPanel.classList.remove('open');
    toggleMinutesBtn.classList.remove('active');
  });

  // ===== Live Transcription (Web Speech API) =====
  const transcriptionStatus = document.getElementById('transcription-status');
  const manualTranscriptInput = document.getElementById('manual-transcript-input');
  const addManualNoteBtn = document.getElementById('add-manual-note');
  let speechRecognitionRetries = 0;
  let micDeniedRetries = 0;
  const MAX_SPEECH_RETRIES = 3;
  const MAX_MIC_DENIED_RETRIES = 3;

  // Check browser support upfront
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speechSupported = !!SpeechRecognition;

  if (!speechSupported) {
    transcriptionStatus.textContent = 'Not supported';
    transcriptionStatus.classList.add('error');
    toggleTranscriptionBtn.style.display = 'none';
  }

  function getSelectedLang() {
    return speechLangSelect ? speechLangSelect.value : 'kn-IN';
  }

  function getLangLabel() {
    if (!speechLangSelect) return 'Kannada';
    const opt = speechLangSelect.options[speechLangSelect.selectedIndex];
    return opt ? opt.textContent : 'Kannada';
  }

  function setTranscriptionStatus(text, type) {
    transcriptionStatus.textContent = text;
    transcriptionStatus.className = 'transcription-status';
    if (type) transcriptionStatus.classList.add(type);
  }

  function clearTranscriptEmpty() {
    const emptyEl = transcriptContent.querySelector('.transcript-empty');
    if (emptyEl) emptyEl.remove();
  }

  function showBanner(show) {
    if (show) {
      bannerText.textContent = `Transcribing (${getLangLabel()})`;
      transcriptBanner.classList.add('active');
    } else {
      transcriptBanner.classList.remove('active');
    }
  }

  function startTranscription() {
    if (!speechSupported) {
      showToast('Speech recognition not supported — use Chrome or Edge, or type notes manually');
      return;
    }

    const lang = getSelectedLang();

    try {
      speechRecognition = new SpeechRecognition();
      speechRecognition.continuous = true;
      speechRecognition.interimResults = true;
      speechRecognition.lang = lang;
      speechRecognition.maxAlternatives = 1;

      clearTranscriptEmpty();
      setTranscriptionStatus('Starting...', 'listening');

      speechRecognition.onstart = () => {
        console.log('Speech recognition started, lang:', lang);
        speechRecognitionRetries = 0;
        micDeniedRetries = 0;
        setTranscriptionStatus('Listening...', 'listening');
        showBanner(true);
      };

      speechRecognition.onresult = (event) => {
        let interimTranscript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            const text = result[0].transcript.trim();
            if (text) {
              const now = new Date();
              const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              transcriptLines.push({ time: ts, text, speaker: 'You' });
              addTranscriptLine(ts, text, 'You');
              // Share with all peers via WebSocket
              wsSend({
                type: 'transcript',
                text,
                time: Date.now(),
                lang,
              });
            }
          } else {
            interimTranscript += result[0].transcript;
          }
        }
        // Show interim text
        let interimEl = transcriptContent.querySelector('.transcript-interim');
        if (interimTranscript) {
          if (!interimEl) {
            interimEl = document.createElement('div');
            interimEl.className = 'transcript-line transcript-interim';
            interimEl.style.opacity = '0.5';
            interimEl.style.fontStyle = 'italic';
            transcriptContent.appendChild(interimEl);
          }
          interimEl.textContent = interimTranscript;
          transcriptContent.scrollTop = transcriptContent.scrollHeight;
        } else if (interimEl) {
          interimEl.remove();
        }
      };

      speechRecognition.onerror = (event) => {
        console.warn('Speech recognition error:', event.error);
        switch (event.error) {
          case 'not-allowed':
          case 'service-not-allowed':
            micDeniedRetries++;
            if (micDeniedRetries <= MAX_MIC_DENIED_RETRIES) {
              console.warn(`Speech mic denied (attempt ${micDeniedRetries}/${MAX_MIC_DENIED_RETRIES}) — retrying`);
              setTranscriptionStatus('Mic busy, retrying...', 'listening');
              setTimeout(() => {
                if (isTranscribing) {
                  stopTranscription();
                  startTranscription();
                }
              }, 3000);
            } else {
              showToast('Transcription unavailable — use manual notes instead');
              setTranscriptionStatus('Use manual notes', 'error');
              stopTranscription();
            }
            return;
          case 'no-speech':
            setTranscriptionStatus('No speech detected...', 'listening');
            break;
          case 'network':
            showToast('Network error — speech recognition requires internet');
            setTranscriptionStatus('Network error', 'error');
            stopTranscription();
            break;
          case 'aborted':
            break;
          default:
            setTranscriptionStatus('Error: ' + event.error, 'error');
        }
      };

      speechRecognition.onend = () => {
        console.log('Speech recognition ended, isTranscribing:', isTranscribing);
        if (isTranscribing) {
          speechRecognitionRetries++;
          if (speechRecognitionRetries > MAX_SPEECH_RETRIES) {
            // Too many rapid restarts — pause longer to avoid mic toggling
            setTranscriptionStatus('Paused, resuming...', 'listening');
            speechRecognitionRetries = 0;
            setTimeout(() => {
              if (isTranscribing) {
                stopTranscription();
                startTranscription();
              }
            }, 3000);
            return;
          }
          // Restart after a delay to avoid mic conflict with WebRTC
          const restartDelay = isMobile ? 1500 : 800;
          setTimeout(() => {
            if (isTranscribing && speechRecognition) {
              try {
                speechRecognition.start();
              } catch (e) {
                console.warn('Failed to restart speech recognition:', e);
              }
            }
          }, restartDelay);
        }
      };

      speechRecognition.start();
      isTranscribing = true;
      toggleTranscriptionBtn.classList.add('active');
      toggleTranscriptionBtn.querySelector('.material-icons').textContent = 'stop';
      showToast(`Transcription started — ${getLangLabel()}`);
    } catch (err) {
      console.error('Failed to start speech recognition:', err);
      showToast('Could not start transcription: ' + err.message);
      setTranscriptionStatus('Failed to start', 'error');
    }
  }

  function stopTranscription() {
    isTranscribing = false;
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch (e) {}
      speechRecognition = null;
    }
    toggleTranscriptionBtn.classList.remove('active');
    toggleTranscriptionBtn.querySelector('.material-icons').textContent = 'play_arrow';
    setTranscriptionStatus('', '');
    showBanner(false);
    speechRecognitionRetries = 0;
  }

  // Restart transcription when language changes
  if (speechLangSelect) {
    speechLangSelect.addEventListener('change', () => {
      if (isTranscribing) {
        stopTranscription();
        startTranscription();
      }
    });
  }

  function addTranscriptLine(time, text, speaker) {
    clearTranscriptEmpty();
    const interimEl = transcriptContent.querySelector('.transcript-interim');
    if (interimEl) interimEl.remove();

    const line = document.createElement('div');
    line.className = 'transcript-line';
    const speakerLabel = speaker ? `<span class="transcript-speaker">${escapeHtml(speaker)}:</span> ` : '';
    line.innerHTML = `<span class="ts">[${escapeHtml(time)}]</span> ${speakerLabel}${escapeHtml(text)}`;
    transcriptContent.appendChild(line);
    transcriptContent.scrollTop = transcriptContent.scrollHeight;
  }

  toggleTranscriptionBtn.addEventListener('click', () => {
    if (!isTranscribing) {
      startTranscription();
    } else {
      stopTranscription();
    }
  });

  // ===== Manual Transcript Input (fallback) =====
  function addManualNote() {
    const text = manualTranscriptInput.value.trim();
    if (!text) return;
    const now = new Date();
    const ts = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    transcriptLines.push({ time: ts, text, speaker: 'You' });
    addTranscriptLine(ts, text, 'You');
    // Share manual notes too
    wsSend({ type: 'transcript', text, time: Date.now(), lang: getSelectedLang() });
    manualTranscriptInput.value = '';
  }

  addManualNoteBtn.addEventListener('click', addManualNote);
  manualTranscriptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addManualNote();
  });

  // ===== Generate AI Minutes =====
  generateMinutesBtn.addEventListener('click', async () => {
    if (transcriptLines.length === 0) {
      showToast('No transcript available. Use speech transcription or type notes manually.');
      return;
    }

    // Build transcript text with speaker labels
    const transcriptText = transcriptLines
      .map(l => `[${l.time}] ${l.speaker || 'Unknown'}: ${l.text}`)
      .join('\n');

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const duration = `${mins}m ${secs}s`;

    // Show loading
    generatedMinutes.innerHTML = `
      <div class="minutes-loading">
        <div class="spinner"></div>
        Generating minutes with AI...
      </div>
    `;
    generateMinutesBtn.disabled = true;

    try {
      const response = await fetch('/api/generate-minutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: transcriptText,
          meetingCode: roomId,
          duration,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to generate minutes');
      }

      // Render markdown-like content
      generatedMinutes.innerHTML = renderMinutes(data.minutes);
      showToast('Meeting minutes generated!');
    } catch (err) {
      console.error('Minutes generation failed:', err);
      generatedMinutes.innerHTML = `
        <div class="minutes-empty">
          <span class="material-icons" style="color:var(--red)">error</span>
          <p>${escapeHtml(err.message)}</p>
        </div>
      `;
      showToast('Failed to generate minutes');
    }

    generateMinutesBtn.disabled = false;
  });

  // Simple markdown-to-HTML renderer for minutes
  function renderMinutes(text) {
    return text
      // Headers
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Tables
      .replace(/^\|(.+)\|$/gm, (match) => {
        const cells = match.split('|').filter(c => c.trim() !== '');
        const isHeader = cells.every(c => /^[\s-:]+$/.test(c));
        if (isHeader) return ''; // separator row
        const tag = 'td';
        const row = cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('');
        return `<tr>${row}</tr>`;
      })
      // Wrap consecutive tr rows in table
      .replace(/((<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>')
      // Make first row headers
      .replace(/<table><tr>(.*?)<\/tr>/g, (match, row) => {
        const headerRow = row.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>');
        return `<table><tr>${headerRow}</tr>`;
      })
      // Bullet points
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/((<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
      // Paragraphs (lines that aren't already wrapped)
      .replace(/^(?!<[hultdp]|<\/|<tr|<table)(.+)$/gm, '<p>$1</p>')
      // Clean up empty paragraphs
      .replace(/<p>\s*<\/p>/g, '');
  }

  // ===== Handle page visibility =====
  // When phone locks or tab goes background, streams can pause
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && localStream) {
      localVideo.srcObject = localStream;
      safePlay(localVideo);
    }
  });

  // ===== Handle page unload =====
  window.addEventListener('beforeunload', () => {
    intentionalLeave = true;
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    wsSend({ type: 'leave' });
    if (ws) ws.close();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
  });

  // ===== Initialize Room =====
  async function initRoom() {
    await getLocalMedia();
    connectWebSocket();
    updateGridLayout();

    // Auto-start transcription only after mic is confirmed working
    if (speechSupported) {
      const waitForMic = () => {
        if (localStream && localStream.getAudioTracks().length > 0 && localStream.getAudioTracks()[0].enabled) {
          // Mic is ready — start transcription after a settle delay
          setTimeout(() => {
            startTranscription();
          }, 2000);
        } else {
          // Mic not ready yet — retry in 2s, give up after 15s
          if (Date.now() - startTime < 15000) {
            setTimeout(waitForMic, 2000);
          }
        }
      };
      setTimeout(waitForMic, 3000);
    }
  }

  initRoom();
}
