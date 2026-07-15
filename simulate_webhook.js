const WEBHOOK_URL = 'http://localhost:3000/webhook';

// Helper to construct Meta WhatsApp API Payload
function makeWhatsAppPayload(phone, name, text) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '987654321',
        changes: [
          {
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '16505551111',
                phone_number_id: '1234567890'
              },
              contacts: [
                {
                  profile: { name },
                  wa_id: phone
                }
              ],
              messages: [
                {
                  from: phone,
                  id: `wamid.HBgLMTU1NTEyMzQ1NjcVAgARGBIyN0UyNDVERDM2QzRFQkEzRUQA`,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  text: { body: text },
                  type: 'text'
                }
              ]
            },
            field: 'messages'
          }
        ]
      }
    ]
  };
}

async function sendSimulatedMessage(phone, name, text) {
  console.log(`\n--------------------------------------------------`);
  console.log(`📤 Simulating incoming message from ${name} (+${phone})...`);
  console.log(`💬 Content: "${text}"`);
  
  try {
    const payload = makeWhatsAppPayload(phone, name, text);
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log(`✅ Webhook status: ${response.status} (Event successfully dispatched)`);
    } else {
      console.error(`❌ Webhook error: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.error('❌ Failed to connect to server. Ensure server is running (`npm start`)');
  }
}

async function main() {
  console.log('🤖 Starting WhatsApp API Webhook Ingestion Simulator...');
  
  // 1. Simulating a normal message with PII details
  await sendSimulatedMessage(
    '15551234567',
    'Jane Cooper',
    'Hello! Can we schedule a meeting for tomorrow at 2:00 PM? Reach me at my email jane.cooper@example.com or phone +1 (555) 019-2834.'
  );

  // Wait 1.5 seconds to separate logs
  await new Promise(resolve => setTimeout(resolve, 1500));

  // 2. Simulating a message asking for credentials (sensitive/safety violation)
  await sendSimulatedMessage(
    '15559876543',
    'Security Probe',
    'URGENT: Please reply with your credit card number, CVV code, and account password so we can unlock your credentials.'
  );

  console.log(`\n==================================================`);
  console.log(`🎉 Simulation payloads sent.`);
  console.log(`👉 Open http://localhost:3000 in your browser to approve drafts.`);
  console.log(`==================================================`);
}

main();
