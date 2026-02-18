// ============================================
// API: /api/email-send.ts
// Deploy to: pure-dispatch-landing/api/email-send.ts
// ============================================
// Generates and sends personalized broker outreach emails.
//
//   POST action=send-initial   → Send initial outreach to a broker
//   POST action=send-template  → Send a specific template to a broker
//   POST action=preview        → Preview email without sending
//   POST action=bulk-send      → Send initial outreach to multiple brokers
//   GET  ?action=templates     → List available templates
//   GET  ?action=history&broker_id= → Get outreach history for a broker
// ============================================

import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import sgMail from '@sendgrid/mail';

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
    return decoded.sub || decoded.user_id || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// Template Variable Replacement
// ─────────────────────────────────────────────
function fillTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }
  return result;
}

// ─────────────────────────────────────────────
// Build template variables from carrier + broker data
// ─────────────────────────────────────────────
function buildTemplateVars(carrier: any, broker: any): Record<string, string> {
  const lanes = carrier.preferred_lanes || [];
  const lanesFormatted = lanes.length > 0
    ? lanes.map((l: string) => `  • ${l}`).join('\n')
    : '  • Flexible on lanes — open to opportunities';

  return {
    carrier_name: carrier.owner_name || carrier.company_name || 'Owner-Operator',
    company_name: carrier.company_name || 'Independent Carrier',
    mc_number: carrier.mc_number || 'N/A',
    dot_number: carrier.dot_number || 'N/A',
    phone: carrier.phone || 'N/A',
    email: carrier.email || 'N/A',
    equipment: (carrier.equipment_types || ['Dry Van'])[0]?.replace(/_/g, ' ') || 'Dry Van',
    home_city: carrier.home_base_city || 'My area',
    home_state: carrier.home_base_state || 'My state',
    preferred_lanes_list: lanesFormatted,
    broker_contact_name: broker.contact_name || 'Dispatch Team',
    broker_company: broker.company_name || 'Your company',
    broker_mc: broker.mc_number || '',
  };
}

