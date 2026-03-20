/**
 * sttBridge.js -- Mission Control speech bridge
 *
 * Consumes the STT backend websocket and translates it into the
 * `window.missionControlSpeech` contract.
 */

function normalizeWsUrl(config = {}) {
  const { url, port = 8200, path = '/ws/activity' } = config;

  if (!url) {
    const derived = new URL(window.location.href);
    derived.protocol = derived.protocol === 'https:' ? 'wss:' : 'ws:';
    derived.port = String(port);
    derived.pathname = path;
    derived.search = '';
    derived.hash = '';
    return derived;
  }

  try {
    if (url.startsWith('ws://') || url.startsWith('wss://')) {
      return new URL(url);
    }

    const source = new URL(url, window.location.href);
    source.protocol = source.protocol === 'https:' ? 'wss:' : 'ws:';
    return source;
  } catch (_err) {
    return null;
  }
}

function setBridgeStatus(text, state = 'idle') {
  const chip = document.getElementById('voice-bridge-status');
  if (!chip) return;
  chip.dataset.state = state;
  chip.textContent = text;
}

function normalizeTranscriptWord(word = '') {
  return String(word || '')
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
}

function extractTranscriptDelta(previousText = '', nextText = '') {
  const prev = String(previousText || '').trim();
  const next = String(nextText || '').trim();
  if (!next || next === prev) return '';
  if (!prev) return next;
  if (next.startsWith(prev)) return next.slice(prev.length).trim();
  if (prev.startsWith(next)) return '';

  const prevWords = prev.split(/\s+/);
  const nextWords = next.split(/\s+/);
  let common = 0;
  while (
    common < prevWords.length &&
    common < nextWords.length &&
    normalizeTranscriptWord(prevWords[common]) === normalizeTranscriptWord(nextWords[common])
  ) {
    common += 1;
  }
  return nextWords.slice(common).join(' ').trim();
}

export function connectMissionControlSpeechBridge(config = {}) {
  const url = normalizeWsUrl(config);
  if (!url) {
    setBridgeStatus('Voice bridge unavailable', 'error');
    return { disconnect() {} };
  }

  let socket = null;
  let retryTimer = null;
  let reconnectDelayMs = 1200;
  let manualClose = false;
  let lastTranscriptText = '';

  const scheduleReconnect = () => {
    if (manualClose || retryTimer) return;
    setBridgeStatus('Voice bridge reconnecting', 'reconnecting');
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      openSocket();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 1.6, 12000);
  };

  const handleEvent = (payload) => {
    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'partial') {
      const deltaText = extractTranscriptDelta(lastTranscriptText, payload.text ?? '');
      console.log('[bridge] partial raw=%o prev=%o delta=%o', payload.text, lastTranscriptText, deltaText);
      if (deltaText) {
        window.missionControlSpeech?.stream({
          text: `${deltaText} `,
          fullText: payload.text ?? '',
        });
      }
      if (typeof payload.text === 'string') {
        lastTranscriptText = payload.text;
      }
      setBridgeStatus('Voice bridge live', 'live');
      return;
    }

    if (payload.type === 'snapshot' || payload.type === 'speech') {
      if (payload.speaking) {
        window.missionControlSpeech?.setActivity({
          level: payload.level ?? 0,
          frequency: payload.frequency ?? payload.frequency_hz ?? 0,
          speaking: true,
        });
        const deltaText = extractTranscriptDelta(lastTranscriptText, payload.text ?? '');
        console.log('[bridge] speech raw=%o prev=%o delta=%o', payload.text, lastTranscriptText, deltaText);
        if (deltaText) {
          window.missionControlSpeech?.stream({
            text: `${deltaText} `,
            fullText: payload.text ?? '',
          });
        }
        if (typeof payload.text === 'string') {
          lastTranscriptText = payload.text;
        }
        setBridgeStatus('Voice bridge live', 'live');
      } else {
        window.missionControlSpeech?.stop();
        setBridgeStatus('Voice bridge idle', 'idle');
      }
      return;
    }

    if (payload.type === 'stop') {
      window.missionControlSpeech?.stop();
      setBridgeStatus('Voice bridge idle', 'idle');
      return;
    }

    if (payload.type === 'response') {
      window.missionControlSpeech?.respond(payload.strength ?? 1, payload.text ?? '');
      setBridgeStatus('Voice bridge response burst', 'response');
      return;
    }

    if (payload.type === 'error') {
      setBridgeStatus('Voice bridge error', 'error');
    }
  };

  const openSocket = () => {
    setBridgeStatus('Voice bridge connecting', 'connecting');
    socket = new WebSocket(url);

    socket.addEventListener('open', () => {
      reconnectDelayMs = 1200;
      setBridgeStatus('Voice bridge ready', 'idle');
    });

    socket.addEventListener('message', (event) => {
      try {
        handleEvent(JSON.parse(event.data));
      } catch (_err) {
        setBridgeStatus('Voice bridge parse error', 'error');
      }
    });

    socket.addEventListener('close', () => {
      socket = null;
      if (!manualClose) scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      setBridgeStatus('Voice bridge socket error', 'error');
    });
  };

  openSocket();

  return {
    disconnect() {
      manualClose = true;
      if (retryTimer) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      socket?.close();
      setBridgeStatus('Voice bridge offline', 'idle');
    },
  };
}
