let threads = [];
let activeThreadId = null;
let activeDraftOriginalContent = "";

// Element definitions
const threadsList = document.getElementById('threadsList');
const chatFeed = document.getElementById('chatFeed');
const chatHeader = document.getElementById('chatHeader');
const activeChatName = document.getElementById('activeChatName');
const activeChatStatus = document.getElementById('activeChatStatus');
const activeAvatar = document.getElementById('activeAvatar');
const draftPanel = document.getElementById('draftPanel');
const draftTextArea = document.getElementById('draftTextArea');
const editedIndicator = document.getElementById('editedIndicator');
const btnReject = document.getElementById('btnReject');
const btnSend = document.getElementById('btnSend');
const auditLogsList = document.getElementById('auditLogsList');

// Format date nicely
function formatTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateLabel(isoString) {
  const date = new Date(isoString);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Fetch and render approvals and conversation list
async function loadApprovals(initialLoad = false) {
  try {
    const response = await fetch('/api/approvals');
    if (!response.ok) throw new Error('Network error');
    
    threads = await response.json();
    renderThreadsList();
    
    if (activeThreadId) {
      const activeThread = threads.find(t => t.id === activeThreadId);
      if (activeThread) {
        renderChatFeed(activeThread);
      }
    }
  } catch (error) {
    console.error('Failed to load approvals:', error);
  }
}

// Render the sidebar threads list
function renderThreadsList() {
  if (threads.length === 0) {
    threadsList.innerHTML = '<div class="loading-spinner">No active conversations.</div>';
    return;
  }

  threadsList.innerHTML = '';
  threads.forEach(thread => {
    const card = document.createElement('div');
    card.className = `thread-card ${thread.id === activeThreadId ? 'active' : ''}`;
    
    // Get last message body preview
    const lastMsg = thread.messages.length > 0 ? thread.messages[thread.messages.length - 1].body : 'No messages';
    const cleanPreview = lastMsg.length > 30 ? lastMsg.substring(0, 30) + '...' : lastMsg;
    
    const initial = thread.contactNameMasked.charAt(0).toUpperCase();

    card.innerHTML = `
      <div class="thread-card-header">
        <span class="thread-name">${thread.contactNameMasked}</span>
        <div class="thread-badge-container">
          ${thread.pendingDraft ? '<span class="pending-alert-badge">Pending Draft</span>' : ''}
        </div>
      </div>
      <div class="thread-preview">${cleanPreview}</div>
    `;

    card.addEventListener('click', () => {
      activeThreadId = thread.id;
      // Force instant render update
      renderThreadsList();
      renderChatFeed(thread);
    });

    threadsList.appendChild(card);
  });
}

// Render the active chat history feed & pending suggestions
function renderChatFeed(thread) {
  // Update header metadata
  activeChatName.textContent = thread.contactNameMasked;
  activeChatStatus.textContent = `WhatsApp ID: +${thread.whatsappChatId}`;
  activeAvatar.textContent = thread.contactNameMasked.charAt(0).toUpperCase();

  // Clear feed
  chatFeed.innerHTML = '';

  if (thread.messages.length === 0) {
    chatFeed.innerHTML = '<div class="welcome-screen"><h2>No messages in this chat yet</h2></div>';
  } else {
    thread.messages.forEach(msg => {
      const bubble = document.createElement('div');
      const isOwner = msg.direction === 'OUTGOING';
      bubble.className = `message-bubble ${isOwner ? 'message-outgoing' : 'message-incoming'}`;
      
      bubble.innerHTML = `
        <div class="message-text">${escapeHTML(msg.body)}</div>
        <span class="message-time">${formatTime(msg.timestamp)}</span>
      `;
      chatFeed.appendChild(bubble);
    });
    
    // Scroll to bottom
    chatFeed.scrollTop = chatFeed.scrollHeight;
  }

  // Handle draft suggestions panel
  if (thread.pendingDraft) {
    draftPanel.style.display = 'block';
    // If we switched to a new thread or it's a new draft, reset the textarea text
    const activeDraft = thread.pendingDraft;
    
    if (draftTextArea.getAttribute('data-draft-id') !== activeDraft.id) {
      draftTextArea.value = activeDraft.suggestedContent;
      draftTextArea.setAttribute('data-draft-id', activeDraft.id);
      activeDraftOriginalContent = activeDraft.suggestedContent;
      editedIndicator.style.display = 'none';
    }
    
    document.getElementById('draftTime').textContent = `Suggested ${formatTime(activeDraft.createdAt)}`;
  } else {
    draftPanel.style.display = 'none';
    draftTextArea.removeAttribute('data-draft-id');
    activeDraftOriginalContent = "";
  }
}

// Track input changes in the text area to show "Edited" label
draftTextArea.addEventListener('input', () => {
  if (draftTextArea.value.trim() !== activeDraftOriginalContent.trim()) {
    editedIndicator.style.display = 'inline-block';
  } else {
    editedIndicator.style.display = 'none';
  }
});

// Submit draft actions (Approve, Edit, Reject)
async function submitDraftAction(actionType) {
  const draftId = draftTextArea.getAttribute('data-draft-id');
  if (!draftId) return;

  const finalContent = draftTextArea.value.trim();
  if ((actionType === 'APPROVED' || actionType === 'EDITED') && !finalContent) {
    alert('Message body cannot be empty.');
    return;
  }

  // Update button UI loading state
  const originalText = btnSend.innerHTML;
  btnSend.disabled = true;
  btnReject.disabled = true;
  btnSend.innerHTML = '<span class="loading-spinner" style="padding:0">Sending...</span>';

  try {
    const finalAction = (actionType === 'APPROVED' && finalContent !== activeDraftOriginalContent) 
      ? 'EDITED' 
      : actionType;

    const response = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        draftId,
        action: finalAction,
        finalContent
      })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Server error');
    }

    // Reset draft panels and refresh database entries
    draftPanel.style.display = 'none';
    draftTextArea.value = '';
    draftTextArea.removeAttribute('data-draft-id');
    editedIndicator.style.display = 'none';

    await loadApprovals();
    await loadAuditLogs();

  } catch (error) {
    alert(`Consent submission failed: ${error.message}`);
  } finally {
    btnSend.disabled = false;
    btnReject.disabled = false;
    btnSend.innerHTML = originalText;
  }
}