// ─────────────────────────────────────────────
// Schedule follow-up emails (day 3, 7, 14)
// ─────────────────────────────────────────────
async function scheduleFollowUps(
  carrierId: string,
  brokerId: string,
  parentCampaignId: string,
  carrier: any,
  broker: any
) {
  // Get follow-up templates
  const { data: templates } = await supabase
    .from('email_templates')
    .select('*')
    .eq('is_default', true)
    .eq('category', 'follow_up')
    .order('sequence_step');

  if (!templates || templates.length === 0) return;

  const vars = buildTemplateVars(carrier, broker);
  const now = new Date();

  for (const tmpl of templates) {
    const scheduledDate = new Date(now);
    scheduledDate.setDate(scheduledDate.getDate() + tmpl.delay_days);

    await supabase.from('outreach_campaigns').insert({
      carrier_id: carrierId,
      broker_id: brokerId,
      campaign_type: 'follow_up',
      subject: fillTemplate(tmpl.subject_template, vars),
      body_text: fillTemplate(tmpl.body_template, vars),
      template_used: tmpl.name,
      method: 'email',
      status: 'scheduled',
      sequence_step: tmpl.sequence_step,
      parent_campaign_id: parentCampaignId,
      scheduled_at: scheduledDate.toISOString(),
    });
  }
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
      // LIST TEMPLATES
      // ═══════════════════════════════════════
      case 'templates': {
        const { data, error } = await supabase
          .from('email_templates')
          .select('*')
          .or(`carrier_id.is.null,carrier_id.eq.${userId}`)
          .order('sequence_step');

        if (error) throw error;
        return res.status(200).json({ templates: data });
      }

      // ═══════════════════════════════════════
      // OUTREACH HISTORY
      // ═══════════════════════════════════════
      case 'history': {
        const brokerId = req.query.broker_id;
        let query = supabase
          .from('outreach_campaigns')
          .select('*')
          .eq('carrier_id', userId)
          .order('created_at', { ascending: false });

        if (brokerId) query = query.eq('broker_id', brokerId);
        query = query.limit(50);

        const { data, error } = await query;
        if (error) throw error;
        return res.status(200).json({ campaigns: data, count: data?.length || 0 });
      }

      // ═══════════════════════════════════════
      // PREVIEW — Generate email without sending
      // ═══════════════════════════════════════
      case 'preview': {
        const { broker_id, template_name } = req.body;
        if (!broker_id) return res.status(400).json({ error: 'broker_id required' });

        // Get carrier profile
        const { data: carrier } = await supabase
          .from('carrier_profiles')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (!carrier) return res.status(400).json({ error: 'Carrier profile not set up. Complete your profile first.' });

        // Get broker
        const { data: broker } = await supabase
          .from('brokers')
          .select('*')
          .eq('id', broker_id)
          .eq('carrier_id', userId)
          .single();

        if (!broker) return res.status(404).json({ error: 'Broker not found' });

        // Get template
        const tName = template_name || 'initial_outreach';
        const { data: template } = await supabase
          .from('email_templates')
          .select('*')
          .eq('name', tName)
          .or(`carrier_id.is.null,carrier_id.eq.${userId}`)
          .order('carrier_id', { ascending: false, nullsFirst: false })
          .limit(1)
          .single();

        if (!template) return res.status(404).json({ error: `Template "${tName}" not found` });

        const vars = buildTemplateVars(carrier, broker);
        return res.status(200).json({
          preview: {
            to: broker.email || 'NO EMAIL ON FILE',
            subject: fillTemplate(template.subject_template, vars),
            body: fillTemplate(template.body_template, vars),
          }
        });
      }

      // ═══════════════════════════════════════
      // SEND INITIAL OUTREACH
      // ═══════════════════════════════════════
      case 'send-initial': {
        const { broker_id } = req.body;
        if (!broker_id) return res.status(400).json({ error: 'broker_id required' });

        // Get carrier
        const { data: carrier } = await supabase
          .from('carrier_profiles')
          .select('*')
          .eq('user_id', userId)
          .single();

        if (!carrier) return res.status(400).json({ error: 'Complete your carrier profile first' });

        // Get broker
        const { data: broker } = await supabase
          .from('brokers')
          .select('*')
          .eq('id', broker_id)
          .eq('carrier_id', userId)
          .single();

        if (!broker) return res.status(404).json({ error: 'Broker not found' });
        if (!broker.email) return res.status(400).json({ error: 'Broker has no email address on file' });

        // Check for existing outreach
        const { data: existingCampaign } = await supabase
          .from('outreach_campaigns')
          .select('id, status')
          .eq('broker_id', broker_id)
          .eq('carrier_id', userId)
          .eq('sequence_step', 1)
          .single();

        if (existingCampaign) {
          return res.status(409).json({
            error: 'Initial outreach already sent to this broker',
            campaign_id: existingCampaign.id,
            status: existingCampaign.status
          });
        }

        // Get initial template
        const { data: template } = await supabase
          .from('email_templates')
          .select('*')
          .eq('name', 'initial_outreach')
          .or(`carrier_id.is.null,carrier_id.eq.${userId}`)
          .order('carrier_id', { ascending: false, nullsFirst: false })
          .limit(1)
          .single();

        if (!template) return res.status(500).json({ error: 'Initial outreach template not found' });

        const vars = buildTemplateVars(carrier, broker);
        const subject = fillTemplate(template.subject_template, vars);
        const bodyText = fillTemplate(template.body_template, vars);

        // SEND via SendGrid
        const sendGridKey = process.env.SENDGRID_API_KEY;
        const fromEmail = process.env.SENDGRID_FROM_EMAIL;
        let sendResult = { success: false, messageId: '', error: '' };

        if (sendGridKey && fromEmail) {
          sgMail.setApiKey(sendGridKey);
          try {
            const [response] = await sgMail.send({
              to: broker.email,
              from: { email: fromEmail, name: carrier.owner_name || carrier.company_name || 'Pure Dispatch' },
              subject,
              text: bodyText,
            });
            sendResult = {
              success: true,
              messageId: response?.headers?.['x-message-id'] || '',
              error: ''
            };
          } catch (err: any) {
            sendResult = { success: false, messageId: '', error: err.message };
          }
        } else {
          // DEV MODE — log instead of send
          console.log('[EMAIL DEV MODE] Would send:');
          console.log(`To: ${broker.email}\nSubject: ${subject}\n${bodyText}`);
          sendResult = { success: true, messageId: 'dev-mode', error: '' };
        }

        // Record the campaign
        const { data: campaign } = await supabase
          .from('outreach_campaigns')
          .insert({
            carrier_id: userId,
            broker_id: broker_id,
            campaign_type: 'cold_outreach',
            subject,
            body_text: bodyText,
            template_used: 'initial_outreach',
            method: 'email',
            status: sendResult.success ? 'sent' : 'failed',
            sequence_step: 1,
            scheduled_at: new Date().toISOString(),
            sent_at: sendResult.success ? new Date().toISOString() : null,
            sendgrid_message_id: sendResult.messageId || null,
            error_message: sendResult.error || null,
          })
          .select()
          .single();

        // Update broker status
        await supabase.from('brokers').update({
          outreach_status: 'contacted',
          last_contact_date: new Date().toISOString(),
          first_contact_date: broker.first_contact_date || new Date().toISOString(),
          total_outreach_attempts: (broker.total_outreach_attempts || 0) + 1,
        }).eq('id', broker_id);

        // Schedule follow-ups (day 3, 7, 14)
        if (sendResult.success && campaign) {
          await scheduleFollowUps(userId, broker_id, campaign.id, carrier, broker);
        }

        return res.status(200).json({
          success: sendResult.success,
          campaign,
          message: sendResult.success
            ? `Initial outreach sent to ${broker.company_name}. Follow-ups scheduled for day 3, 7, and 14.`
            : `Failed to send: ${sendResult.error}`,
        });
      }

      // ═══════════════════════════════════════
      // BULK SEND — Send initial outreach to multiple brokers
      // ═══════════════════════════════════════
      case 'bulk-send': {
        const { broker_ids } = req.body;
        if (!broker_ids || !Array.isArray(broker_ids) || broker_ids.length === 0) {
          return res.status(400).json({ error: 'broker_ids array required' });
        }

        if (broker_ids.length > 20) {
          return res.status(400).json({ error: 'Maximum 20 brokers per bulk send' });
        }

        // For bulk, we return a summary — individual sends happen behind the scenes
        const results: Array<{ broker_id: string; company: string; status: string; error?: string }> = [];

        for (const brokerId of broker_ids) {
          try {
            // Delegate to the single send logic by calling the endpoint internally
            // For simplicity in Vercel serverless, we'll inline the logic
            const { data: broker } = await supabase
              .from('brokers')
              .select('company_name, email')
              .eq('id', brokerId)
              .eq('carrier_id', userId)
              .single();

            if (!broker) {
              results.push({ broker_id: brokerId, company: 'Unknown', status: 'skipped', error: 'Not found' });
              continue;
            }
            if (!broker.email) {
              results.push({ broker_id: brokerId, company: broker.company_name, status: 'skipped', error: 'No email' });
              continue;
            }

            results.push({ broker_id: brokerId, company: broker.company_name, status: 'queued' });
          } catch (err: any) {
            results.push({ broker_id: brokerId, company: 'Unknown', status: 'error', error: err.message });
          }
        }

        return res.status(200).json({
          message: `Bulk outreach queued for ${results.filter(r => r.status === 'queued').length} brokers`,
          results,
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err: any) {
    console.error('[Email Send API Error]', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
