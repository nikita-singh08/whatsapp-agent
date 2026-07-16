import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { db, encryptData, decryptData } from './db.js';
import { generateReplyDraft } from './replyGenerator.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('public'));

// Configure express.json to capture the raw body during parsing
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

/**
 * Verify Meta/WhatsApp webhook signature using App Secret
 */
function verifySignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (!appSecret) {
    console.warn('[Webhook] WHATSAPP_APP_SECRET is not configured. Webhook signature check bypassed (Development mode).');
    return true;
  }

  if (!signature) {
    console.error('[Webhook] Missing x-hub-signature-256 header.');
    return false;
  }

  const parts = signature.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') {
    console.error('[Webhook] Invalid signature format.');
    return false;
  }

  const expectedHash = crypto
    .createHmac('sha256', appSecret)
    .update(req.rawBody || '')
    .digest('hex');

  const incomingHash = parts[1];
  
  // Use timingSafeEqual to prevent timing attacks
  const expectedBuf = Buffer.from(expectedHash, 'hex');
  const incomingBuf = Buffer.from(incomingHash, 'hex');

  if (expectedBuf.length !== incomingBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, incomingBuf);
}

/**
 * Dispatch outbound message through WhatsApp Gateway (or mock it if keys are missing)
 */
async function dispatchOutgoingMessage(conversation, content) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const sysToken = process.env.WHATSAPP_SYSTEM_ACCESS_TOKEN;

  // Mock Gateway execution if keys are default or empty
  if (!sysToken || sysToken.startsWith('mock_') || !phoneId || phoneId === '1234567890') {
    console.log(`[WhatsApp API Mock] Outgoing text sent to +${conversation.whatsappChatId} successfully (Mock mode).`);
    console.log(`[WhatsApp API Mock Payload]: "${content}"`);
  } else {
    // Official API execution
    const response = await fetch(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${sysToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: conversation.whatsappChatId,
        type: 'text',
        text: { body: content }
      })
    });

    if (!response.ok) {
      const errDetail = await response.text();
      throw new Error(`WhatsApp API responded with status ${response.status}: ${errDetail}`);
    }
    console.log(`[WhatsApp Cloud API] Message sent to +${conversation.whatsappChatId}.`);
  }

  // Save outgoing message to database
  return await db.saveMessage({
    conversationId: conversation.id,
    senderId: 'SYSTEM_OWNER',
    direction: 'OUTGOING',
    encryptedBody: encryptData(content)
  });
}


/**
 * 1. Webhook Verification (WhatsApp setup challenge)
 */
app.get('/webhook', (req, res) => {
  console.log("\n===== Incoming Webhook (GET Verification) =====");
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.url}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Query Params:", JSON.stringify(req.query, null, 2));

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const localVerifyToken = process.env.WEBHOOK_VERIFY_TOKEN || 'whatsapp_assistant_verify_token_123';

  if (mode && token) {
    if (mode === 'subscribe' && token === localVerifyToken) {
      console.log('[Webhook Decision] webhook verification: successful');
      return res.status(200).send(challenge);
    } else {
      console.warn('[Webhook Decision] webhook verification: verification token mismatch');
      return res.status(403).send('Forbidden');
    }
  }
  console.warn('[Webhook Decision] webhook verification: invalid query format');
  return res.status(400).send('Bad Request');
});

/**
 * 2. Webhook Ingestion
 */
