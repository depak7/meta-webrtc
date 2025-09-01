import React, { useEffect, useRef, useState } from "react";
import { UserAgent, Registerer, URI, Invitation, SessionState, Inviter } from "sip.js";

export default function SipClient() {
  const [status, setStatus] = useState("Disconnected");
  const [incoming, setIncoming] = useState(null);
  const [active, setActive] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState("919751577309");
  const [isMuted, setIsMuted] = useState(false);
  const [callDuration, setCallDuration] = useState("00:00");

  const uaRef = useRef(null);
  const regRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const callStartTimeRef = useRef(null);
  const callTimerRef = useRef(null);

  useEffect(() => {
    return () => {
      hangup();
      stopUA();
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

  const connectAndRegister = async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1
        } 
      });
      console.log("✅ Microphone access granted", localStreamRef.current);
      localStreamRef.current.getAudioTracks().forEach(track => {
        console.log("Local track:", {
          kind: track.kind,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState
        });
      });
    } catch (e) {
      console.error("❌ Mic access denied:", e);
      alert("Microphone access is required for voice calls");
      return;
    }

    const ua = new UserAgent({
      uri: new URI("sip", "7003", "sipserver.kapturecrm.com"),
      authorizationUsername: "7003",
      authorizationPassword: "StrongPass7003",
      transportOptions: {
        server: "wss://sipserver.kapturecrm.com:8089/ws",
      },
      sessionDescriptionHandlerFactoryOptions: {
        constraints: { audio: true, video: false },
        peerConnectionConfiguration: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            // Add TURN server (replace with your TURN server credentials)
            // { urls: "turn:turn.example.com:3478", username: "user", credential: "pass" }
          ],
          iceCandidatePoolSize: 10
        }
      },
    });
    
    ua.delegate = {
      onInvite: (inv) => {
        console.log("📞 Incoming call from:", inv.remoteIdentity);
        setIncoming(inv);
        setStatus("Incoming call");
      },
    };

    await ua.start();
    uaRef.current = ua;
    console.log("✅ SIP UA started");

    const reg = new Registerer(ua);
    await reg.register();
    regRef.current = reg;
    console.log("✅ SIP Registration successful");

    setStatus("Registered");
  };

  const setupAudioHandling = (session) => {
    const sdh = session.sessionDescriptionHandler;
    if (!sdh) {
      console.error("❌ No sessionDescriptionHandler available");
      return;
    }

    const pc = sdh.peerConnection;
    console.log("🔗 Setting up audio handling for peer connection:", pc);
    if (!pc.getReceivers().length) {
      console.error("❌ No receivers found in PeerConnection");
    }

    pc.ontrack = (event) => {
      console.log("🎵 Remote track received:", event);
      const [remoteStream] = event.streams;
      console.log("🔊 Remote stream:", remoteStream, "Tracks:", remoteStream.getTracks());
      remoteStream.getTracks().forEach(track => {
        console.log("Track details:", {
          kind: track.kind,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
          id: track.id
        });
      });
      if (remoteStream && remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.oncanplay = () => console.log("🔊 Audio element can play");
        remoteAudioRef.current.onplaying = () => console.log("🔊 Audio element playing");
        remoteAudioRef.current.onpause = () => console.log("⏸️ Audio element paused");
        remoteAudioRef.current.onerror = (e) => console.error("❌ Audio element error:", e);
        remoteAudioRef.current.play()
          .then(() => console.log("✅ Remote audio playing"))
          .catch(err => {
            console.error("❌ Audio playback error:", err);
            alert("Please click to enable audio");
            document.addEventListener('click', () => {
              remoteAudioRef.current.play().catch(console.error);
            }, { once: true });
          });
      }
    };

    pc.onicecandidate = (event) => {
      console.log("🧊 ICE candidate:", event.candidate);
    };

    pc.oniceconnectionstatechange = () => {
      console.log("🧊 ICE Connection State:", pc.iceConnectionState);
    };

    pc.onconnectionstatechange = () => {
      console.log("🔗 Connection State:", pc.connectionState);
    };

    if (localStreamRef.current) {
      console.log("🎤 Adding local stream to peer connection");
      localStreamRef.current.getTracks().forEach(track => {
        console.log("Adding track:", track.kind, track.label);
        pc.addTrack(track, localStreamRef.current);
      });
    }

    const statsInterval = setInterval(async () => {
      if (pc.connectionState === 'connected') {
        try {
          const stats = await pc.getStats();
          stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'audio') {
              console.log("📊 Inbound RTP Stats:", {
                packetsReceived: report.packetsReceived,
                bytesReceived: report.bytesReceived,
                audioLevel: report.audioLevel,
                jitter: report.jitter,
                packetsLost: report.packetsLost
              });
            }
          });
        } catch (err) {
          console.error("Stats error:", err);
        }
      }
    }, 2000); // Reduced interval for faster feedback

    session.stateChange.addListener((state) => {
      if (state === SessionState.Terminated) {
        clearInterval(statsInterval);
      }
    });
  };

  const acceptCall = async () => {
    if (!incoming) return;

    console.log("📞 Accepting incoming call");

    try {
      await incoming.accept({
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
          offerOptions: { offerToReceiveAudio: true, offerToReceiveVideo: false },
          streams: [localStreamRef.current],
          onCreateOffer: (offer) => {
            offer.sdp = offer.sdp.replace(/m=audio ([0-9]+) UDP\/TLS\/RTP\/SAVPF .*/, 'm=audio $1 UDP/TLS/RTP/SAVPF 0 8 101');
            offer.sdp += '\na=rtpmap:0 PCMU/8000\na=rtpmap:8 PCMA/8000\na=rtpmap:101 telephone-event/8000';
            return offer;
          }
        },
      });

      console.log("✅ Call accepted, setting up audio handling");
      setupAudioHandling(incoming);

      incoming.stateChange.addListener((state) => {
        console.log("📞 Session state changed:", state);
        
        if (state === SessionState.Established) {
          console.log("🎯 Call established - ensuring audio is connected");
          console.log("Local SDP:", incoming.sessionDescriptionHandler.localDescription);
          console.log("Remote SDP:", incoming.sessionDescriptionHandler.remoteDescription);
          setStatus("Connected");
          
          setTimeout(() => {
            const sdh = incoming.sessionDescriptionHandler;
            if (sdh && sdh.peerConnection) {
              const pc = sdh.peerConnection;
              pc.getReceivers().forEach((receiver) => {
                if (receiver.track && receiver.track.kind === "audio") {
                  console.log("🔊 Found audio receiver track:", receiver.track);
                  const remoteStream = new MediaStream([receiver.track]);
                  if (remoteAudioRef.current) {
                    remoteAudioRef.current.srcObject = remoteStream;
                    remoteAudioRef.current.play().catch(console.warn);
                  }
                }
              });
            }
          }, 1000);
        }
        
        if (state === SessionState.Terminated) {
          console.log("📞 Call terminated");
          setActive(null);
          setIncoming(null);
          setStatus("Registered");
        }
      });

      setActive(incoming);
      setIncoming(null);
      setStatus("In call");

    } catch (error) {
      console.error("❌ Error accepting call:", error);
      setStatus("Call failed");
    }
  };

  const makeOutboundCall = async () => {
    if (!phoneNumber.trim()) {
      alert("Please enter a phone number");
      return;
    }

    if (!uaRef.current) {
      alert("Not connected to SIP server");
      return;
    }

    try {
      console.log("📞 Making outbound call to:", phoneNumber);
      const target = `sip:+${phoneNumber.replace(/[^\d]/g, '')}@wa.meta.vc`;
      console.log("🎯 Target URI:", target);

      const inviter = new Inviter(uaRef.current, new URI("sip", `+${phoneNumber.replace(/[^\d]/g, '')}`, "wa.meta.vc"), {
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
          offerOptions: { offerToReceiveAudio: true, offerToReceiveVideo: false },
          streams: [localStreamRef.current],
          onCreateOffer: (offer) => {
            // Replace existing Opus payload types with 111 and map attributes properly
            offer.sdp = offer.sdp.replace(/a=rtpmap:\d+ opus\/48000\/2/g, 'a=rtpmap:111 opus/48000/2');
            offer.sdp = offer.sdp.replace(/m=audio ([0-9]+) UDP\/TLS\/RTP\/SAVPF [0-9 ]+/g, 'm=audio $1 UDP/TLS/RTP/SAVPF 111 0 8 101');
            offer.sdp += '\na=fmtp:111 maxaveragebitrate=20000;maxplaybackrate=16000;minptime=20;sprop-maxcapturerate=16000;useinbandfec=1';
            offer.sdp += '\na=rtpmap:0 PCMU/8000\na=rtpmap:8 PCMA/8000\na=rtpmap:101 telephone-event/8000';
            return offer;
          }
          
        },
      });

      inviter.stateChange.addListener((state) => {
        console.log("📞 Outbound call state:", state);
        if (state === SessionState.Establishing) {
          setStatus("Calling...");
        } else if (state === SessionState.Established) {
          setStatus("Connected");
          setupAudioHandling(inviter);
        } else if (state === SessionState.Terminated) {
          setActive(null);
          setStatus("Registered");
        }
      });

      await inviter.invite();
      setActive(inviter);
      console.log("✅ Outbound call initiated");

    } catch (error) {
      console.error("❌ Error making outbound call:", error);
      setStatus("Call failed");
      alert("Failed to make call: " + error.message);
    }
  };

  const hangup = async () => {
    if (!active) return;
  
    console.log("📞 Hanging up call");
    try {
      if (active.state === SIP.SessionState.Established) {
        await active.bye();   // <-- this actually sends SIP BYE
      } else {
        await active.cancel(); // if it’s still ringing
      }
    } catch (error) {
      console.error("Error hanging up:", error);
    }
  
    setActive(null);
    setIncoming(null);
    setStatus("Registered");
  };
  const toggleMute = () => {
    if (!active || !localStreamRef.current) return;

    const audioTracks = localStreamRef.current.getAudioTracks();
    audioTracks.forEach(track => {
      track.enabled = isMuted;
    });
    
    setIsMuted(!isMuted);
    console.log(isMuted ? "🔊 Unmuted" : "🔇 Muted");
  };

  const stopUA = async () => {
    try {
      if (callTimerRef.current) {
        clearInterval(callTimerRef.current);
      }
      if (uaRef.current) {
        await uaRef.current.stop();
      }
    } catch (error) {
      console.error("Error stopping UA:", error);
    }
    uaRef.current = null;
    regRef.current = null;
  };

  const testLocalAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audio = new Audio();
      audio.srcObject = stream;
      audio.play()
        .then(() => console.log("✅ Local audio test successful"))
        .catch(err => console.error("❌ Local audio test failed:", err));
    } catch (err) {
      console.error("❌ Microphone access error:", err);
    }
  };

  return (
    <div className="max-w-md mx-auto bg-white shadow-lg rounded-lg p-6 m-4">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-bold text-green-600 mb-2">📞 WhatsApp SIP Client</h2>
        <div className={`inline-block px-4 py-2 rounded-full text-sm font-medium ${
          status === "Registered" ? "bg-green-100 text-green-800" :
          status === "Connected" ? "bg-blue-100 text-blue-800" :
          status.includes("call") ? "bg-yellow-100 text-yellow-800" :
          "bg-gray-100 text-gray-800"
        }`}>
          Status: {status}
        </div>
      </div>

      {status === "Disconnected" && (
        <button 
          onClick={connectAndRegister}
          className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-4 rounded-lg transition-colors"
        >
          🔗 Connect & Register
        </button>
      )}

      {status === "Registered" && (
        <div className="space-y-4">
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
              />
              <button
                onClick={makeOutboundCall}
                className="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded-md transition-colors"
              >
                📞 Call
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Enter number without + (e.g., 1234567890 for +1234567890)
            </p>
          </div>
        </div>
      )}

      {incoming && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
          <p className="text-blue-800 font-medium mb-3">📞 Incoming Call...</p>
          <div className="flex space-x-2">
            <button 
              onClick={acceptCall}
              className="flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-2 px-4 rounded transition-colors"
            >
              ✅ Accept
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
        <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
          <div className="flex justify-between items-center mb-3">
            <span className="text-green-800 font-medium">🎯 Active Call</span>
            <span className="text-green-600 font-mono text-lg">{callDuration}</span>
          </div>
          
          <div className="grid grid-cols-3 gap-2">
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
            
            <div className="flex items-center justify-center text-sm text-gray-600">
              🎵 Audio
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <button
              onClick={() => {
                if (remoteAudioRef.current) {
                  remoteAudioRef.current.play()
                    .then(() => console.log("✅ Manual audio playback started"))
                    .catch(err => console.error("❌ Manual playback error:", err));
                }
              }}
              className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded"
            >
              🔊 Test Audio Playback
            </button>
            <button
              onClick={testLocalAudio}
              className="bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded"
            >
              🔊 Test Local Audio
            </button>
          </div>
        </div>
      )}

      {/* Audio Controls */}
      <div className="mt-6 p-4 bg-gray-50 rounded-lg">
        <h3 className="text-sm font-medium text-gray-700 mb-2">🎵 Audio Debug</h3>
        <audio 
          ref={remoteAudioRef} 
          autoPlay 
          playsInline 
          controls
          className="w-full mb-2"
          onPlaying={() => console.log("🔊 Remote audio is playing")}
          onPause={() => console.log("⏸️ Remote audio paused")}
          onError={(e) => console.error("❌ Audio error:", e)}
        />
        <p className="text-xs text-gray-500">
          Remote audio stream will appear here when call is active
        </p>
      </div>

      {/* Debug Info */}
      <div className="mt-4 p-3 bg-gray-100 rounded text-xs text-gray-600">
        <div>WebRTC Endpoint: 7003@sipserver.kapturecrm.com</div>
        <div>WhatsApp Target: +{phoneNumber.replace(/[^\d]/g, '')}@wa.meta.vc</div>
        <div>Local Stream: {localStreamRef.current ? "✅ Active" : "❌ None"}</div>
      </div>
    </div>
  );
}