import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const DB_FILE = path.join(process.cwd(), 'db.json');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'super_secret_aes_encryption_key_32';

// Ensure the encryption key is exactly 32 bytes for AES-256
const KEY_BUFFER = Buffer.alloc(32);
const sourceKey = Buffer.from(ENCRYPTION_KEY, 'utf8');
sourceKey.copy(KEY_BUFFER, 0, 0, Math.min(sourceKey.length, 32));

/**
 * Encrypt sensitive plain text using AES-256-GCM.
 */
export function encryptData(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12); // Standard IV size for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY_BUFFER, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  // Format: iv:authTag:encryptedData
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt data using AES-256-GCM.
 */
export function decryptData(encryptedText) {
  if (!encryptedText) return '';
  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      return '[Decryption Error: Invalid format]';
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY_BUFFER, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption failed:', error);
    return '[Decryption Error: Decryption failed. Verify key validity]';
  }
}

// Helper to initialize and read db.json
function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = { conversations: [], messages: [], drafts: [], auditLogs: [] };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  try {
    const content = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.error('Error reading db.json, returning empty structure:', e);
    return { conversations: [], messages: [], drafts: [], auditLogs: [] };
  }
}

// Helper to save db.json
function writeDb(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error writing db.json:', e);
  }
}

export const db = {
  // --- CONVERSATIONS ---
  async getConversations() {
    const data = readDb();
    return data.conversations;
  },

  async findOrCreateConversation(whatsappChatId, contactName) {
    const data = readDb();
    let conversation = data.conversations.find(c => c.whatsappChatId === whatsappChatId);
    
    if (!conversation) {
      // Create a masked contact name for compliance if not provided
      const maskedName = contactName || `User_${crypto.randomBytes(3).toString('hex')}`;
      conversation = {
        id: crypto.randomUUID(),
        whatsappChatId,
        contactNameMasked: maskedName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      data.conversations.push(conversation);
      writeDb(data);
    }
    return conversation;
  },

  async getConversationById(id) {
    const data = readDb();
    return data.conversations.find(c => c.id === id);
  },

  // --- MESSAGES ---
  async getMessagesByConversation(conversationId, limit = 10) {
    const data = readDb();
    const filtered = data.messages
      .filter(m => m.conversationId === conversationId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    return filtered.slice(-limit);
  },

  async saveMessage({ conversationId, senderId, direction, encryptedBody }) {
    const data = readDb();
    const message = {
      id: crypto.randomUUID(),
      conversationId,
      senderId,
      direction,
      encryptedBody,
      timestamp: new Date().toISOString()
    };
    
    data.messages.push(message);
    
    // Update conversation's updatedAt
    const conv = data.conversations.find(c => c.id === conversationId);
    if (conv) {
      conv.updatedAt = new Date().toISOString();
    }
    
    writeDb(data);
    return message;
  },

  // --- DRAFTS ---
  async getDrafts() {
    const data = readDb();
    return data.drafts;
  },

  async getDraftById(id) {
    const data = readDb();
    return data.drafts.find(d => d.id === id);
  },

  async getPendingDraftByConversation(conversationId) {
    const data = readDb();
    return data.drafts.find(d => d.conversationId === conversationId && d.status === 'PENDING');
  },

  async saveDraft({ conversationId, triggerMessageId, suggestedContent, interventionRequired = true }) {
    const data = readDb();
    
    // Deactivate any existing pending draft for this conversation
    data.drafts = data.drafts.map(d => {
      if (d.conversationId === conversationId && d.status === 'PENDING') {
        return { ...d, status: 'REJECTED' };
      }
      return d;
    });

    const draft = {
      id: crypto.randomUUID(),
      conversationId,
      triggerMessageId,
      suggestedContent,
      interventionRequired,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };
    
    data.drafts.push(draft);
    writeDb(data);
    return draft;
  },

  async updateDraftStatus(id, status) {
    const data = readDb();
    const draftIndex = data.drafts.findIndex(d => d.id === id);
    if (draftIndex !== -1) {
      data.drafts[draftIndex].status = status;
      writeDb(data);
      return data.drafts[draftIndex];
    }
    return null;
  },

  // --- AUDIT LOGS ---
  async getAuditLogs() {
    const data = readDb();
    return data.auditLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  },

  async writeAuditLog({ userId, actionType, draftId, wasModified }) {
    const data = readDb();
    const auditLog = {
      id: crypto.randomUUID(),
      userId,
      actionType,
      draftId,
      wasModified,
      timestamp: new Date().toISOString()
    };
    data.auditLogs.push(auditLog);
    writeDb(data);
    return auditLog;
  }
};
