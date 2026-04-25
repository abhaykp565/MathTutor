import { GoogleGenAI, ThinkingLevel } from "@google/genai";

/**
 * System Instruction for the Socratic Math Tutor:
 * This prompt defines the AI's personality and pedagogical approach.
 * It enforces the Socratic method, LaTeX usage, and a compassionate tone.
 */
const SYSTEM_INSTRUCTION = `You are a compassionate, patient, and Socratic math tutor. Your goal is to help students learn, not just give them answers. 

When a student provides a problem (text or image):
1. Acknowledge the problem and offer a word of encouragement.
2. Identify the core concept.
3. Guide them through ONLY the first logical step.
4. Ask a leading question to prompt them to think about the next step.

If the student asks "Why?" or "I'm stuck", explain the specific concept or rule behind the current step in simple, intuitive terms. Use analogies if helpful.

Guidelines:
- Never provide the full solution at once.
- Use LaTeX for ALL math notation. Use single $ for inline math and double $$ for block math.
- Maintain a warm, encouraging, and professional tone.
- If the student makes a mistake, gently point it out and ask a question that helps them discover the error themselves.
- If the image is unclear, ask them to describe the problem or retake the photo.`;

/**
 * Gemini API Service:
 * Handles streaming responses from Gemini 3.1 Pro with Thinking Mode enabled.
 * Supports multi-modal input (text + images).
 */
export async function getGeminiResponse(
  messages: { role: "user" | "model"; content: string; image?: string }[],
  onChunk?: (chunk: string) => void
) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  
  // Prepare conversation history for the chat model
  const history = messages.slice(0, -1).map(m => ({
    role: m.role,
    parts: [{ text: m.content }]
  }));

  // Prepare current message with optional image data for multi-modal reasoning
  const lastMessage = messages[messages.length - 1];
  const parts: any[] = [{ text: lastMessage.content }];

  if (lastMessage.image) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: lastMessage.image.split(",")[1]
      }
    });
  }

  // Call Gemini with streaming and high thinking level for complex math reasoning
  const response = await ai.models.generateContentStream({
    model: "gemini-3.1-pro-preview",
    contents: [
      ...history,
      { role: "user", parts }
    ],
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH }
    },
  });

  let fullText = "";
  for await (const chunk of response) {
    const text = chunk.text || "";
    fullText += text;
    if (onChunk) onChunk(text);
  }

  return fullText;
}
