import { GoogleGenerativeAI } from "@google/generative-ai";

// Initialize the Generative AI client with your API key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Specify the model and its configuration
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const generationConfig = {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
    responseMimeType: "text/plain",
};

/**
 * Analyze a research paper using the Gemini AI model.
 * @param {string} paperChunk - The research paper chunk to analyze.
 * @returns {Promise<Object>} - The AI-generated structured response.
 */
export const analyzePaper = async (paperChunk) => {
    try {
        // Create a structured prompt that explicitly requests JSON format
        const structuredPrompt = `
You are a research paper analysis AI. Analyze the following research paper content and provide a response in valid JSON format with exactly these fields:
- "keywords": An array of important keywords or concepts (8-10 items)
- "summary": A concise summary (2-3 paragraphs)
- "explanation": A detailed explanation of the main concepts (3-5 paragraphs)

The response MUST be valid JSON that can be parsed by JSON.parse(). Do not include any text outside the JSON structure.
Format example:
{
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "summary": "Concise summary here...",
  "explanation": "Detailed explanation here..."
}

Research Paper Content:
${paperChunk}
`;

        // Send the prompt to the model and await the response
        const result = await model.generateContent(structuredPrompt);
        const textResponse = result.response.text();

        // Parse the JSON response
        try {
            // Extract JSON if it's wrapped in backticks or other markdown
            const jsonMatch = textResponse.match(
                /```json\s*([\s\S]*?)\s*```/
            ) ||
                textResponse.match(/```\s*([\s\S]*?)\s*```/) || [
                    null,
                    textResponse,
                ];

            const cleanedJson = jsonMatch[1].trim();
            console.log(JSON.parse(cleanedJson));
            return JSON.parse(cleanedJson);
        } catch (parseError) {
            console.error("Error parsing JSON response:", parseError);
            console.log("Raw response:", textResponse);

            // Fallback structure if parsing fails
            return {
                keywords: [],
                summary:
                    "Failed to parse summary. Please check the raw response.",
                explanation:
                    "Failed to parse explanation. Please check the raw response.",
            };
        }
    } catch (err) {
        console.error("Gemini API Error:", err);
        throw new Error("Gemini API Error: " + err.message);
    }
};

/**
 * Generate a response to a user question using the Gemini AI model.
 * @param {string} prompt - The prompt to send to the Gemini model.
 * @returns {Promise<string>} - The AI-generated response text.
 */
export const generateResponse = async (prompt) => {
    try {
        // Send the prompt to the model and await the response
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig,
        });

        // Return the text response
        return result.response.text();
    } catch (err) {
        console.error("Gemini API Error:", err);
        throw new Error("Gemini API Error: " + err.message);
    }
};

/**
 * Generate a response to a chat conversation using the Gemini AI model.
 * @param {Array} messages - Array of message objects with role and content
 * @returns {Promise<string>} - The AI-generated response text.
 */
export const generateChatResponse = async (messages) => {
    try {
        // Convert messages to Gemini's expected format
        const formattedMessages = messages.map((msg) => ({
            role: msg.role === "assistant" ? "model" : msg.role,
            parts: [{ text: msg.content }],
        }));

        // Create a chat session
        const chat = model.startChat({
            generationConfig,
            history: formattedMessages.slice(0, -1), // Add all but the last message to history
        });

        // Send the last message to get a response
        const lastMessage = formattedMessages[formattedMessages.length - 1];
        const result = await chat.sendMessage(lastMessage.parts[0].text);

        // Return the text response
        return result.response.text();
    } catch (err) {
        console.error("Gemini API Error in chat response:", err);
        // If there's an issue with chat history, fall back to single message approach
        try {
            console.log("Falling back to single message approach");
            // Get just the last message
            const lastMessage = messages[messages.length - 1];
            return await generateResponse(lastMessage.content);
        } catch (fallbackErr) {
            console.error("Fallback also failed:", fallbackErr);
            throw new Error("Gemini API Error: " + err.message);
        }
    }
};

export default { analyzePaper, generateResponse, generateChatResponse };
