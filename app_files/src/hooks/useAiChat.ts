import { getAuthToken } from '@/lib/auth';
import React from 'react';
import { useState, useCallback, useRef } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  citations?: Citation[];
}

export interface Citation {
  title: string;
  snippet?: string;
}

export interface UseAiChatOptions {
  systemPrompt?: string;
  useRag?: boolean;
  onMessage?: (message: ChatMessage) => void;
  onError?: (error: string) => void;
}

/**
 * Hook for AI-powered chat in your app
 *
 * AI Chat is ENABLED BY DEFAULT with gemini-3.1-pro-preview model.
 * No configuration required - just import and use!
 *
 * Features:
 * - Automatic conversation history management
 * - RAG integration for knowledge-grounded answers
 * - Credit usage tracking (you pay per token used)
 *
 * Usage:
 * ```tsx
 * function ChatComponent() {
 *   const {
 *     messages,
 *     sendMessage,
 *     loading,
 *     error,
 *     clearHistory
 *   } = useAiChat();
 *
 *   const handleSend = async (text: string) => {
 *     await sendMessage(text);
 *   };
 *
 *   return (
 *     <div>
 *       {messages.map(msg => (
 *         <div key={msg.id} className={msg.role}>
 *           {msg.content}
 *           {msg.citations?.map(c => <cite key={c.title}>{c.title}</cite>)}
 *         </div>
 *       ))}
 *       <input onKeyDown={e => e.key === 'Enter' && handleSend((e.target as HTMLInputElement).value)} />
 *       {loading && <span>Thinking...</span>}
 *       {error && <span className="error">{error}</span>}
 *     </div>
 *   );
 * }
 * ```
 *
 * To customize AI settings (model, system prompt, RAG), the app creator
 * can use the enable-ai-chat tool in the editor.
 */
export function useAiChat(options?: UseAiChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageIdCounter = useRef(0);

  const generateId = () => `msg_${Date.now()}_${++messageIdCounter.current}`;

  const sendMessage = useCallback(async (content: string): Promise<ChatMessage | null> => {
    if (!content.trim()) return null;

    setLoading(true);
    setError(null);

    // Add user message immediately
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: content.trim(),
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);

    try {
      const token = getAuthToken();

      // Build request with conversation history
      const conversationHistory = messages.map(m => ({
        role: m.role,
        content: m.content
      }));

      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { 'Authorization': `Bearer ${token}` })
        },
        body: JSON.stringify({
          message: content.trim(),
          history: conversationHistory,
          system_prompt: options?.systemPrompt,
          use_rag: options?.useRag ?? false
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'AI request failed');
      }

      const data = await response.json();

      const assistantMessage: ChatMessage = {
        id: generateId(),
        role: 'assistant',
        content: data.content || data.message || data.response,
        timestamp: new Date(),
        citations: data.citations
      };

      setMessages(prev => [...prev, assistantMessage]);
      options?.onMessage?.(assistantMessage);

      return assistantMessage;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      options?.onError?.(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [messages, options]);

  const clearHistory = useCallback(() => {
    setMessages([]);
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    messages,
    sendMessage,
    loading,
    error,
    clearHistory,
    clearError,
    messageCount: messages.length
  };
}

export default useAiChat;