app.post('/webhook', async (req, res) => {
  console.log("\n===== Incoming Webhook (POST Ingestion) =====");
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.url}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Raw Body:", req.rawBody);
  console.log("Parsed Body:", JSON.stringify(req.body, null, 2));

  try {
    console.log(`[Webhook Decision] webhook received`);

    // Validate signature if WHATSAPP_APP_SECRET is configured
    const isSigValid = verifySignature(req);
    console.log(`[Webhook Decision] signature valid: ${isSigValid}`);
    if (!isSigValid) {
      console.warn('[Webhook] Signature verification failed.');
      return res.status(401).send('Signature verification failed');
    }

    const body = req.body;

    // Check if it's a valid WhatsApp message event
    if (!body || body.object !== 'whatsapp_business_account') {
      console.log(`[Webhook Decision] object verified: false (Received object: ${body?.object})`);
      // Return 200 to prevent WhatsApp from retrying irrelevant notifications
      return res.status(200).send('Non-WhatsApp payload');
    }
    console.log(`[Webhook Decision] object verified: true`);

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObject = value?.messages?.[0];

    if (!messageObject) {
      console.log(`[Webhook Decision] message found: false`);
      return res.status(200).send('No message event');
    }
    console.log(`[Webhook Decision] message found: true`);

    const whatsappChatId = messageObject.from; // Sender phone number
    const contactName = value?.contacts?.[0]?.profile?.name || `User_${whatsappChatId.slice(-4)}`;
    
    let messageText = '';
    if (messageObject.type === 'text') {
      messageText = messageObject.text.body;
    } else {
      messageText = `[Received media type: ${messageObject.type}]`;
    }

    console.log(`[Webhook] Incoming message from ${contactName} (${whatsappChatId}): "${messageText}"`);

    // Ingest Context Ephemerally
    const conversation = await db.findOrCreateConversation(whatsappChatId, contactName);
    const savedMsg = await db.saveMessage({
      conversationId: conversation.id,
      senderId: whatsappChatId,
      direction: 'INCOMING',
      encryptedBody: encryptData(messageText)
    });

    console.log(`[Webhook Decision] draft generation started`);
    // Asynchronously draft the reply to reply fast (WhatsApp gateway requires 200 OK within seconds)
    generateReplyDraft(conversation.id, savedMsg.id, messageText)
      .then(async draft => {
        console.log(`[Drafting] Successfully created draft response for conversation: ${conversation.id}`);
        
        if (!draft.interventionRequired) {
          console.log(`[Auto-Pilot] Auto-sending routine response for ${conversation.contactNameMasked}.`);
          try {
            await dispatchOutgoingMessage(conversation, draft.suggestedContent);
            await db.updateDraftStatus(draft.id, 'AUTO_SENT');
            await db.writeAuditLog({
              userId: 'AUTO_PILOT',
              actionType: 'AUTO_SENT',
              draftId: draft.id,
              wasModified: false
            });
            console.log(`[Auto-Pilot] Routine reply automatically dispatched and logged.`);
          } catch (err) {
            console.error(`[Auto-Pilot] Failed to auto-dispatch message:`, err);
          }
        } else {
          console.log(`[Human In The Loop] Action required. Draft held for manual review.`);
        }
      })
      .catch(err => {
        console.error(`[Drafting] Failed to generate draft for conversation ${conversation.id}:`, err);
      });

    console.log(`[Webhook Decision] response sent (EVENT_RECEIVED)`);
    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('[Webhook] Ingestion error:', error);
    return res.status(500).send('Internal Server Error');
  }
});

/**
 * 3. Dashboard API: Fetch active conversations and pending drafts
 */
app.get('/api/approvals', async (req, res) => {
  try {
    const conversations = await db.getConversations();
    const payload = [];

    for (const conv of conversations) {
      const messages = await db.getMessagesByConversation(conv.id, 20);
      const pendingDraft = await db.getPendingDraftByConversation(conv.id);

      // Decrypt message bodies for visualization
      const decryptedMessages = messages.map(m => ({
        id: m.id,
        senderId: m.senderId,
        direction: m.direction,
        body: decryptData(m.encryptedBody),
        timestamp: m.timestamp
      }));

      payload.push({
        id: conv.id,
        whatsappChatId: conv.whatsappChatId,
        contactNameMasked: conv.contactNameMasked,
        updatedAt: conv.updatedAt,
        messages: decryptedMessages,
        pendingDraft: pendingDraft ? {
          id: pendingDraft.id,
          suggestedContent: pendingDraft.suggestedContent,
          interventionRequired: pendingDraft.interventionRequired,
          createdAt: pendingDraft.createdAt
        } : null
      });
    }

    // Sort by recent update activity
    payload.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return res.json(payload);
  } catch (error) {
    console.error('Failed fetching approvals:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * 4. Dashboard API: Submit consent (Approve, Edit, Reject)
 */
app.post('/api/approve', async (req, res) => {
  const { draftId, action, finalContent } = req.body;

  if (!draftId || !action || !['APPROVED', 'EDITED', 'REJECTED'].includes(action)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  try {
    const draft = await db.getDraftById(draftId);
    if (!draft || draft.status !== 'PENDING') {
      return res.status(400).json({ error: 'Draft not found or already processed' });
    }

    const conversation = await db.getConversationById(draft.conversationId);
    const wasModified = action === 'EDITED';

    if (action === 'APPROVED' || action === 'EDITED') {
      console.log(`[Consent] Outgoing message approved for ${conversation.contactNameMasked}. Dispatching payload.`);
      await dispatchOutgoingMessage(conversation, finalContent);
    } else {
      console.log(`[Consent] Draft rejected for ${conversation.contactNameMasked}.`);
    }

    // Update Draft Status in database
    await db.updateDraftStatus(draftId, action);

    // Write to audit logs
    const actionType = action === 'APPROVED' ? 'DRAFT_APPROVE' : (action === 'EDITED' ? 'DRAFT_EDIT' : 'DRAFT_REJECT');
    await db.writeAuditLog({
      userId: 'PRIMARY_OWNER',
      actionType,
      draftId,
      wasModified
    });

    return res.json({ success: true, message: `Draft processed with action: ${action}` });
  } catch (error) {
    console.error('Failed submitting draft approval:', error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
});

/**
 * 5. Dashboard API: Fetch Audit logs
 */
app.get('/api/audit-logs', async (req, res) => {
  try {
    const logs = await db.getAuditLogs();
    return res.json(logs);
  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 AI WhatsApp Assistant Running at http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
