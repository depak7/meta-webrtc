import React, { useEffect, useRef, useState } from "react";

export default function WhatsAppCaller() {
  const [status, setStatus] = useState("Disconnected");
  const [phoneNumber, setPhoneNumber] = useState("919751577309");
  const [callState, setCallState] = useState(null); // RINGING, ACCEPTED, REJECTED
  const [whatsappCallId, setWhatsappCallId] = useState(null);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const wsRef = useRef(null);

  const BACKEND_URL = "https://webhook-service-meta.onrender.com";

  useEffect(() => {
    initializeWebSocket();
    return cleanup;
  }, []);

  // WebSocket for real-time events
  const initializeWebSocket = () => {
    try {
      wsRef.current = new WebSocket("ws://webhook-service-meta.onrender.com:8080");
      wsRef.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebhookEvent(data);
      };
    } catch {
      console.log("WebSocket unavailable, use polling instead");
    }
  };

  const handleWebhookEvent = async (data) => {
    if (data.type === "call_connect" && data.sdp) {
      await peerConnectionRef.current?.setRemoteDescription({ type: "answer", sdp: data.sdp });
      setStatus("✅ Audio connected");
      setCallState("ACCEPTED");
    }

    if (data.type === "call_terminate") {
      cleanup();
      setStatus("Call ended");
    }

    if (data.type === "call_status") setCallState(data.status);
  };

  // Initialize WebRTC
  const initializeWebRTC = async () => {
    localStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    peerConnectionRef.current = pc;

    localStreamRef.current.getTracks().forEach(track => pc.addTrack(track, localStreamRef.current));
    pc.ontrack = (event) => {
      remoteAudioRef.current.srcObject = event.streams[0];
      remoteAudioRef.current.play().catch(() => {});
    };
  };

  const makeWhatsAppCall = async () => {
    if (!phoneNumber.trim()) return alert("Enter phone number");

    setStatus("🎤 Initializing WebRTC...");
    await initializeWebRTC();

    const offer = await peerConnectionRef.current.createOffer({ offerToReceiveAudio: true });
    await peerConnectionRef.current.setLocalDescription(offer);

    setStatus("📞 Calling WhatsApp...");
    const response = await fetch(`${BACKEND_URL}/api/make-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: phoneNumber, sdp_offer: offer.sdp })
    });
    const data = await response.json();
    if (data.success) {
      setWhatsappCallId(data.call_id);
      setCallState("RINGING");
      setStatus("Ringing...");
    } else {
      setStatus("Call failed");
      alert(data.error);
    }
  };

  const hangup = async () => {
    if (!whatsappCallId) return;
    await fetch(`${BACKEND_URL}/api/terminate-call`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ call_id: whatsappCallId }) });
    cleanup();
  };

  const cleanup = () => {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setWhatsappCallId(null);
    setCallState(null);
  };

  return (
    <div className="p-6 max-w-md mx-auto bg-white shadow-lg rounded-lg">
      <h2 className="text-2xl font-bold mb-4">💬 WhatsApp Caller</h2>

      <input type="tel" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="919751577309" className="border p-2 w-full mb-2" />
      <button onClick={makeWhatsAppCall} className="bg-green-500 text-white px-4 py-2 rounded w-full mb-2">📞 Call</button>
      {whatsappCallId && <button onClick={hangup} className="bg-red-500 text-white px-4 py-2 rounded w-full mb-2">❌ Hangup</button>}

      <div className="mb-2">Status: {status}</div>
      <div className="mb-2">Call State: {callState}</div>

      <audio ref={remoteAudioRef} autoPlay playsInline controls className="w-full mt-2" />
    </div>
  );
}
