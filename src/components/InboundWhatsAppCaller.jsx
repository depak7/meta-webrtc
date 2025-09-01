import React, { useEffect, useRef, useState } from "react";

export default function InboundWhatsAppCaller() {
  const [status, setStatus] = useState("Disconnected");
  const [whatsappCallId, setWhatsappCallId] = useState(null);
  const [callState, setCallState] = useState(null); 
  const [callDuration, setCallDuration] = useState("00:00");
  const [calleeNumber, setCalleeNumber] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState("");
  const incomingSDPRef = useRef(null);

  const peerConnectionRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const callTimerRef = useRef(null);
  const callStartTimeRef = useRef(null);
  const wsRef = useRef(null);
  
  // Recording refs
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const mixedStreamRef = useRef(null);
  const audioContextRef = useRef(null);

  const BACKEND_URL = "https://webhook-service-meta.onrender.com"; 

  useEffect(() => {
    initializeWebSocket();
    return cleanup;
  }, []);

  useEffect(() => {
    if (callState === "ACCEPTED" && whatsappCallId) {
      callStartTimeRef.current = Date.now();
      callTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - callStartTimeRef.current;
        const minutes = Math.floor(elapsed / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);
        setCallDuration(`${minutes.toString().padStart(2,"0")}:${seconds.toString().padStart(2,"0")}`);
      }, 1000);
    } else {
      if (callTimerRef.current) clearInterval(callTimerRef.current);
      setCallDuration("00:00");
    }
  }, [callState, whatsappCallId]);

  const initializeWebSocket = () => {
    wsRef.current = new WebSocket("wss://webhook-service-meta.onrender.com");
    wsRef.current.onmessage = (event) => handleWebhookEvent(JSON.parse(event.data));
    wsRef.current.onopen = () => setStatus("Ready for incoming calls");
  };

  const handleWebhookEvent = async (data) => {
    if (!data) return;
    if (data.type === "incoming_call") {
      setWhatsappCallId(data.call_id);
      setCallState("RINGING");
      incomingSDPRef.current = data.sdp;
      setStatus(`Incoming call from ${data.from}`);
    }
    if (data.type === "call_connect" && data.sdp) {
      setCallState("ACCEPTED");
      setStatus("Call connecting...");
      await handleSDPOffer(data.sdp);
      // Auto-start recording when call connects
      setTimeout(() => startRecording(), 1000);
    }
    if (data.type === "call_terminate") cleanup();
  };

  const createMixedAudioStream = (localStream, remoteStream) => {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioContext;

      // Create sources
      const localSource = audioContext.createMediaStreamSource(localStream);
      const remoteSource = audioContext.createMediaStreamSource(remoteStream);

      // Create destination for mixed audio
      const destination = audioContext.createMediaStreamDestination();

      // Connect both sources to destination
      localSource.connect(destination);
      remoteSource.connect(destination);

      return destination.stream;
    } catch (error) {
      console.error("Error creating mixed audio stream:", error);
      return localStream; // Fallback to local stream only
    }
  };

  const startRecording = async () => {
    if (!localStreamRef.current || !remoteStreamRef.current) {
      // Retry after a short delay if streams aren't ready yet
      setTimeout(() => startRecording(), 500);
      return;
    }

    try {
      // Create mixed stream with both local and remote audio
      const mixedStream = createMixedAudioStream(localStreamRef.current, remoteStreamRef.current);
      mixedStreamRef.current = mixedStream;

      // Initialize MediaRecorder
      const mediaRecorder = new MediaRecorder(mixedStream, {
        mimeType: 'audio/webm;codecs=opus'
      });

      recordedChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        sendRecordingToBackend();
      };

      mediaRecorder.start(1000); // Collect data every second
      mediaRecorderRef.current = mediaRecorder;
      
      setIsRecording(true);
      setRecordingStatus("Call recording started automatically");
    } catch (error) {
      console.error("Error starting recording:", error);
      setRecordingStatus("Failed to start recording");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setRecordingStatus("Processing recording...");
    }
  };

  const sendRecordingToBackend = async () => {
    if (recordedChunksRef.current.length === 0) {
      setRecordingStatus("No recording data to send");
      return;
    }

    try {
      const recordingBlob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
      
      const formData = new FormData();
      formData.append('recording', recordingBlob, `call_${whatsappCallId}_${Date.now()}.webm`);
      formData.append('call_id', whatsappCallId);
      formData.append('duration', callDuration);
      formData.append('timestamp', new Date().toISOString());

      setRecordingStatus("Uploading recording...");

      const response = await fetch(`http://localhost:3000/api/upload-recording`, {
        method: 'POST',
        body: formData
      });

      console.log(response)

      const result = await response.json();
      
      if (result.success) {
        setRecordingStatus("Call recording saved successfully");
      } else {
        setRecordingStatus("Failed to save recording");
      }
    } catch (error) {
      console.error("Error sending recording:", error);
      setRecordingStatus("Failed to upload recording");
    }
  };

  const acceptCall = async () => {
    if (!whatsappCallId || !incomingSDPRef.current) return;
    setStatus("Accepting call...");
  
    const success = await initializeWebRTC();
    if (!success) return;
  
    try {
      // 1️⃣ Set remote description from incoming SDP
      await peerConnectionRef.current.setRemoteDescription({
        type: "offer",
        sdp: incomingSDPRef.current
      });
  
      // 2️⃣ Create local SDP answer
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
  
      // 3️⃣ Pre-accept call
      const preAcceptRes = await fetch(`${BACKEND_URL}/api/preaccept-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call_id: whatsappCallId, sdp: answer.sdp }),
      });
      const preAcceptData = await preAcceptRes.json();
      if (!preAcceptData.success) throw new Error("Pre-accept failed");
  
      // 4️⃣ Accept call officially
      await fetch(`${BACKEND_URL}/api/accept-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call_id: whatsappCallId, sdp: answer.sdp }),
      });
  
      setCallState("ACCEPTED");
      setStatus("Call connected");
      
      // Auto-start recording when call is accepted
      setTimeout(() => startRecording(), 1000); // Small delay to ensure streams are ready
    } catch (err) {
      console.error(err);
      setStatus("Failed to accept call");
    }
  };

  const makeCall = async () => {
    if (!calleeNumber) return alert("Enter a phone number");
  
    setStatus("Initiating call...");
  
    try {
      // 1️⃣ Initialize WebRTC and get local SDP offer
      const pc = new RTCPeerConnection({ iceServers:[{urls:"stun:stun.l.google.com:19302"}] });
      peerConnectionRef.current = pc;
  
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        remoteStreamRef.current = remoteStream;
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.play().catch(()=>document.addEventListener("click",()=>remoteAudioRef.current.play(),{once:true}));
      };
  
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
  
      // 2️⃣ Send offer to backend to initiate business call
      const res = await fetch(`${BACKEND_URL}/api/make-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: calleeNumber, sdp_offer: offer.sdp })
      });
  
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to initiate call");
  
      setWhatsappCallId(data.call_id);
      setCallState("ACCEPTED"); // Set as accepted since we're making the call
      setStatus("Call initiated - waiting for connection...");
      
      // Auto-start recording for outgoing calls
      setTimeout(() => startRecording(), 1000);
    } catch (err) {
      console.error(err);
      setStatus("Call failed to initiate");
    }
  };

  const initializeWebRTC = async () => {
    try {
      peerConnectionRef.current = new RTCPeerConnection({ iceServers:[{urls:"stun:stun.l.google.com:19302"}] });

      peerConnectionRef.current.ontrack = (event) => {
        const [remoteStream] = event.streams;
        remoteStreamRef.current = remoteStream;
        remoteAudioRef.current.srcObject = remoteStream;
        remoteAudioRef.current.play().catch(() => document.addEventListener("click", () => remoteAudioRef.current.play(), {once:true}));
      };

      peerConnectionRef.current.oniceconnectionstatechange = () => {
        if(peerConnectionRef.current.iceConnectionState==="connected") setStatus("Audio connected");
      };

      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      localStream.getTracks().forEach(track => peerConnectionRef.current.addTrack(track, localStream));

      return true;
    } catch (err) {
      console.error(err); alert("WebRTC failed"); return false;
    }
  };

  const handleSDPOffer = async (sdpOffer) => {
    if(!peerConnectionRef.current) return;
    try {
      await peerConnectionRef.current.setRemoteDescription({ type:"offer", sdp: sdpOffer });
      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      await fetch(`${BACKEND_URL}/api/accept-call`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({call_id: whatsappCallId, sdp: answer.sdp}) });
    } catch(err){ console.error(err); }
  };

  const hangup = async () => {
    if (isRecording) {
      stopRecording();
    }
    
    if (!whatsappCallId) return;
    await fetch(`${BACKEND_URL}/api/terminate-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ call_id: whatsappCallId }),
    });
    cleanup();
  };

  const cleanup = () => {
    if (isRecording) stopRecording();
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    if (peerConnectionRef.current) { 
      peerConnectionRef.current.close(); 
      peerConnectionRef.current = null;
    }
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    if (audioContextRef.current) audioContextRef.current.close();
    
    // Clear stream refs
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    mixedStreamRef.current = null;
    
    setWhatsappCallId(null); 
    setCallState(null); 
    setCallDuration("00:00"); 
    setStatus("Ready for incoming calls");
    setIsRecording(false);
    setRecordingStatus("");
  };

  return (
    <div className="max-w-md mx-auto p-6 bg-white shadow rounded-lg">
      <h2 className="text-xl font-bold mb-2">📞 WhatsApp Caller with Recording</h2>
      <div className="mb-4 text-sm text-gray-700">Status: {status}</div>
      
      {recordingStatus && (
        <div className="mb-4 text-sm text-blue-600">Recording: {recordingStatus}</div>
      )}

      {callState==="RINGING" && (
        <div className="mb-4">
          <button onClick={acceptCall} className="bg-green-500 text-white px-4 py-2 rounded mr-2">✅ Accept</button>
          <button onClick={hangup} className="bg-red-500 text-white px-4 py-2 rounded">❌ Reject</button>
        </div>
      )}

      {callState==="ACCEPTED" && (
        <div className="mb-4">
          <div className="mb-2">Call Duration: {callDuration}</div>
          <div className="mb-2">
            <span className={`text-sm px-2 py-1 rounded ${isRecording ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-700'}`}>
              {isRecording ? '🔴 Recording Active' : '⚪ Recording Stopped'}
            </span>
          </div>
          <button onClick={hangup} className="bg-red-500 text-white px-4 py-2 rounded">📞 Hang Up</button>
        </div>
      )}

      <audio ref={remoteAudioRef} autoPlay playsInline controls/>

      <div className="mb-4">
        <input 
          type="text" 
          placeholder="Enter phone number" 
          value={calleeNumber} 
          onChange={e=>setCalleeNumber(e.target.value)}
          className="border px-2 py-1 rounded mr-2"
        />
        <button onClick={makeCall} className="bg-blue-500 text-white px-4 py-2 rounded">📞 Make Call</button>
      </div>
    </div>
  );
}