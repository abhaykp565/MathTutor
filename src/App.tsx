/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { Camera, Send, Loader2, User, GraduationCap, Image as ImageIcon, X, RefreshCw, FileUp, FileText, Info } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { getGeminiResponse } from './services/gemini';

interface Message {
  role: 'user' | 'model';
  content: string;
  image?: string;
  isContext?: boolean;
}

interface Document {
  id: number;
  filename: string;
  summary?: string;
}

export default function App() {
  // Chat history state: stores the conversation between the user and the AI tutor.
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'model',
      content: "Hello! I'm your math tutor. I'm here to help you understand the 'why' behind the math, not just the 'how'. \n\nFeel free to upload a photo of a problem, or **upload a document (PDF/Text)** for me to reference. What are we exploring today?",
    },
  ]);
  
  // UI and Input states
  const [input, setInput] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [streamingText, setStreamingText] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [activeDocs, setActiveDocs] = useState<Document[]>([]);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  // Initial load: fetch existing documents from the RAG system
  useEffect(() => {
    fetchDocuments();
  }, []);

  // Auto-scroll to bottom when new messages arrive or while streaming
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingText]);

  /**
   * Fetches the list of uploaded documents from the backend.
   */
  const fetchDocuments = async () => {
    try {
      const res = await fetch('/api/documents');
      const data = await res.json();
      setActiveDocs(data);
    } catch (err) {
      console.error("Failed to fetch documents", err);
    }
  };

  /**
   * Handles camera/image upload for visual math problems.
   */
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        setImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  /**
   * Handles document upload (PDF/TXT) to the RAG system.
   * 1. Uploads file to backend for AI-based semantic chunking and embedding.
   * 2. Uses Gemini to generate a concise summary of the document.
   * 3. Saves the summary back to the document record for UI display.
   */
  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      
      // Generate AI summary for the new document
      const summaryPrompt = `Please provide a very concise (1-2 sentences) summary of this document's main math topics: \n\n${data.text}`;
      const summary = await getGeminiResponse([{ role: 'user', content: summaryPrompt }]);
      
      // Save summary to backend
      await fetch(`/api/documents/${data.id}/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary }),
      });

      await fetchDocuments();
      
      setMessages(prev => [...prev, {
        role: 'model',
        content: `I've received and analyzed your document: **${file.name}**. \n\n**Summary:** ${summary}\n\nI'll keep this context in mind as we work through problems together!`
      }]);
    } catch (err) {
      console.error("Upload failed", err);
    } finally {
      setIsUploading(false);
    }
  };

  /**
   * Main message sending logic:
   * 1. Performs a semantic search (RAG) against uploaded documents if there's text input.
   * 2. Appends relevant context to the prompt for the AI tutor.
   * 3. Calls Gemini with 'Thinking Mode' enabled for high-quality Socratic guidance.
   */
  const handleSend = async () => {
    if ((!input.trim() && !image) || isLoading) return;

    let context = "";
    if (input.trim()) {
      try {
        // RAG: Search for relevant snippets in the vector DB based on semantic similarity
        const searchRes = await fetch(`/api/search?q=${encodeURIComponent(input)}`);
        const searchData = await searchRes.json();
        if (searchData.length > 0) {
          context = "\n\nRelevant context from uploaded documents:\n" + searchData.map((d: any) => d.content).join("\n---\n");
        }
      } catch (err) {
        console.error("Search failed", err);
      }
    }

    const userMessage: Message = {
      role: 'user',
      content: input || (image ? "I've uploaded a problem. Can you help me with the first step?" : ""),
      image: image || undefined,
    };

    // Inject context into the prompt for the model (hidden from the user UI)
    const promptWithContext = userMessage.content + (context ? `\n\n[CONTEXT FOR TUTOR]: ${context}` : "");

    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setImage(null);
    setIsLoading(true);
    setStreamingText('');

    try {
      const messagesForAI = [...messages, { ...userMessage, content: promptWithContext }];
      const fullResponse = await getGeminiResponse(messagesForAI as any, (chunk) => {
        setStreamingText((prev) => prev + chunk);
      });
      setMessages((prev) => [...prev, { role: 'model', content: fullResponse }]);
      setStreamingText('');
    } catch (error) {
      console.error('Error getting Gemini response:', error);
      setMessages((prev) => [
        ...prev,
        { role: 'model', content: "I'm sorry, I encountered an error. Could you try asking that again?" },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const clearChat = () => {
    setMessages([
      {
        role: 'model',
        content: "Hello! I'm your math tutor. I'm here to help you understand the 'why' behind the math, not just the 'how'. \n\nFeel free to upload a photo of a problem, or **upload a document (PDF/Text)** for me to reference. What are we exploring today?",
      },
    ]);
  };

  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto bg-white shadow-xl border-x border-zinc-100">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-100 bg-white/80 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center text-emerald-600">
            <GraduationCap size={24} />
          </div>
          <div>
            <h1 className="font-serif text-xl font-semibold text-zinc-900">Socratic Tutor</h1>
            <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Patient • Thoughtful • Precise</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {activeDocs.length > 0 && (
            <div className="flex -space-x-2 mr-2">
              {activeDocs.slice(0, 3).map((doc, i) => (
                <div key={doc.id} className="w-8 h-8 rounded-full bg-zinc-100 border-2 border-white flex items-center justify-center text-zinc-500" title={doc.filename}>
                  <FileText size={14} />
                </div>
              ))}
              {activeDocs.length > 3 && (
                <div className="w-8 h-8 rounded-full bg-zinc-200 border-2 border-white flex items-center justify-center text-zinc-600 text-[10px] font-bold">
                  +{activeDocs.length - 3}
                </div>
              )}
            </div>
          )}
          <button 
            onClick={clearChat}
            className="p-2 text-zinc-400 hover:text-zinc-600 transition-colors rounded-full hover:bg-zinc-50"
            title="Reset Conversation"
          >
            <RefreshCw size={20} />
          </button>
        </div>
      </header>

      {/* Chat Area */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-6 space-y-8 scroll-smooth"
      >
        {messages.map((msg, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={`flex gap-4 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
          >
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
              msg.role === 'user' ? 'bg-zinc-100 text-zinc-600' : 'bg-emerald-50 text-emerald-600'
            }`}>
              {msg.role === 'user' ? <User size={18} /> : <GraduationCap size={18} />}
            </div>
            <div className={`flex flex-col max-w-[85%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
              {msg.image && (
                <div className="mb-3 rounded-2xl overflow-hidden border border-zinc-200 shadow-sm">
                  <img src={msg.image} alt="Problem" className="max-w-full h-auto max-h-64 object-contain" />
                </div>
              )}
              <div className={`px-5 py-3 rounded-2xl text-sm leading-relaxed ${
                msg.role === 'user' 
                  ? 'bg-zinc-900 text-white rounded-tr-none' 
                  : 'bg-zinc-50 text-zinc-800 rounded-tl-none border border-zinc-100'
              }`}>
                <div className="markdown-body">
                  <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                    {msg.content}
                  </Markdown>
                </div>
              </div>
            </div>
          </motion.div>
        ))}
        
        {/* Streaming Response */}
        {streamingText && (
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0">
              <GraduationCap size={18} />
            </div>
            <div className="flex flex-col max-w-[85%] items-start">
              <div className="px-5 py-3 rounded-2xl text-sm leading-relaxed bg-zinc-50 text-zinc-800 rounded-tl-none border border-zinc-100">
                <div className="markdown-body">
                  <Markdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                    {streamingText}
                  </Markdown>
                </div>
              </div>
            </div>
          </div>
        )}

        {(isLoading || isUploading) && !streamingText && (
          <div className="flex gap-4">
            <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center flex-shrink-0">
              <GraduationCap size={18} />
            </div>
            <div className="px-5 py-3 rounded-2xl bg-zinc-50 border border-zinc-100 flex items-center gap-2">
              <Loader2 size={18} className="animate-spin text-emerald-600" />
              <span className="text-xs text-zinc-500 font-medium">
                {isUploading ? "Processing document..." : "Thinking..."}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="p-6 bg-white border-t border-zinc-100">
        <AnimatePresence>
          {image && (
            <motion.div 
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              className="relative inline-block mb-4"
            >
              <img src={image} alt="Preview" className="h-20 w-20 object-cover rounded-xl border-2 border-emerald-500 shadow-lg" />
              <button 
                onClick={() => setImage(null)}
                className="absolute -top-2 -right-2 bg-zinc-900 text-white rounded-full p-1 shadow-md hover:bg-zinc-800 transition-colors"
              >
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative flex items-end gap-2 bg-zinc-50 rounded-2xl p-2 border border-zinc-200 focus-within:border-emerald-500/50 focus-within:ring-4 focus-within:ring-emerald-500/5 transition-all">
          <div className="flex gap-1">
            <button 
              onClick={() => fileInputRef.current?.click()}
              className="p-3 text-zinc-500 hover:text-emerald-600 transition-colors rounded-xl hover:bg-white shadow-sm"
              title="Upload Problem Image"
            >
              <Camera size={20} />
            </button>
            <button 
              onClick={() => docInputRef.current?.click()}
              className="p-3 text-zinc-500 hover:text-emerald-600 transition-colors rounded-xl hover:bg-white shadow-sm"
              title="Upload Study Document (PDF/Text)"
            >
              <FileUp size={20} />
            </button>
          </div>
          
          <input 
            type="file" 
            ref={fileInputRef} 
            className="hidden" 
            accept="image/*" 
            onChange={handleImageUpload}
          />
          <input 
            type="file" 
            ref={docInputRef} 
            className="hidden" 
            accept=".pdf,.txt" 
            onChange={handleDocUpload}
          />
          
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask a question or describe your problem..."
            className="flex-1 bg-transparent border-none focus:ring-0 text-sm py-3 px-1 resize-none max-h-32 min-h-[44px]"
            rows={1}
          />

          <button
            onClick={handleSend}
            disabled={(!input.trim() && !image) || isLoading || isUploading}
            className={`p-3 rounded-xl transition-all shadow-sm ${
              (!input.trim() && !image) || isLoading || isUploading
                ? 'bg-zinc-200 text-zinc-400 cursor-not-allowed'
                : 'bg-emerald-600 text-white hover:bg-emerald-700 active:scale-95'
            }`}
          >
            <Send size={20} />
          </button>
        </div>
        <div className="mt-3 flex items-center justify-center gap-4">
          <p className="text-[10px] text-zinc-400 font-medium uppercase tracking-widest">
            Socratic Method • Step-by-Step Learning
          </p>
          {activeDocs.length > 0 && (
            <div className="flex items-center gap-1 text-[10px] text-emerald-600 font-bold uppercase tracking-widest">
              <Info size={10} />
              RAG Active ({activeDocs.length} docs)
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
