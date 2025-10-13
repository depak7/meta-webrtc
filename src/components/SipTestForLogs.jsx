import React, { useEffect, useRef, useState } from "react";
import { UserAgent, Registerer, URI, Invitation, SessionState, Inviter } from "sip.js";

export default function SipTest() {
  const [status, setStatus] = useState("Disconnected");
  const [incoming, setIncoming] = useState(null);
  const [active, setActive] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState("91(number here)");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState("00:00");
  const [audioDebugInfo, setAudioDebugInfo] = useState([]);
  const [rtpStats, setRtpStats] = useState({});
  const [lastError, setLastError] = useState(null);
  const [callErrors, setCallErrors] = useState([]);

  const uaRef = useRef(null);
  const regRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const callStartTimeRef = useRef(null);
  const callTimerRef = useRef(null);
  const audioContextRef = useRef(null);
  const gainNodeRef = useRef(null);
  const statsIntervalRef = useRef(null);

  const addDebugLog = (message) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}`);
    setAudioDebugInfo(prev => [...prev.slice(-10), `[${timestamp}] ${message}`]);
  };

  const addError = (errorInfo) => {
    const timestamp = new Date().toLocaleTimeString();
    const errorObj = {
      timestamp,
      ...errorInfo
    };
    
    setCallErrors(prev => [...prev.slice(-4), errorObj]); // Keep last 5 errors
    setLastError(errorObj);
    addDebugLog(`❌ ERROR: ${errorInfo.message || errorInfo.reason || 'Unknown error'}`);
  };

  const parseWhatsAppError = (errorMessage) => {
    if (!errorMessage) return null;
    
    // Parse WhatsApp business limits
    if (errorMessage.includes('Business initiated calls daily limit hit')) {
      const limitMatch = errorMessage.match(/limit: (\d+)/);
      const timeMatch = errorMessage.match(/Next allowed unix epoch time in seconds: (\d+)/);
      
      return {
        type: 'whatsapp_limit',
        title: 'WhatsApp Daily Call Limit Exceeded',
        limit: limitMatch ? parseInt(limitMatch[1]) : 'Unknown',
        nextAllowedTime: timeMatch ? new Date(parseInt(timeMatch[1]) * 1000) : null,
        message: `You've reached the daily limit of ${limitMatch ? limitMatch[1] : 'N/A'} business-initiated calls.`
      };
    }
    
    // Parse 403 Forbidden - common for WhatsApp restrictions
    if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
      // Check if it's related to Q.850 cause codes
      if (errorMessage.includes('Q.850') || errorMessage.includes('cause=21')) {
        return {
          type: 'call_rejected',
          title: 'Call Rejected (403)',
          message: 'The call was rejected by the recipient or due to service restrictions. This may be due to WhatsApp business call limits, user privacy settings, or network restrictions.'
        };
      }
      
      return {
        type: 'forbidden',
        title: 'Call Forbidden (403)',
        message: 'Call not permitted. This could be due to daily call limits, account restrictions, or recipient settings.'
      };
    }
    
    // Parse other common SIP errors
    if (errorMessage.includes('404')) {
      return {
        type: 'not_found',
        title: 'Number Not Found (404)',
        message: 'The number you\'re trying to reach is not available or doesn\'t exist.'
      };
    }
    
    if (errorMessage.includes('486') || errorMessage.includes('Busy')) {
      return {
        type: 'busy',
        title: 'Line Busy (486)',
        message: 'The person you\'re calling is currently busy.'
      };
    }
    
    if (errorMessage.includes('480') || errorMessage.includes('Temporarily Unavailable')) {
      return {
        type: 'unavailable',
        title: 'Temporarily Unavailable (480)',
        message: 'The person you\'re calling is temporarily unavailable.'
      };
    }

    // Handle timeout errors
    if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      return {
        type: 'timeout',
        title: 'Call Timeout',
        message: 'The call attempt timed out. The recipient may be unreachable or there may be network issues.'
      };
    }
    
    return {
      type: 'unknown',
      title: 'Call Failed',
      message: errorMessage || 'An unknown error occurred during the call attempt.'
    };
  };

  useEffect(() => {
    return () => {
      hangup();
      stopUA();
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
      }
    };
  }, []);

  // Call timer effect
  useEffect(() => {
    if (active && active.state === SessionState.Established) {
      callStartTimeRef.current = Date.now();
      callTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - callStartTimeRef.current;
        const minutes = Math.floor(elapsed / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        setCallDuration(`${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`);
      }, 1000);
    } else {
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
        callTimerRef.current = null;
      }
      setCallDuration("00:00");
    }

    return () => {
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
      }
    };
  }, [active]);

  const initializeAudioContext = async () => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
        gainNodeRef.current = audioContextRef.current.createGain();
        gainNodeRef.current.connect(audioContextRef.current.destination);
        gainNodeRef.current.gain.value = 2.0; // Boost volume
        addDebugLog("✅ AudioContext initialized with gain boost");
      }
      
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume();
        addDebugLog("✅ AudioContext resumed");
      }
    } catch (error) {
      addDebugLog(`❌ AudioContext error: ${error.message}`);
    }
  };

  const connectAndRegister = async () => {
    try {
      // Initialize audio context first
      await initializeAudioContext();

      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1
        } 
      });
      
      addDebugLog(`✅ Microphone access granted - Tracks: ${localStreamRef.current.getAudioTracks().length}`);
      localStreamRef.current.getAudioTracks().forEach((track, index) => {
        addDebugLog(`Local track ${index}: ${track.kind}, enabled: ${track.enabled}, muted: ${track.muted}, readyState: ${track.readyState}`);
      });
    } catch (e) {
      addDebugLog(`❌ Mic access denied: ${e.message}`);
      alert("Microphone access is required for voice calls");
      return;
    }

    const ua = new UserAgent({
      uri: new URI("sip", "919538099928", "sipserver.kapturecrm.com"),
      authorizationUsername: "919538099928",
      authorizationPassword: "StrongPass919538099928",
      transportOptions: {
        server: "wss://sipserver.kapturecrm.com:8089/ws",
      },
      sessionDescriptionHandlerFactoryOptions: {
        constraints: { audio: true, video: false },
        peerConnectionConfiguration: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" },
          ],
          iceCandidatePoolSize: 10,
          bundlePolicy: "max-bundle",
          rtcpMuxPolicy: "require"
        }
      },
    });
    
    ua.delegate = {
      onInvite: (inv) => {
        addDebugLog(`📞 Incoming call from: ${inv.remoteIdentity?.displayName || inv.remoteIdentity?.uri || 'Unknown'}`);
        setIncoming(inv);
        setStatus("Incoming call");
      },
    };

    await ua.start();
    uaRef.current = ua;
    addDebugLog("✅ SIP UA started");

    const reg = new Registerer(ua);
    await reg.register();
    regRef.current = reg;
    addDebugLog("✅ SIP Registration successful");

    setStatus("Registered");
  };

  const setupAdvancedAudioHandling = (session) => {
    addDebugLog("🎵 Setting up advanced audio handling");
    
    const sdh = session.sessionDescriptionHandler;
    if (!sdh) {
      addDebugLog("❌ No sessionDescriptionHandler available for audio setup");
      return;
    }

    const pc = sdh.peerConnection;
    addDebugLog(`🔗 PC State: ${pc.connectionState}, ICE: ${pc.iceConnectionState}`);

    // Enhanced track handling with multiple fallback attempts
    pc.ontrack = async (event) => {
      addDebugLog(`🎵 ontrack event fired - streams: ${event.streams.length}, track: ${event.track.kind}`);
      
      event.streams.forEach((stream, streamIndex) => {
        addDebugLog(`Stream ${streamIndex}: id=${stream.id}, tracks=${stream.getTracks().length}`);
        
        stream.getTracks().forEach((track, trackIndex) => {
          addDebugLog(`Track ${trackIndex}: kind=${track.kind}, id=${track.id}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
        });

        if (stream.getAudioTracks().length > 0) {
          setupRemoteAudio(stream);
        }
      });
    };

    // Enhanced ICE handling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        addDebugLog(`🧊 ICE candidate: ${event.candidate.type} ${event.candidate.protocol}`);
      } else {
        addDebugLog("🧊 ICE gathering complete");
      }
    };

    pc.oniceconnectionstatechange = () => {
      addDebugLog(`🧊 ICE Connection State: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected') {
        addDebugLog("✅ ICE connected - attempting audio setup");
        // Delayed audio setup after ICE connection
        setTimeout(() => {
          checkAndSetupAudio(session);
        }, 500);
      }
    };

    pc.onconnectionstatechange = () => {
      addDebugLog(`🔗 Connection State: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        addDebugLog("✅ Peer connection established successfully");
        startStatsMonitoring(pc);
        // Another audio setup attempt
        setTimeout(() => {
          checkAndSetupAudio(session);
        }, 1000);
      }
    };

    // Add local stream
    if (localStreamRef.current) {
      addDebugLog(`🎤 Adding ${localStreamRef.current.getTracks().length} local tracks to peer connection`);
      localStreamRef.current.getTracks().forEach((track, index) => {
        addDebugLog(`Adding local track ${index}: ${track.kind} ${track.label}`);
        pc.addTrack(track, localStreamRef.current);
      });
    }
  };

  const setupRemoteAudio = (stream) => {
    addDebugLog(`🔊 Setting up remote audio with ${stream.getTracks().length} tracks`);
    
    if (!remoteAudioRef.current) {
      addDebugLog("❌ No remote audio element available");
      return;
    }

    // Method 1: Direct assignment
    remoteAudioRef.current.srcObject = stream;
    remoteAudioRef.current.volume = 1.0;
    remoteAudioRef.current.muted = false;
    
    addDebugLog("🔊 Set remote stream to audio element");
    
    // Method 2: Web Audio API for volume boost
    if (audioContextRef.current && gainNodeRef.current) {
      try {
        const source = audioContextRef.current.createMediaStreamSource(stream);
        source.connect(gainNodeRef.current);
        addDebugLog("✅ Connected to Web Audio API with gain boost");
      } catch (audioError) {
        addDebugLog(`⚠️ Web Audio API connection failed: ${audioError.message}`);
      }
    }

    // Enhanced playback handling
    remoteAudioRef.current.onloadedmetadata = () => {
      addDebugLog("📊 Audio metadata loaded");
      playRemoteAudio();
    };
    
    remoteAudioRef.current.oncanplay = () => {
      addDebugLog("🔊 Audio can play");
      playRemoteAudio();
    };
    
    remoteAudioRef.current.onplaying = () => {
      addDebugLog("✅ Audio is playing successfully!");
    };
    
    remoteAudioRef.current.onpause = () => {
      addDebugLog("⏸️ Audio paused");
    };
    
    remoteAudioRef.current.onerror = (e) => {
      addDebugLog(`❌ Audio element error: ${e.target?.error?.message || 'Unknown error'}`);
    };

    // Immediate play attempt
    playRemoteAudio();
  };

  const playRemoteAudio = async () => {
    if (!remoteAudioRef.current) return;

    try {
      await remoteAudioRef.current.play();
      addDebugLog("✅ Remote audio play successful");
    } catch (err) {
      addDebugLog(`⚠️ Remote audio play failed: ${err.message}`);
      
      // Retry with user interaction context
      if (err.name === 'NotAllowedError') {
        addDebugLog("🔄 Retrying audio play after user interaction...");
        
        // Create a user interaction to enable audio
        const enableAudio = () => {
          remoteAudioRef.current?.play()
            .then(() => addDebugLog("✅ Audio enabled after user interaction"))
            .catch(retryErr => addDebugLog(`❌ Audio still failed: ${retryErr.message}`));
          document.removeEventListener('click', enableAudio);
        };
        
        document.addEventListener('click', enableAudio);
        addDebugLog("👆 Click anywhere to enable audio playback");
      }
    }
  };

  const checkAndSetupAudio = (session) => {
    addDebugLog("🔧 Checking and setting up audio streams");
    
    const sdh = session.sessionDescriptionHandler;
    if (!sdh?.peerConnection) {
      addDebugLog("❌ No peer connection available for audio check");
      return;
    }

    const pc = sdh.peerConnection;
    const receivers = pc.getReceivers();
    addDebugLog(`🔍 Found ${receivers.length} receivers`);
    
    receivers.forEach((receiver, index) => {
      if (receiver.track && receiver.track.kind === 'audio') {
        addDebugLog(`Audio receiver ${index}: enabled=${receiver.track.enabled}, muted=${receiver.track.muted}, readyState=${receiver.track.readyState}`);
        
        if (receiver.track.readyState === 'live' && !receiver.track.muted) {
          const stream = new MediaStream([receiver.track]);
          setupRemoteAudio(stream);
        }
      }
    });

    // Also check remote streams directly
    const remoteStreams = pc.getRemoteStreams?.() || [];
    addDebugLog(`🔍 Found ${remoteStreams.length} remote streams via getRemoteStreams`);
    
    remoteStreams.forEach((stream, index) => {
      if (stream.getAudioTracks().length > 0) {
        addDebugLog(`Remote stream ${index} has ${stream.getAudioTracks().length} audio tracks`);
        setupRemoteAudio(stream);
      }
    });
  };

  const startStatsMonitoring = (pc) => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
    }

    statsIntervalRef.current = setInterval(async () => {
      if (pc.connectionState === 'connected') {
        try {
          const stats = await pc.getStats();
          const inboundStats = {};
          const outboundStats = {};

          stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
              inboundStats.packetsReceived = report.packetsReceived;
              inboundStats.bytesReceived = report.bytesReceived;
              inboundStats.packetsLost = report.packetsLost;
              inboundStats.jitter = report.jitter;
              inboundStats.audioLevel = report.audioLevel;
            }
            
            if (report.type === 'outbound-rtp' && report.kind === 'audio') {
              outboundStats.packetsSent = report.packetsSent;
              outboundStats.bytesSent = report.bytesSent;
            }
          });

          setRtpStats({ inbound: inboundStats, outbound: outboundStats });
          
          if (inboundStats.packetsReceived) {
            addDebugLog(`📊 RTP: Received ${inboundStats.packetsReceived} packets, Lost ${inboundStats.packetsLost || 0}`);
          }
        } catch (err) {
          addDebugLog(`❌ Stats error: ${err.message}`);
        }
      }
    }, 3000);
  };

  const acceptCall = async () => {
    if (!incoming) return;
    if (isConnecting) return;

    addDebugLog("📞 Accepting incoming call");
    setIsConnecting(true);
    await initializeAudioContext();

    try {
      await incoming.accept({
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
          offerOptions: { offerToReceiveAudio: true, offerToReceiveVideo: false },
          streams: [localStreamRef.current],
        },
      });

      addDebugLog("✅ Call accepted");
      setupAdvancedAudioHandling(incoming);

      incoming.stateChange.addListener((state) => {
        addDebugLog(`📞 Incoming call state: ${state}`);
        
        if (state === SessionState.Established) {
          addDebugLog("🎯 Incoming call established");
          setStatus("Connected");
          setIsConnecting(false);
          
          // Multiple delayed audio setup attempts
          setTimeout(() => checkAndSetupAudio(incoming), 500);
          setTimeout(() => checkAndSetupAudio(incoming), 1500);
          setTimeout(() => checkAndSetupAudio(incoming), 3000);
        }
        
        if (state === SessionState.Terminated) {
          addDebugLog("📞 Incoming call terminated");
          setIsConnecting(false);
          cleanup();
        }
      });

      setActive(incoming);
      setIncoming(null);
      setStatus("In call");

    } catch (error) {
      addDebugLog(`❌ Error accepting call: ${error.message}`);
      setStatus("Call failed");
      setIsConnecting(false);
    }
  };

  const makeOutboundCall = async () => {
    if (isConnecting) return;
    if (!phoneNumber.trim()) {
      alert("Please enter a phone number");
      return;
    }
  
    if (!uaRef.current) {
      alert("Not connected to SIP server");
      return;
    }
  
    setIsConnecting(true);
    await initializeAudioContext();
  
    const targetURI = new URI(
      "sip",
      `+${phoneNumber.replace(/[^\d]/g, "")}`,
      "wa.meta.vc"
    );
  
    addDebugLog(`📞 Making outbound call to: ${targetURI.toString()}`);
  
    const inviter = new Inviter(uaRef.current, targetURI, {
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
        offerOptions: { offerToReceiveAudio: true, offerToReceiveVideo: false },
        streams: [localStreamRef.current],
      },
    });
  
    // Set up event listeners BEFORE calling invite
    inviter.stateChange.addListener((state) => {
      addDebugLog(`📞 Outbound call state: ${state}`);

      if (state === SessionState.Establishing) {
        setStatus("Ringing...");
        setLastError(null); // Clear any previous errors
      }

      if (state === SessionState.Established) {
        setStatus("In call");
        setLastError(null); // Clear any previous errors
        addDebugLog("🎯 Outbound call established - setting up audio");
        setIsConnecting(false);
        
        // CRITICAL: Wait a bit longer for outbound calls before audio setup
        setTimeout(() => {
          setupAdvancedAudioHandling(inviter);
          checkAndSetupAudio(inviter);
        }, 1000);
        
        // Multiple retry attempts for outbound audio
        setTimeout(() => checkAndSetupAudio(inviter), 2000);
        setTimeout(() => checkAndSetupAudio(inviter), 4000);
        setTimeout(() => checkAndSetupAudio(inviter), 6000);
      }

      if (state === SessionState.Terminated) {
        addDebugLog("📞 Outbound call terminated");
        setIsConnecting(false);
        
        // Check if this is a failure termination
        const sessionDescriptionHandler = inviter.sessionDescriptionHandler;
        if (sessionDescriptionHandler) {
          const pc = sessionDescriptionHandler.peerConnection;
          if (pc && pc.connectionState !== 'connected') {
            addDebugLog("📞 Call terminated before connection - likely an error");
            
            // Check for rejection reason in the inviter
            if (inviter._request && inviter._request.response) {
              const response = inviter._request.response;
              addDebugLog(`📞 Found rejection response: ${response.statusCode} ${response.reasonPhrase}`);
              
              const errorInfo = parseWhatsAppError(response.reasonPhrase || `${response.statusCode} ${response.reasonPhrase}`);
              addError({
                ...errorInfo,
                statusCode: response.statusCode,
                reasonPhrase: response.reasonPhrase
              });
            } else {
              // Generic failure handling
              addError({
                type: 'call_failed',
                title: 'Call Failed',
                message: 'The call was terminated unexpectedly. This might be due to network issues, server restrictions, or call limits.'
              });
            }
          }
        }
        
        cleanup();
      }
    });

    // Add rejection/failure handlers - Enhanced version
    inviter.delegate = {
      onReject: (response) => {
        addDebugLog(`📞 Call rejected via delegate: ${response.statusCode} ${response.reasonPhrase}`);
        
        const errorInfo = parseWhatsAppError(response.reasonPhrase || `${response.statusCode} ${response.reasonPhrase}`);
        addError({
          ...errorInfo,
          statusCode: response.statusCode,
          reasonPhrase: response.reasonPhrase
        });
        
        setStatus("Call failed");
        setIsConnecting(false);
        cleanup();
      },
      
      onCancel: () => {
        addDebugLog("📞 Call cancelled via delegate");
        setStatus("Call cancelled");
        setIsConnecting(false);
        cleanup();
      }
    };

    // Also listen for invite rejection events directly
    try {
      const invitePromise = inviter.invite();
      
      // Add a timeout to catch hanging invites
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Call invitation timeout')), 30000);
      });
      
      await Promise.race([invitePromise, timeoutPromise]);
      
      setActive(inviter);
      setStatus("Calling...");
      addDebugLog("✅ Outbound call initiated");
    } catch (error) {
      addDebugLog(`❌ Error during invite: ${error.message}`);
      
      // Check if this is a SIP rejection
      if (error.message && (error.message.includes('403') || error.message.includes('Forbidden'))) {
        const errorInfo = parseWhatsAppError(error.message);
        addError({
          ...errorInfo,
          originalError: error.message
        });
      } else {
        const errorInfo = parseWhatsAppError(error.message);
        addError({
          ...errorInfo,
          originalError: error.message
        });
      }
      
      setStatus("Call failed");
      setIsConnecting(false);
      cleanup();
    }
  };

  const cleanup = () => {
    setActive(null);
    setIncoming(null);
    setStatus("Registered");
    setRtpStats({});
    setIsConnecting(false);
    
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
    
    // Don't clear errors immediately - let user see them
    setTimeout(() => {
      setLastError(null);
    }, 10000); // Clear after 10 seconds
  };

  const hangup = async () => {
    if (!active) return;

    addDebugLog("📞 Hanging up call");
    try {
      if (active.state === SessionState.Established) {
        await active.bye();
      } else {
        await active.cancel();
      }
    } catch (error) {
      addDebugLog(`❌ Error hanging up: ${error.message}`);
    }

    cleanup();
  };

  const toggleMute = () => {
    if (!active || !localStreamRef.current) return;

    const audioTracks = localStreamRef.current.getAudioTracks();
    audioTracks.forEach(track => {
      track.enabled = isMuted;
    });
    
    setIsMuted(!isMuted);
    addDebugLog(isMuted ? "🔊 Unmuted" : "🔇 Muted");
  };

  const stopUA = async () => {
    try {
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
      }
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
      }
      if (uaRef.current) {
        await uaRef.current.stop();
      }
      if (audioContextRef.current) {
        await audioContextRef.current.close();
      }
    } catch (error) {
      addDebugLog(`❌ Error stopping UA: ${error.message}`);
    }
    uaRef.current = null;
    regRef.current = null;
    audioContextRef.current = null;
    gainNodeRef.current = null;
  };

  const forceAudioPlay = async () => {
    try {
      await initializeAudioContext();
      
      if (remoteAudioRef.current) {
        remoteAudioRef.current.volume = 1.0;
        remoteAudioRef.current.muted = false;
        
        await remoteAudioRef.current.play();
        addDebugLog("✅ Manual audio play successful");
      }
      
      // Also retry audio setup if we have an active call
      if (active) {
        checkAndSetupAudio(active);
      }
    } catch (err) {
      addDebugLog(`❌ Manual audio play failed: ${err.message}`);
    }
  };

  const testLocalAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audio = new Audio();
      audio.srcObject = stream;
      await audio.play();
      addDebugLog("✅ Local audio test successful");
      
      // Stop the test stream
      stream.getTracks().forEach(track => track.stop());
    } catch (err) {
      addDebugLog(`❌ Local audio test failed: ${err.message}`);
    }
  };

  return (
    <div className="max-w-4xl mx-auto bg-white shadow-lg rounded-lg p-6 m-4">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-green-600 mb-2">📞  SIP Client</h2>
        <div className={`inline-block px-4 py-2 rounded-full text-sm font-medium ${
          status === "Registered" ? "bg-green-100 text-green-800" :
          status === "Connected" || status === "In call" ? "bg-blue-100 text-blue-800" :
          status.includes("call") ? "bg-yellow-100 text-yellow-800" :
          status.includes("failed") || status.includes("cancelled") ? "bg-red-100 text-red-800" :
          "bg-gray-100 text-gray-800"
        }`}>
          Status: {status}
        </div>
      </div>

      {/* Error Display */}
      {lastError && (
        <div className={`mx-4 mb-6 p-4 rounded-lg border-l-4 ${
          lastError.type === 'whatsapp_limit' ? 'bg-orange-50 border-orange-400' :
          lastError.type === 'forbidden' ? 'bg-red-50 border-red-400' :
          lastError.type === 'busy' ? 'bg-yellow-50 border-yellow-400' :
          lastError.type === 'unavailable' ? 'bg-blue-50 border-blue-400' :
          'bg-red-50 border-red-400'
        }`}>
          <div className="flex justify-between items-start">
            <div className="flex-1">
              <h3 className={`font-medium ${
                lastError.type === 'whatsapp_limit' ? 'text-orange-800' :
                lastError.type === 'forbidden' ? 'text-red-800' :
                lastError.type === 'busy' ? 'text-yellow-800' :
                lastError.type === 'unavailable' ? 'text-blue-800' :
                'text-red-800'
              }`}>
                {lastError.type === 'whatsapp_limit' ? '📊' : 
                 lastError.type === 'busy' ? '📞' :
                 lastError.type === 'unavailable' ? '⏰' :
                 '❌'} {lastError.title}
              </h3>
              <p className={`mt-1 text-sm ${
                lastError.type === 'whatsapp_limit' ? 'text-orange-700' :
                lastError.type === 'forbidden' ? 'text-red-700' :
                lastError.type === 'busy' ? 'text-yellow-700' :
                lastError.type === 'unavailable' ? 'text-blue-700' :
                'text-red-700'
              }`}>
                {lastError.message}
              </p>
              
              {lastError.type === 'whatsapp_limit' && lastError.nextAllowedTime && (
                <div className="mt-2">
                  <p className="text-sm text-orange-600">
                    <strong>Daily Limit:</strong> {lastError.limit} calls
                  </p>
                  <p className="text-sm text-orange-600">
                    <strong>Reset Time:</strong> {lastError.nextAllowedTime.toLocaleString()}
                  </p>
                  <p className="text-xs text-orange-500 mt-1">
                    Time until reset: {Math.ceil((lastError.nextAllowedTime.getTime() - Date.now()) / (1000 * 60 * 60))} hours
                  </p>
                </div>
              )}
              
              {lastError.statusCode && (
                <p className="text-xs text-gray-500 mt-1">
                  SIP Code: {lastError.statusCode} - {lastError.reasonPhrase}
                </p>
              )}
              
              <p className="text-xs text-gray-400 mt-1">
                {lastError.timestamp}
              </p>
            </div>
            
            <button
              onClick={() => setLastError(null)}
              className="ml-4 text-gray-400 hover:text-gray-600"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Main Controls */}
        <div className="space-y-4">
          {status === "Disconnected" && (
            <button 
              onClick={connectAndRegister}
              className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg transition-colors"
            >
              🔗 Connect & Register
            </button>
          )}

          {status === "Registered" && (
            <div className="bg-gray-50 p-4 rounded-lg">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                📱 Phone Number (for WhatsApp)
              </label>
              <div className="flex space-x-2">
                <input
                  type="tel"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  placeholder="1234567890"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                  disabled={isConnecting}
                />
                <button
                  onClick={makeOutboundCall}
                  className={`bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-md transition-colors ${isConnecting ? 'opacity-60 cursor-not-allowed' : ''}`}
                  disabled={isConnecting}
                >
                  {isConnecting ? '⏳ Calling...' : '📞 Call'}
                </button>
              </div>
            </div>
          )}

          {incoming && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <p className="text-blue-800 font-medium mb-3">📞 Incoming Call...</p>
              <div className="flex space-x-2">
                <button 
                  onClick={acceptCall}
                  className={`flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded transition-colors ${isConnecting ? 'opacity-60 cursor-not-allowed' : ''}`}
                  disabled={isConnecting}
                >
                  {isConnecting ? '⏳ Connecting...' : '✅ Accept'}
                </button>
                <button 
                  onClick={() => {
                    incoming.reject();
                    setIncoming(null);
                  }}
                  className="flex-1 bg-red-500 hover:bg-red-600 text-white font-bold py-2 px-4 rounded transition-colors"
                >
                  ❌ Decline
                </button>
              </div>
            </div>
          )}

          {active && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex justify-between items-center mb-3">
                <span className="text-green-800 font-medium">🎯 Active Call</span>
                <span className="text-green-600 font-mono text-lg">{callDuration}</span>
              </div>
              
              <div className="grid grid-cols-2 gap-2 mb-4">
                <button 
                  onClick={toggleMute}
                  className={`py-2 px-3 rounded text-sm font-medium transition-colors ${
                    isMuted 
                      ? "bg-red-100 text-red-800 hover:bg-red-200" 
                      : "bg-gray-100 text-gray-800 hover:bg-gray-200"
                  }`}
                >
                  {isMuted ? "🔇 Muted" : "🎤 Mute"}
                </button>
                
                <button 
                  onClick={hangup}
                  className="bg-red-500 hover:bg-red-600 text-white py-2 px-3 rounded text-sm font-medium transition-colors"
                >
                  📞 Hang Up
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 mb-2">
                <button
                  onClick={forceAudioPlay}
                  className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-3 rounded text-sm transition-colors"
                >
                  🔊 Force Audio
                </button>
                <button
                  onClick={() => checkAndSetupAudio(active)}
                  className="bg-purple-500 hover:bg-purple-600 text-white py-2 px-3 rounded text-sm transition-colors"
                >
                  🔧 Retry Audio
                </button>
              </div>
              
              <button
                onClick={testLocalAudio}
                className="w-full bg-gray-500 hover:bg-gray-600 text-white py-2 px-3 rounded text-sm transition-colors"
              >
                🎤 Test Mic
              </button>
            </div>
          )}

          {/* Audio Element */}
          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-gray-700 mb-2">🎵 Remote Audio</h3>
            <audio 
              ref={remoteAudioRef} 
              autoPlay 
              playsInline 
              controls
              className="w-full mb-2"
              onPlaying={() => addDebugLog("🔊 Remote audio is playing")}
              onPause={() => addDebugLog("⏸️ Remote audio paused")}
              onError={(e) => addDebugLog(`❌ Audio error: ${e.target?.error?.message || 'Unknown'}`)}
              onLoadedMetadata={() => addDebugLog("📊 Audio metadata loaded")}
              onCanPlay={() => addDebugLog("🔊 Audio can play")}
            />
            <div className="text-xs text-gray-500">
              Volume: {remoteAudioRef.current?.volume?.toFixed(2) || 0} | 
              Muted: {remoteAudioRef.current?.muted ? 'Yes' : 'No'} |
              Ready State: {remoteAudioRef.current?.readyState || 0} |
              Current Time: {remoteAudioRef.current?.currentTime?.toFixed(2) || 0}
            </div>
          </div>
        </div>

        {/* Debug Panel */}
        <div className="space-y-4">
          {/* Call Error History */}
          {callErrors.length > 0 && (
            <div className="bg-red-50 p-4 rounded-lg">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-medium text-red-800">🚨 Recent Call Errors</h3>
                <button
                  onClick={() => setCallErrors([])}
                  className="text-xs text-red-600 hover:text-red-800"
                >
                  Clear
                </button>
              </div>
              <div className="space-y-2 max-h-32 overflow-y-auto">
                {callErrors.map((error, index) => (
                  <div key={index} className="text-xs bg-white p-2 rounded border border-red-200">
                    <div className="font-medium text-red-800">{error.title}</div>
                    <div className="text-red-600 truncate">{error.message}</div>
                    <div className="text-gray-500 text-xs mt-1">{error.timestamp}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RTP Stats */}
          {Object.keys(rtpStats).length > 0 && (
            <div className="bg-blue-50 p-4 rounded-lg">
              <h3 className="text-sm font-medium text-blue-800 mb-2">📊 RTP Statistics</h3>
              <div className="text-xs space-y-1">
                {rtpStats.inbound && (
                  <div>
                    <strong>Inbound:</strong> Packets: {rtpStats.inbound.packetsReceived || 0}, 
                    Lost: {rtpStats.inbound.packetsLost || 0}, 
                    Jitter: {rtpStats.inbound.jitter?.toFixed(3) || 0}ms,
                    Level: {rtpStats.inbound.audioLevel?.toFixed(3) || 0}
                  </div>
                )}
                {rtpStats.outbound && (
                  <div>
                    <strong>Outbound:</strong> Packets: {rtpStats.outbound.packetsSent || 0}, 
                    Bytes: {rtpStats.outbound.bytesSent || 0}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Debug Logs */}
          {/* <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-gray-700 mb-2">🐛 Debug Log</h3>
            <div className="bg-black text-green-400 p-3 rounded text-xs font-mono h-64 overflow-y-auto">
              {audioDebugInfo.map((log, index) => (
                <div key={index} className={log.includes('✅') ? 'text-green-400' : 
                  log.includes('❌') ? 'text-red-400' : 
                  log.includes('⚠️') ? 'text-yellow-400' : 
                  log.includes('📞') ? 'text-blue-400' : 'text-green-400'}
                >
                  {log}
                </div>
              ))}
            </div>
            <button
              onClick={() => setAudioDebugInfo([])}
              className="mt-2 text-xs bg-gray-500 hover:bg-gray-600 text-white px-2 py-1 rounded"
            >
              Clear Logs
            </button>
          </div> */}

          {/* Quick Audio Fixes */}
          {/* <div className="bg-orange-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-orange-800 mb-2">🚨 Quick Audio Fixes</h3>
            <div className="space-y-2 text-xs">
              <div className="mb-2 text-orange-700">If you can't hear audio on outbound calls:</div>
              <button
                onClick={() => {
                  if (active) {
                    addDebugLog("🔧 Emergency audio retry initiated");
                    // Multiple immediate retries with different delays
                    setTimeout(() => checkAndSetupAudio(active), 100);
                    setTimeout(() => checkAndSetupAudio(active), 500);
                    setTimeout(() => checkAndSetupAudio(active), 1000);
                    setTimeout(() => forceAudioPlay(), 1200);
                  }
                }}
                className="w-full bg-orange-500 hover:bg-orange-600 text-white py-2 px-3 rounded text-xs mb-2"
                disabled={!active}
              >
                🚨 Emergency Audio Fix
              </button>
              
              <button
                onClick={async () => {
                  try {
                    if (audioContextRef.current) {
                      await audioContextRef.current.close();
                      audioContextRef.current = null;
                      gainNodeRef.current = null;
                    }
                    await initializeAudioContext();
                    addDebugLog("🔄 Audio context reset complete");
                    
                    if (active) {
                      setTimeout(() => checkAndSetupAudio(active), 500);
                    }
                  } catch (err) {
                    addDebugLog(`❌ Audio context reset failed: ${err.message}`);
                  }
                }}
                className="w-full bg-red-500 hover:bg-red-600 text-white py-2 px-3 rounded text-xs"
              >
                🔄 Reset Audio Context
              </button>
            </div>
          </div> */}

          {/* System Info */}
          {/* <div className="bg-yellow-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-yellow-800 mb-2">ℹ️ System Info</h3>
            <div className="text-xs space-y-1 text-yellow-700">
              <div>WebRTC Endpoint: 919538099928@sipserver.kapturecrm.com</div>
              <div>WhatsApp Target: +{phoneNumber.replace(/[^\d]/g, '')}@wa.meta.vc</div>
              <div>Local Stream: {localStreamRef.current ? "✅ Active" : "❌ None"}</div>
              <div>Audio Context: {audioContextRef.current ? 
                `✅ ${audioContextRef.current.state}` : "❌ None"}</div>
              <div>Remote Audio Ready: {remoteAudioRef.current?.readyState || 0}/4</div>
              <div>Browser: {navigator.userAgent.includes('Chrome') ? 'Chrome' : 
                navigator.userAgent.includes('Firefox') ? 'Firefox' : 
                navigator.userAgent.includes('Safari') ? 'Safari' : 'Other'}</div>
              <div>Secure Context: {window.isSecureContext ? '✅ Yes' : '❌ No'}</div>
            </div>
          </div> */}

          {/* Audio Troubleshooting */}
          {/* <div className="bg-purple-50 p-4 rounded-lg">
            <h3 className="text-sm font-medium text-purple-800 mb-2">🔧 Audio Troubleshooting</h3>
            <div className="space-y-2">
              <button
                onClick={() => {
                  if (remoteAudioRef.current) {
                    const currentVol = remoteAudioRef.current.volume;
                    remoteAudioRef.current.volume = Math.min(1.0, currentVol + 0.2);
                    addDebugLog(`🔊 Volume boosted to ${remoteAudioRef.current.volume.toFixed(2)}`);
                  }
                }}
                className="w-full bg-green-500 hover:bg-green-600 text-white py-1 px-2 rounded text-xs"
              >
                🔊 Volume Up (+20%)
              </button>
              
              <button
                onClick={() => {
                  if (remoteAudioRef.current && remoteAudioRef.current.srcObject) {
                    const stream = remoteAudioRef.current.srcObject;
                    addDebugLog(`🔍 Current stream has ${stream.getTracks().length} tracks`);
                    
                    stream.getTracks().forEach((track, index) => {
                      addDebugLog(`Track ${index}: ${track.kind}, enabled: ${track.enabled}, muted: ${track.muted}, readyState: ${track.readyState}`);
                    });
                    
                    // Force refresh the stream
                    remoteAudioRef.current.load();
                    remoteAudioRef.current.play().catch(err => 
                      addDebugLog(`❌ Stream refresh play failed: ${err.message}`)
                    );
                  } else {
                    addDebugLog("❌ No stream to inspect");
                  }
                }}
                className="w-full bg-blue-500 hover:bg-blue-600 text-white py-1 px-2 rounded text-xs"
              >
                🔍 Inspect Current Stream
              </button>

              <button
                onClick={() => {
                  if (active) {
                    const sdh = active.sessionDescriptionHandler;
                    if (sdh?.peerConnection) {
                      const pc = sdh.peerConnection;
                      
                      addDebugLog("🔍 === DEEP AUDIO INSPECTION ===");
                      addDebugLog(`PC State: ${pc.connectionState}, ICE: ${pc.iceConnectionState}, Signaling: ${pc.signalingState}`);
                      
                      // Check senders (our outbound audio)
                      const senders = pc.getSenders();
                      addDebugLog(`Found ${senders.length} senders:`);
                      senders.forEach((sender, index) => {
                        if (sender.track) {
                          addDebugLog(`Sender ${index}: ${sender.track.kind}, enabled: ${sender.track.enabled}, muted: ${sender.track.muted}`);
                        }
                      });
                      
                      // Check receivers (their inbound audio)  
                      const receivers = pc.getReceivers();
                      addDebugLog(`Found ${receivers.length} receivers:`);
                      receivers.forEach((receiver, index) => {
                        if (receiver.track) {
                          addDebugLog(`Receiver ${index}: ${receiver.track.kind}, enabled: ${receiver.track.enabled}, muted: ${receiver.track.muted}, readyState: ${receiver.track.readyState}`);
                          
                          // Try to create a fresh stream from this track
                          if (receiver.track.kind === 'audio' && receiver.track.readyState === 'live') {
                            const freshStream = new MediaStream([receiver.track]);
                            addDebugLog(`🔄 Creating fresh stream from receiver ${index}`);
                            
                            if (remoteAudioRef.current) {
                              remoteAudioRef.current.srcObject = freshStream;
                              remoteAudioRef.current.play().catch(err => 
                                addDebugLog(`❌ Fresh stream play failed: ${err.message}`)
                              );
                            }
                          }
                        }
                      });
                      
                      addDebugLog("🔍 === END DEEP INSPECTION ===");
                    } else {
                      addDebugLog("❌ No peer connection available for deep inspection");
                    }
                  }
                }}
                className="w-full bg-indigo-500 hover:bg-indigo-600 text-white py-1 px-2 rounded text-xs"
                disabled={!active}
              >
                🔬 Deep Audio Inspection
              </button>
            </div>
          </div> */}

          {/* Browser-specific Tips */}
          <div className="bg-indigo-50 p-4 rounded-lg">
            {/* <h3 className="text-sm font-medium text-indigo-800 mb-2">💡 Browser Tips</h3> */}
            {/* <div className="text-xs text-indigo-700 space-y-1">
              <div><strong>Chrome/Edge:</strong> Check site permissions for microphone/sound</div>
              <div><strong>Firefox:</strong> May need manual play button click</div>
              <div><strong>Safari:</strong> Requires user interaction for audio</div>
              <div><strong>All browsers:</strong> Ensure audio isn't blocked by browser policy</div>
              {!window.isSecureContext && (
                <div className="text-red-600 font-bold">⚠️ Non-secure context may cause audio issues!</div>
              )}
            </div> */}
          </div>
        </div>
      </div>

      {/* User Interaction Prompt */}
      {/* {active && (
        <div className="mt-6 text-center">
          <div className="inline-block bg-blue-100 border border-blue-300 rounded-lg p-3">
            <div className="text-blue-800 text-sm">
              👆 <strong>Audio not working?</strong> Click anywhere or use the "Force Audio" button above.
              Some browsers require user interaction to play audio.
            </div>
          </div>
        </div>
      )} */}
    </div>
  );
}
