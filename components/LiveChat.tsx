
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage } from '@google/genai';
import { Persona, TranscriptionItem } from '../types';
import { createPcmBlob, decode, decodeAudioData } from '../audioUtils';

interface LiveChatProps {
  persona: Persona;
  onEnd: () => void;
  onUpdateMemory?: (personaId: string, newMemory: string) => void;
}

const LiveChat: React.FC<LiveChatProps> = ({ persona, onEnd, onUpdateMemory }) => {
  const [status, setStatus] = useState<'connecting' | 'active' | 'error' | 'closed' | 'summarizing'>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [transcriptions, setTranscriptions] = useState<TranscriptionItem[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const retryCountRef = useRef(0);
  const maxRetries = 3;

  // Recording Refs
  const recordingDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const currentInputTranscriptionRef = useRef('');
  const currentOutputTranscriptionRef = useRef('');
  const isMutedRef = useRef(isMuted);
  const transcriptionsRef = useRef<TranscriptionItem[]>([]);

  // Update transcriptions ref for summarization access
  useEffect(() => {
    transcriptionsRef.current = transcriptions;
  }, [transcriptions]);

  // Sync mute state to ref for callback access without re-initialization
  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  const summarizeSession = async () => {
    if (transcriptionsRef.current.length < 2 || !onUpdateMemory || !persona.isCustom) {
      onEnd();
      return;
    }

    setStatus('summarizing');
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const historyText = transcriptionsRef.current.map(t => `${t.type}: ${t.text}`).join('\n');
      
      const prompt = `Analyze the following conversation between an AI and a User. 
      Extract and summarize key facts about the user, their preferences, their name if mentioned, and their emotional triggers or roleplay preferences.
      Keep the summary concise (max 100 words). This will be used as a persistent memory for the AI.
      
      Current Memory: ${persona.memory || 'None'}
      
      New Conversation:
      ${historyText}
      
      Provide the updated, cumulative summary of user preferences and facts. Output ONLY the summary.`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt
      });

      const newMemory = response.text || persona.memory || "";
      onUpdateMemory(persona.id, newMemory);
    } catch (e) {
      console.error("Summarization failed", e);
    } finally {
      onEnd();
    }
  };

  const handleDisconnect = () => {
    if (isRecording) handleStopRecording();
    summarizeSession();
  };

  const cleanupAudioResources = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current.onaudioprocess = null;
    }
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') inputAudioContextRef.current.close().catch(() => {});
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') outputAudioContextRef.current.close().catch(() => {});
    sessionPromiseRef.current?.then((s: any) => { try { s.close(); } catch(e) {} });
  }, []);

  const handleStartRecording = useCallback(() => {
    if (!outputAudioContextRef.current || !streamRef.current) return;
    const ctx = outputAudioContextRef.current;
    
    // Create destination for recording mixing
    const dest = ctx.createMediaStreamDestination();
    recordingDestinationRef.current = dest;

    // Mix in Microphone (User) - Only connect to recording destination, NOT speakers
    const micSource = ctx.createMediaStreamSource(streamRef.current);
    micSource.connect(dest);
    micSourceRef.current = micSource;

    // Setup Recorder
    const recorder = new MediaRecorder(dest.stream);
    mediaRecorderRef.current = recorder;
    recordedChunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: 'audio/webm' });
      setRecordingBlob(blob);
      
      // Cleanup recording specific nodes
      if (micSourceRef.current) {
        micSourceRef.current.disconnect();
        micSourceRef.current = null;
      }
      recordingDestinationRef.current = null;
    };

    recorder.start();
    setIsRecording(true);
    setRecordingBlob(null);
  }, []);

  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, []);

  const downloadRecording = useCallback(() => {
    if (!recordingBlob) return;
    const url = URL.createObjectURL(recordingBlob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `session-${persona.name}-${new Date().toISOString().slice(0,19).replace(/:/g, '-')}.webm`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
  }, [recordingBlob, persona.name]);

  const initializeLiveSession = useCallback(async () => {
    setStatus('connecting');
    setErrorMsg(null);

    if (!process.env.API_KEY) {
      setStatus('error');
      setErrorMsg("Missing API Key. Please check your configuration.");
      return;
    }

    try {
      // Cleanup previous session if any (for retries)
      cleanupAudioResources();

      // Initialize Audio Contexts with specific error handling
      try {
        inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      } catch (e) {
        throw new Error("AUDIO_CONTEXT_INIT_FAILED");
      }

      // Resume contexts if suspended (browser autoplay policy)
      try {
        if (inputAudioContextRef.current.state === 'suspended') await inputAudioContextRef.current.resume();
        if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();
      } catch (e) {
        console.warn("Audio context resume failed:", e);
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Get User Media with specific error mapping
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            autoGainControl: true,
            noiseSuppression: true
          } 
        });
        streamRef.current = stream;
      } catch (e: any) {
        if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
          throw new Error("MIC_PERMISSION_DENIED");
        } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
          throw new Error("MIC_NOT_FOUND");
        } else if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
          throw new Error("MIC_IN_USE");
        } else {
          throw e;
        }
      }

      // Inject memory into system instructions
      const augmentedInstructions = persona.memory 
        ? `${persona.systemInstruction}\n\nUSER MEMORY (Recall these details about the user): ${persona.memory}`
        : persona.systemInstruction;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus('active');
            retryCountRef.current = 0; // Reset retries on success
            
            if (!inputAudioContextRef.current || !streamRef.current) return;
            
            const source = inputAudioContextRef.current.createMediaStreamSource(streamRef.current);
            // Reduced buffer size from 4096 to 2048 to lower input latency (approx 128ms @ 16kHz)
            const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(2048, 1, 1);
            scriptProcessorRef.current = scriptProcessor;
            
            scriptProcessor.onaudioprocess = (e) => {
              if (isMutedRef.current) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              
              // CRITICAL: Ensure sessionPromise is resolved before sending
              sessionPromise.then((session) => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(err => {
                console.warn("Failed to send audio chunk:", err);
              });
            };
            
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
              const ctx = outputAudioContextRef.current;
              if (ctx.state === 'suspended') await ctx.resume();
              
              // Time sync
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination); // Connect to speakers
              
              // Connect to recording destination if active
              if (recordingDestinationRef.current) {
                source.connect(recordingDestinationRef.current);
              }

              source.addEventListener('ended', () => sourcesRef.current.delete(source));
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.serverContent?.inputTranscription) currentInputTranscriptionRef.current += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) currentOutputTranscriptionRef.current += message.serverContent.outputTranscription.text;
            
            if (message.serverContent?.turnComplete) {
              const input = currentInputTranscriptionRef.current;
              const output = currentOutputTranscriptionRef.current;
              if (input || output) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(input ? [{ type: 'user', text: input } as const] : []),
                  ...(output ? [{ type: 'model', text: output } as const] : [])
                ]);
              }
              currentInputTranscriptionRef.current = '';
              currentOutputTranscriptionRef.current = '';
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e: any) => { 
            console.error('Gemini Live Socket Error:', e);
            const msg = e instanceof Error ? e.message : (e?.message || JSON.stringify(e));
            
            // Retry logic for unavailable service or transient errors
            const isTransientError = msg.includes('unavailable') || 
                                     msg.includes('503') || 
                                     msg.includes('502') ||
                                     msg.includes('500') ||
                                     msg.includes('aborted') ||
                                     msg.includes('reset');

            if (isTransientError && retryCountRef.current < maxRetries) {
               retryCountRef.current++;
               const delay = Math.pow(2, retryCountRef.current) * 1000; // Exponential backoff: 2s, 4s, 8s
               console.log(`Retrying connection in ${delay}ms... Attempt ${retryCountRef.current}/${maxRetries}`);
               
               setStatus('connecting'); // Keep UI in connecting state
               
               setTimeout(() => {
                 initializeLiveSession();
               }, delay);
               return;
            }

            setStatus('error');
            
            if (msg.includes('Network')) {
                setErrorMsg("Network connection lost. Please check your internet.");
            } else if (isTransientError) {
                setErrorMsg("Service temporarily unavailable. Please try again in a moment.");
            } else {
                setErrorMsg("Connection error: " + (msg.length > 50 ? msg.substring(0, 50) + "..." : msg));
            }
          },
          onclose: (e) => {
             console.log("Session closed", e);
             if (status !== 'error' && status !== 'summarizing' && status !== 'connecting') setStatus('closed');
          }
        },
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: persona.voiceName } }
          },
          systemInstruction: augmentedInstructions,
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      
      sessionPromiseRef.current = sessionPromise;
      
    } catch (err: any) { 
      console.error("Initialization Error", err);
      setStatus('error'); 
      
      // User-friendly error messages
      switch (err.message) {
        case "MIC_PERMISSION_DENIED":
          setErrorMsg("Microphone access denied. Please allow permissions in your browser settings.");
          break;
        case "MIC_NOT_FOUND":
          setErrorMsg("No microphone found. Please check your audio devices.");
          break;
        case "MIC_IN_USE":
          setErrorMsg("Microphone is in use by another application or tab.");
          break;
        case "AUDIO_CONTEXT_INIT_FAILED":
          setErrorMsg("Failed to start audio engine. Please restart your browser.");
          break;
        default:
          setErrorMsg(err?.message || "Failed to initialize audio connection.");
      }
    }
  }, [persona, cleanupAudioResources]);

  useEffect(() => {
    initializeLiveSession();
    return () => {
      cleanupAudioResources();
    };
  }, [initializeLiveSession, cleanupAudioResources]);

  return (
    <div className="flex flex-col h-[75vh] w-full max-w-3xl mx-auto bg-zinc-950 rounded-[40px] overflow-hidden border border-zinc-900 shadow-[0_0_50px_rgba(0,0,0,1)] relative">
      
      {(status === 'connecting' || status === 'summarizing') && (
        <div className="absolute inset-0 z-20 bg-black flex flex-col items-center justify-center text-center p-8">
          <div className="w-12 h-12 border-2 border-zinc-800 border-t-zinc-200 rounded-full animate-spin mb-8"></div>
          <h3 className="text-2xl italic text-zinc-100">
            {status === 'connecting' ? 'Syncing Vocal Matrix...' : 'Evolving Memory Matrix...'}
          </h3>
          <p className="text-zinc-500 mt-2">
            {status === 'connecting' ? (retryCountRef.current > 0 ? `Retrying connection (${retryCountRef.current}/${maxRetries})...` : `Connecting to ${persona.name}`) : 'Extracting user preferences for future recall'}
          </p>
        </div>
      )}

      {status === 'error' && (
        <div className="absolute inset-0 z-30 bg-black/95 flex flex-col items-center justify-center text-center p-12">
          <div className="text-red-500 mb-6 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]">
             <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          </div>
          <h3 className="text-2xl font-bold mb-2">Connection Severed</h3>
          <p className="text-zinc-400 mb-8 max-w-xs">{errorMsg || "The vocal link was severed."}</p>
          <div className="flex gap-4">
            <button onClick={() => { retryCountRef.current = 0; initializeLiveSession(); }} className="px-8 py-3 bg-white text-black rounded-full font-bold hover:scale-105 transition-all">Retry Link</button>
            <button onClick={onEnd} className="px-8 py-3 bg-zinc-900 text-white rounded-full font-bold hover:bg-zinc-800 transition-all border border-zinc-700">Exit</button>
          </div>
        </div>
      )}

      <div className="p-8 border-b border-zinc-900 flex items-center justify-between bg-zinc-950/80 backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className={`w-2 h-2 rounded-full ${status === 'active' ? 'bg-zinc-100 shadow-[0_0_10px_white]' : 'bg-zinc-800'}`}></div>
          <div>
            <div className="font-bold text-lg italic tracking-tight">{persona.name}</div>
            <div className="flex items-center gap-2">
              <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Live Vocal Feedback</div>
              {persona.memory && <span className="text-[8px] px-2 py-0.5 bg-blue-500/10 text-blue-400 border border-blue-400/20 rounded-full animate-pulse-slow">Memory Active</span>}
            </div>
          </div>
        </div>
        <div className="flex gap-4 items-center">
             {status === 'active' && (
                 <>
                   {!isRecording ? (
                      <button onClick={handleStartRecording} className="group flex items-center gap-2 text-[10px] uppercase tracking-widest text-zinc-500 hover:text-red-400 transition-all" title="Record Session">
                        <div className="w-2 h-2 rounded-full bg-current group-hover:scale-125 transition-transform"></div>
                        Rec
                      </button>
                   ) : (
                      <button onClick={handleStopRecording} className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-red-500 animate-pulse" title="Stop Recording">
                        <div className="w-2 h-2 rounded-sm bg-current"></div>
                        Stop
                      </button>
                   )}
                   {recordingBlob && !isRecording && (
                       <button onClick={downloadRecording} className="text-[10px] uppercase tracking-widest text-green-500 hover:text-green-400 flex items-center gap-2" title="Download Recording">
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                          Save
                       </button>
                   )}
                 </>
             )}
             <button onClick={handleDisconnect} className="text-[10px] uppercase tracking-widest text-zinc-500 hover:text-white transition-all">Disconnect</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-10 space-y-6 scroll-smooth bg-gradient-to-b from-transparent to-zinc-900/20">
        {transcriptions.length === 0 && status === 'active' && (
          <div className="h-full flex flex-col items-center justify-center opacity-20 text-center px-10">
            <div className="mb-4 animate-pulse-slow">
              <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
            </div>
            <p className="text-lg italic tracking-wide">Interface active. Speak now.</p>
            {persona.memory && <p className="text-xs text-zinc-400 mt-2 max-w-xs italic opacity-50">"{persona.name}" currently recalls some of your history.</p>}
          </div>
        )}
        {transcriptions.map((t, i) => (
          <div key={i} className={`flex ${t.type === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}>
            <div className={`max-w-[85%] px-6 py-3 rounded-[24px] text-sm leading-relaxed ${
              t.type === 'user' ? 'bg-zinc-900 text-zinc-300' : 'bg-white/5 text-zinc-100 border border-zinc-800'
            }`}>
              {t.text}
            </div>
          </div>
        ))}
      </div>

      <div className="p-10 bg-black border-t border-zinc-900">
        <div className="flex flex-col items-center gap-8">
          <div className="flex items-end gap-1.5 h-16">
            {status === 'active' && !isMuted && Array.from({length: 12}).map((_, i) => (
              <div key={i} className="w-1.5 bg-zinc-600 rounded-full transition-all duration-100" 
                   style={{ height: `${25 + Math.random() * 75}%`, opacity: 0.2 + (Math.random() * 0.8) }}></div>
            ))}
            {isMuted && <div className="text-zinc-700 uppercase tracking-widest text-[10px]">Mic Suspended</div>}
          </div>
          
          <button 
            onClick={() => setIsMuted(!isMuted)}
            className={`w-20 h-20 rounded-full flex items-center justify-center transition-all ${isMuted ? 'bg-zinc-900 scale-95 border border-zinc-800' : 'bg-white text-black hover:scale-105 active:scale-90 shadow-[0_0_40px_rgba(255,255,255,0.15)]'}`}
          >
            {isMuted ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 19 3-3 3 3"/><path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h6"/><path d="m2 2 20 20"/></svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LiveChat;