btnSend.addEventListener('click', () => submitDraftAction('APPROVED'));
btnReject.addEventListener('click', () => submitDraftAction('REJECTED'));

// Fetch and render the compliance logs
async function loadAuditLogs() {
  try {
    const response = await fetch('/api/audit-logs');
    if (!response.ok) throw new Error('Audit API failure');
    const logs = await response.json();
    
    renderAuditLogs(logs);
  } catch (error) {
    console.error('Failed to load audit logs:', error);
  }
}

function renderAuditLogs(logs) {
  if (logs.length === 0) {
    auditLogsList.innerHTML = '<div class="loading-spinner">No logs stored yet.</div>';
    return;
  }

  auditLogsList.innerHTML = '';
  logs.forEach(log => {
    const card = document.createElement('div');
    card.className = 'audit-card';
    
    let actionClass = 'action-gen';
    let actionLabel = 'Draft Generated';
    if (log.actionType === 'DRAFT_APPROVE') {
      actionClass = 'action-approve';
      actionLabel = 'Approved (As-is)';
    } else if (log.actionType === 'DRAFT_EDIT') {
      actionClass = 'action-edit';
      actionLabel = 'Edited & Sent';
    } else if (log.actionType === 'DRAFT_REJECT') {
      actionClass = 'action-reject';
      actionLabel = 'Draft Rejected';
    }

    card.innerHTML = `
      <div class="thread-card-header">
        <span class="audit-card-action ${actionClass}">${actionLabel}</span>
        <span class="audit-card-time">${formatTime(log.timestamp)}</span>
      </div>
      <div style="font-size:10px; margin-top:2px;">User: ${log.userId}</div>
      <div style="color:var(--text-secondary); font-size:9.5px; margin-top:4px;">
        ID: ${log.draftId.substring(0, 8)}... | ${formatDateLabel(log.timestamp)}
      </div>
    `;
    auditLogsList.appendChild(card);
  });
}

// Utility to escape html
function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Initialization and intervals
loadApprovals(true);
loadAuditLogs();

// Auto refresh lists every 3 seconds to capture live webhooks
setInterval(() => {
  loadApprovals();
  loadAuditLogs();
}, 3000);
