import dotenv from 'dotenv';
import { db, decryptData } from './db.js';

dotenv.config();

/**
 * Clean text of common PII patterns (Emails, Phones, Credit Cards).
 */
export function redactPII(text) {
  if (!text) return '';
  let cleaned = text;
  // Redact Emails
  cleaned = cleaned.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]');
  // Redact Phone numbers
  cleaned = cleaned.replace(/(?:\+?\d{1,3}[ -]?)?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4}/g, '[PHONE_REDACTED]');
  // Redact Credit Cards
  cleaned = cleaned.replace(/\b(?:\d[ -]?){13,16}\b/g, '[CARD_REDACTED]');
  return cleaned;
}

/**
 * Proactively check if the message prompts for sensitive credentials/secrets.
 * Employs local guardrail refuser to avoid sharing highly sensitive details.
 */
export function checkSafetyRejection(text) {
  const lower = text.toLowerCase();
  const violations = [
    { keys: ['password', 'pass code', 'pin number'], name: 'passwords' },
    { keys: ['credit card', 'debit card', 'cvv', 'card expiration'], name: 'payment credentials' },
    { keys: ['social security', 'ssn', 'tax id'], name: 'government identification' },
    { keys: ['private key', 'secret key', 'mnemonic', 'passphrase'], name: 'cryptographic keys' }
  ];

  for (const rule of violations) {
    if (rule.keys.some(k => lower.includes(k))) {
      return `I am sorry, but I cannot share sensitive information such as ${rule.name} over chat. Please reach out to me via a secure channel.`;
    }
  }
  return null;
}

/**
 * Generate a mock draft if no API key is present.
 */
function getMockDraft(text) {
  const lower = text.toLowerCase();
  
  if (lower.includes('free') || lower.includes('schedule') || lower.includes('tomorrow') || lower.includes('meet')) {
    return '[MOCK DRAFT] Hi! Thanks for reaching out. Yes, I should be free to connect tomorrow. What time works best for you?';
  }
  if (lower.includes('price') || lower.includes('cost') || lower.includes('how much') || lower.includes('rate')) {
    return '[MOCK DRAFT] Thank you for the inquiry. I will check on our current rates and send you a formal quote shortly.';
  }
  if (lower.includes('help') || lower.includes('support') || lower.includes('issue') || lower.includes('error')) {
    return '[MOCK DRAFT] I am sorry to hear you are having issues. Could you please share more details or a screenshot so I can look into it?';
  }
  return '[MOCK DRAFT] Hi! Thanks for your message. I have received it and will follow up with you as soon as I am online.';
}

/**
 * Evaluate if a conversation requires human intervention before dispatching.
 */
export function shouldRequireIntervention(incomingText, draftText, isSafetyRefusal) {
  if (isSafetyRefusal) return true;

  const lowerIncoming = (incomingText || '').toLowerCase();
  const lowerDraft = (draftText || '').toLowerCase();

  // 1. Pricing and Transactions
  const pricingKeywords = ['price', 'cost', 'how much', 'rate', 'quote', 'charge', 'fee', 'payment', 'billing', 'usd'];
  const pricingPatterns = [/[$€£₹]/, /\d+\s*(dollars|euros|pounds|rupees|rs)/i];
  
  const hasPricingKeyword = pricingKeywords.some(kw => lowerIncoming.includes(kw) || lowerDraft.includes(kw));
  const hasPricingPattern = pricingPatterns.some(pat => pat.test(lowerIncoming) || pat.test(lowerDraft));
  
  if (hasPricingKeyword || hasPricingPattern) {
    return true;
  }

  // 2. Urgent Escalations
  const urgentKeywords = ['urgent', 'cancel', 'refund', 'broken', 'error', 'failed', 'fail', 'emergency', 'stop'];
  const hasUrgency = urgentKeywords.some(kw => lowerIncoming.includes(kw));
  
  if (hasUrgency) {
    return true;
  }

  return false;
}

/**
 * Core draft generator workflow.
 */
export async function generateReplyDraft(conversationId, incomingMessageId, rawMessageText) {
  // 1. Safety Guardrails Check
  const safetyRefusal = checkSafetyRejection(rawMessageText);
  if (safetyRefusal) {
    console.log(`[Safety Guardrail] Sensitive input detected. Yielding refusal pattern.`);
    return await db.saveDraft({
      conversationId,
      triggerMessageId: incomingMessageId,
      suggestedContent: safetyRefusal,
      interventionRequired: true
    });
  }

  // 2. Context Ingestion
  const recentMessages = await db.getMessagesByConversation(conversationId, 10);
  
  // Decrypt and redact each message for the context window
  const contextHistory = recentMessages.map(msg => {
    const rawBody = decryptData(msg.encryptedBody);
    const redactedBody = redactPII(rawBody);
    const speaker = msg.direction === 'INCOMING' ? 'Client' : 'Owner';
    return `${speaker}: ${redactedBody}`;
  }).join('\n');

  // 3. Draft Generation
  const apiKey = process.env.GEMINI_API_KEY;
  let draftedReply = '';

  if (!apiKey) {
    console.warn('[Warning] GEMINI_API_KEY is not configured. Falling back to rule-based mock draft.');
    draftedReply = getMockDraft(rawMessageText);
  } else {
    try {
      const prompt = `
You are a messaging assistant helping a business owner draft a WhatsApp reply.
You draft responses ON BEHALF OF THE OWNER.
Keep the reply brief, helpful, and natural. Do not make promises or share credentials.
Maintain absolute privacy and confidentiality.

CONVERSATION HISTORY:
${contextHistory}

INSTRUCTIONS:
Provide ONLY the text of the drafted response to the Client's last message. No explanations, no markdown formatting.
`;

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 250
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Gemini API returned status ${response.status}`);
      }

      const resJson = await response.json();
      const outputText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (outputText) {
        draftedReply = outputText.trim();
      } else {
        throw new Error('Empty response from Gemini API');
      }
    } catch (error) {
      console.error('[Error] Gemini API generation failed, falling back to mock:', error);
      draftedReply = getMockDraft(rawMessageText);
    }
  }

  // Determine if human review is needed
  const interventionRequired = shouldRequireIntervention(rawMessageText, draftedReply, false);

  // 4. Save Draft to DB
  return await db.saveDraft({
    conversationId,
    triggerMessageId: incomingMessageId,
    suggestedContent: draftedReply,
    interventionRequired
  });
}
