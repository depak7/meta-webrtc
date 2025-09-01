import React, { useEffect, useRef, useState } from "react";
import { UserAgent, Registerer, URI, Invitation, SessionState } from "sip.js";

export default function SipClient() {
  const [status, setStatus] = useState("Disconnected");
  const [incoming, setIncoming] = useState(null);
  const [active, setActive] = useState(null);

  const uaRef = useRef(null);
  const regRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);

  useEffect(() => {
    return () => {
      hangup();
      stopUA();
    };
    // eslint-disable-next-line
  }, []);

  const connectAndRegister = async () => {
    try {
      localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert("Mic access denied");
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
        peerConnectionConfiguration: {   // ✅ not peerConnectionOptions
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        }
      },
    });
    
    ua.delegate = {
      onInvite: (inv) => {
        console.log("Incoming call");
        setIncoming(inv);
        setStatus("Incoming call");
      },
    };

    await ua.start();
    uaRef.current = ua;

    const reg = new Registerer(ua);
    await reg.register();
    regRef.current = reg;

    setStatus("Registered");
  };

  const acceptCall = async () => {
    if (!incoming) return;

    await incoming.accept({
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
        offerOptions: { offerToReceiveAudio: true },  // 🔑 force receiving audio
        streams: [localStreamRef.current],
      },
    });

    const sdh = incoming.sessionDescriptionHandler;
    if (!sdh) {
      console.error("No sessionDescriptionHandler available");
      return;
    }

    const pc = sdh.peerConnection;

    // Attach remote audio
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.play().catch((err) =>
          console.warn("Autoplay blocked:", err)
        );
      }
    };

    // Attach local audio (mic) tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) =>
        pc.addTrack(t, localStreamRef.current)
      );
    }

    incoming.stateChange.addListener((state) => {
      console.log("Session state:", state);
      if (state === SessionState.Established) {
        const pc = incoming.sessionDescriptionHandler.peerConnection;
        pc.getReceivers().forEach((receiver) => {
          if (receiver.track && receiver.track.kind === "audio") {
            const remoteStream = new MediaStream([receiver.track]);
            if (remoteAudioRef.current) {
              remoteAudioRef.current.srcObject = remoteStream;
              remoteAudioRef.current.play().catch((err) =>
                console.warn("Autoplay blocked:", err)
              );
            }
          }
        });
      }
      if (state === SessionState.Terminated) {
        setActive(null);
        setStatus("Ready");
      }
    });

    setActive(incoming);
    setIncoming(null);
    setStatus("In call");
  };

  const hangup = async () => {
    if (!active) return;
    try {
      await active.dispose();
    } catch {}
    setActive(null);
    setStatus("Ready");
  };

  const stopUA = async () => {
    try {
      if (uaRef.current) await uaRef.current.stop();
    } catch {}
    uaRef.current = null;
  };

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif", maxWidth: 400 }}>
      <h3>SIP WebRTC Client</h3>
      <p>Status: {status}</p>

      {status === "Disconnected" && (
        <button onClick={connectAndRegister}>Connect & Register</button>
      )}

      {incoming && (
        <div>
          <p>Incoming Call...</p>
          <button onClick={acceptCall}>Accept</button>
          <button onClick={() => setIncoming(null)}>Decline</button>
        </div>
      )}

      {active && (
        <div>
          <button onClick={hangup}>Hangup</button>
        </div>
      )}

      {/* Hidden audio element for remote stream */}
      <audio ref={remoteAudioRef} autoPlay playsInline />
    </div>
  );
}
