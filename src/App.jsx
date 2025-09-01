import { useState } from 'react'
import './App.css'
import SipClient from './components/SipClient'
import MetaSipClient from './components/BusinessInitiatedCalls'
import WhatsAppCaller from './components/WhasappCaller'
import InboundWhatsAppCaller from './components/InboundWhatsAppCaller'
import SSEInboundWhatsAppCaller from './components/SseInbound'

function App() {

  return (
    <>
      {/* <SipClient /> */}
      {/* <MetaSipClient/> */}
      {/* <WhatsAppCaller/>< */}
      {/* <InboundWhatsAppCaller/>
     */}
     <SSEInboundWhatsAppCaller/>
      
    </>
  ) 
}

export default App
