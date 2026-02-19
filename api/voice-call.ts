// ============================================
// API: /api/voice-call.ts
// Deploy to: pure-dispatch-landing/api/voice-call.ts
// ============================================
// Initiates voice calls to brokers using Twilio.
// Generates AI call scripts personalized to the carrier+broker.
//
//   POST action=initiate      → Place a call to a broker
//   POST action=generate-script → Generate a call script (preview)
//   GET  ?action=call-history  → Get call logs
// ============================================

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import twilio from 'twilio';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''
);

function getUserId(req: VercelRequest): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.split(' ')[1];
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET || process.env.SUPABASE_JWT_SECRET || '');
    return decoded.sub || decoded.user_id || decoded.userId || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// Call Script Generator
// ─────────────────────────────────────────────
function generateCallScript(carrier: any, broker: any): {
  greeting: string;
  introduction: string;
  pitch: string;
  closing: string;
  full_script: string;
  twiml: string;
} {
  const carrierName = carrier.owner_name || carrier.company_name || 'an owner-operator';
  const company = carrier.company_name || '';
  const equipment = (carrier.equipment_types || ['dry van'])[0]?.replace(/_/g, ' ') || 'dry van';
  const homeArea = carrier.home_base_city && carrier.home_base_state
    ? `${carrier.home_base_city}, ${carrier.home_base_state}`
    : 'the area';
  const lanes = (carrier.preferred_lanes || []).join(', ') || 'flexible routes';
  const mc = carrier.mc_number || '';
  const brokerCompany = broker.company_name || 'your company';
  const brokerContact = broker.contact_name || 'dispatch';

  const greeting = `Hi, may I speak with ${brokerContact}?`;
  const introduction = `My name is ${carrierName}${company ? ` with ${company}` : ''}. I'm an owner-operator running a ${equipment} out of ${homeArea}.`;
  const pitch = `I'm looking to establish a relationship with ${brokerCompany}. I run ${lanes} regularly and I'm very reliable — always on time, communicate well, and my MC number ${mc} is clean and verifiable. I'd love to get on your carrier list if you have any freight that would be a good fit.`;
  const closing = `Can I send you my packet? What email should I use? And is there a specific contact person I should follow up with? I appreciate your time.`;

  const full_script = `${greeting}\n\n${introduction}\n\n${pitch}\n\n${closing}`;

  // TwiML for Twilio (text-to-speech version)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna" language="en-US">${greeting}</Say>
  <Pause length="2"/>
  <Say voice="Polly.Joanna" language="en-US">${introduction}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">${pitch}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">${closing}</Say>
</Response>`;

  return { greeting, introduction, pitch, closing, full_script, twiml };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const action = req.query.action || req.body?.action;

    switch (action) {
      // ═══════════════════════════════════════
      // GENERATE SCRIPT — Preview call script
      // ═══════════════════════════════════════
      case 'generate-script': {
        const { broker_id } = req.body;
        if (!broker_id) return res.status(400).json({ error: 'broker_id required' });

        const { data: carrier } = await supabase
          .from('carrier_profiles')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (!carrier) return res.status(400).json({ error: 'Carrier profile required' });

        const { data: broker } = await supabase
          .from('brokers')
          .select('*')
          .eq('id', broker_id)
          .eq('carrier_id', userId)
          .single();

        if (!broker) return res.status(404).json({ error: 'Broker not found' });

        const script = generateCallScript(carrier, broker);
        return res.status(200).json({ script });
      }

      // ═══════════════════════════════════════
      // INITIATE CALL — Place a call via Twilio
      // ═══════════════════════════════════════
      case 'initiate': {
        const { broker_id } = req.body;
        if (!broker_id) return res.status(400).json({ error: 'broker_id required' });

        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        const fromNumber = process.env.TWILIO_FROM_NUMBER;

        // Get carrier and broker
        const { data: carrier } = await supabase
          .from('carrier_profiles')
          .select('*')
          .eq('user_id', userId)
          .single();

        const { data: broker } = await supabase
          .from('brokers')
          .select('*')
          .eq('id', broker_id)
          .eq('carrier_id', userId)
          .single();

        if (!carrier) return res.status(400).json({ error: 'Carrier profile required' });
        if (!broker) return res.status(404).json({ error: 'Broker not found' });
        if (!broker.phone) return res.status(400).json({ error: 'Broker has no phone number on file' });

        // DEV MODE — no Twilio keys
        if (!accountSid || !authToken || !fromNumber) {
          const script = generateCallScript(carrier, broker);
          console.log(`[VOICE DEV MODE] Would call ${broker.phone}`);
          console.log(script.full_script);

          // Log the "call" attempt
          await supabase.from('outreach_campaigns').insert({
            carrier_id: userId,
            broker_id,
            campaign_type: 'cold_outreach',
            subject: `Call to ${broker.company_name}`,
            body_text: script.full_script,
            method: 'call',
            status: 'sent',
            sequence_step: 1,
            scheduled_at: new Date().toISOString(),
            sent_at: new Date().toISOString(),
            error_message: 'DEV MODE — no actual call placed',
          });

          return res.status(200).json({
            success: true,
            dev_mode: true,
            message: `DEV MODE: Call script generated for ${broker.company_name}. No actual call placed.`,
            script,
          });
        }

        // PRODUCTION MODE — place actual call
        const script = generateCallScript(carrier, broker);
        const client = twilio(accountSid, authToken);

        const call = await client.calls.create({
          twiml: script.twiml,
          to: broker.phone,
          from: fromNumber,
        });

        // Log the call
        await supabase.from('outreach_campaigns').insert({
          carrier_id: userId,
          broker_id,
          campaign_type: 'cold_outreach',
          subject: `Call to ${broker.company_name}`,
          body_text: script.full_script,
          method: 'call',
          status: 'sent',
          sequence_step: 1,
          scheduled_at: new Date().toISOString(),
          sent_at: new Date().toISOString(),
        });

        // Update broker
        await supabase.from('brokers').update({
          last_contact_date: new Date().toISOString(),
          total_outreach_attempts: (broker.total_outreach_attempts || 0) + 1,
          outreach_status: broker.outreach_status === 'new' ? 'contacted' : broker.outreach_status,
        }).eq('id', broker_id);

        return res.status(200).json({
          success: true,
          call_sid: call.sid,
          message: `Calling ${broker.company_name} at ${broker.phone}`,
        });
      }

      // ═══════════════════════════════════════
      // CALL HISTORY
      // ═══════════════════════════════════════
      case 'call-history': {
        const { data, error } = await supabase
          .from('outreach_campaigns')
          .select('*, broker:brokers(company_name, phone)')
          .eq('carrier_id', userId)
          .eq('method', 'call')
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) throw error;
        return res.status(200).json({ calls: data });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    console.error('[Voice Call API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
